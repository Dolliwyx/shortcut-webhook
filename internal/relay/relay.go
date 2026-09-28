package relay

import (
	"encoding/json"
	"fmt"
	"math"
	"net/url"
	"regexp"
	"sort"
	"strings"
	"time"
	"unicode"
	"unicode/utf16"
)

type Options struct {
	ShortcutMemberID string
	WorkspaceSlug    string
	DiscordUserID    string
	AuthorNames      map[string]string
	OnInvalid        func(ValidationIssue)
}
type ValidationIssue struct {
	Path     string `json:"path"`
	Expected string `json:"expected"`
	Actual   string `json:"actual"`
}
type Result struct {
	Outcome          string          `json:"outcome"`
	Payload          *DiscordPayload `json:"payload,omitempty"`
	EventID          string          `json:"eventId,omitempty"`
	StoryIDs         []int64         `json:"storyIds"`
	ActionTypes      []string        `json:"actionTypes"`
	CommentAuthorIDs []string        `json:"commentAuthorIds,omitempty"`
	CreatorIDs       []string        `json:"creatorIds,omitempty"`
}
type DiscordPayload struct {
	Content         string          `json:"content"`
	AllowedMentions AllowedMentions `json:"allowed_mentions"`
}
type AllowedMentions struct {
	Users []string `json:"users"`
}

type record = map[string]any

type envelope struct {
	id         string
	references map[int64]*string
}
type actionRecord struct {
	action            record
	index             int
	entity, operation string
}
type group struct {
	id        int64
	records   []actionRecord
	summaries []summary
	first     int
	title     *string
}
type summary struct {
	index      int
	kind, text string
}

func ProcessEvent(event any, options Options) Result {
	env, ok := validateEnvelope(event, options.OnInvalid)
	if !ok {
		return empty("invalid", "", false)
	}
	e, _ := event.(record)
	if !nonempty(options.ShortcutMemberID) || !nonempty(options.WorkspaceSlug) || !decimalID.MatchString(options.DiscordUserID) {
		return empty("invalid", env.id, true)
	}
	if e["member_id"] == options.ShortcutMemberID {
		return empty("ignored", env.id, true)
	}
	acts := e["actions"].([]any)
	commentStories := map[int64]*int64{}
	for _, av := range acts {
		a := av.(record)
		if a["entity_type"] != "story" || a["action"] != "update" {
			continue
		}
		change := nestedRecord(a["changes"], "comment_ids")
		adds, ok := change["adds"].([]any)
		if !ok {
			continue
		}
		ids := make([]int64, 0, len(adds))
		valid := true
		for _, v := range adds {
			n, ok := numericID(v)
			if !ok {
				valid = false
				break
			}
			ids = append(ids, n)
		}
		if !valid {
			continue
		}
		for _, id := range ids {
			if p, exists := commentStories[id]; exists {
				if p == nil || *p != mustID(a["id"]) {
					commentStories[id] = nil
				}
			} else {
				n := mustID(a["id"])
				commentStories[id] = &n
			}
		}
	}
	groups := map[int64]*group{}
	order := []int64{}
	resolved := map[int64]bool{}
	add := func(id int64, ar actionRecord) {
		if groups[id] == nil {
			groups[id] = &group{id: id}
			order = append(order, id)
		}
		groups[id].records = append(groups[id].records, ar)
		resolved[id] = true
	}
	for i, av := range acts {
		a := av.(record)
		entity, _ := a["entity_type"].(string)
		op, _ := a["action"].(string)
		if entity == "story" {
			if op == "create" || op == "update" {
				add(mustID(a["id"]), actionRecord{a, i, "story", op})
			}
			continue
		}
		var sid int64
		valid := false
		if entity == "comment" && (op == "create" || op == "update") {
			sid, valid = numericID(a["story_id"])
		} else if entity == "story-comment" && op == "create" {
			if p, ok := commentStories[mustID(a["id"])]; ok && p != nil {
				sid = *p
				valid = true
			}
		}
		if valid {
			if direct, has := a["story_id"]; has {
				d, ok := numericID(direct)
				if !ok || d != sid {
					continue
				}
			}
			add(sid, actionRecord{a, i, "comment", op})
		}
	}
	aggregate := false
	if len(resolved) == 1 {
		aggregate = ownerIncludes(e["owner_ids"], options.ShortcutMemberID)
	}
	eligible := []*group{}
	for _, id := range order {
		g := groups[id]
		ownedCreate, added, removed := false, false, false
		for _, ar := range g.records {
			a := ar.action
			if ar.entity == "comment" {
				excerpt := commentExcerpt(a)
				author := ""
				if name := options.AuthorNames[stringValue(a["author_id"])]; nonempty(name) {
					author = "**" + format("@"+clipEllipsis(normalize(name), 80), false) + "**"
				}
				label := "Comment added"
				if ar.operation == "update" {
					label = "Comment updated"
				}
				if author != "" {
					if ar.operation == "create" {
						label = author + " commented"
					} else {
						label = "Comment by " + author + " updated"
					}
				}
				if excerpt != nil {
					label += "\n> " + *excerpt
				}
				g.summaries = append(g.summaries, summary{ar.index, "comment." + ar.operation, label})
				continue
			}
			if ar.operation == "create" {
				if ownerIncludes(a["owner_ids"], options.ShortcutMemberID) {
					ownedCreate = true
				}
				creator := "Shortcut member"
				if n := options.AuthorNames[stringValue(e["member_id"])]; nonempty(n) {
					creator = format("@"+clipEllipsis(normalize(n), 80), false)
				}
				text := "-# Created by: " + creator
				if nonempty(stringValue(a["description"])) {
					text += "\n\n" + format(trimText(stringValue(a["description"])), true)
				}
				g.summaries = append(g.summaries, summary{ar.index, "story.create", text})
				continue
			}
			if c, ok := ownerChange(a["changes"]); ok {
				if contains(c.adds, options.ShortcutMemberID) {
					added = true
					g.summaries = append(g.summaries, summary{ar.index, "story.update", "Updated owners: **You were added as an owner**"})
				}
				if contains(c.removes, options.ShortcutMemberID) {
					removed = true
					g.summaries = append(g.summaries, summary{ar.index, "story.update", "Updated owners: **You were removed as an owner**"})
				}
			}
			for _, f := range []struct{ key, label, fallback string }{{"workflow_state_id", "workflow", "No workflow state"}, {"deadline", "deadline", "No deadline"}, {"estimate", "estimate", "No estimate"}, {"name", "title", "No title"}, {"description", "description", "No description"}, {"story_type", "type", "No type"}} {
				if c, ok := scalarChange(a["changes"], f.key); ok {
					v := display(c["new"], f.fallback)
					if f.key == "workflow_state_id" {
						if id, ok := numericID(c["new"]); ok && env.references[id] != nil {
							v = format(*env.references[id], true)
						}
					}
					g.summaries = append(g.summaries, summary{ar.index, "story.update", "Updated " + f.label + ": **" + v + "**"})
				}
			}
		}
		if !(aggregate || ownedCreate || added || removed) || len(g.summaries) == 0 {
			continue
		}
		g.first = g.summaries[0].index
		for _, s := range g.summaries {
			if s.index < g.first {
				g.first = s.index
			}
		}
		g.title = storyTitle(g)
		eligible = append(eligible, g)
	}
	sort.SliceStable(eligible, func(i, j int) bool { return eligible[i].first < eligible[j].first })
	if len(eligible) == 0 {
		return empty("ignored", env.id, true)
	}
	result := empty("deliver", env.id, true)
	result.Payload = &DiscordPayload{discordContent(stringValue(e["changed_at"]), eligible, options), AllowedMentions{[]string{options.DiscordUserID}}}
	seenTypes := map[string]bool{}
	authors := map[string]bool{}
	creators := false
	allSummaries := []summary{}
	for _, g := range eligible {
		result.StoryIDs = append(result.StoryIDs, g.id)
		allSummaries = append(allSummaries, g.summaries...)
		for _, ar := range g.records {
			if ar.entity == "comment" {
				if id, ok := aString(ar.action["author_id"]); ok && !authors[id] {
					authors[id] = true
					result.CommentAuthorIDs = append(result.CommentAuthorIDs, id)
				}
			}
			if ar.entity == "story" && ar.operation == "create" {
				creators = true
			}
		}
	}
	sort.SliceStable(allSummaries, func(i, j int) bool { return allSummaries[i].index < allSummaries[j].index })
	for _, s := range allSummaries {
		if !seenTypes[s.kind] {
			seenTypes[s.kind] = true
			result.ActionTypes = append(result.ActionTypes, s.kind)
		}
	}
	if creators {
		result.CreatorIDs = []string{stringValue(e["member_id"])}
	}
	return result
}

func validateEnvelope(value any, cb func(ValidationIssue)) (envelope, bool) {
	fail := func(path, expected string, v any, present bool) (envelope, bool) {
		actual := "undefined"
		if present {
			actual = typeName(v)
		}
		if cb != nil {
			cb(ValidationIssue{path, expected, actual})
		}
		return envelope{}, false
	}
	e, ok := asRecord(value)
	if !ok {
		return fail("$", "object", value, true)
	}
	for _, k := range []string{"id", "changed_at", "member_id"} {
		v, p := e[k]
		if !p || !nonempty(stringValue(v)) || !isString(v) {
			return fail("$."+k, "nonempty string", v, p)
		}
	}
	if e["version"] != "v1" {
		v, p := e["version"]
		return fail("$.version", "v1", v, p)
	}
	acts, ok := e["actions"].([]any)
	if !ok {
		return fail("$.actions", "array", e["actions"], has(e, "actions"))
	}
	for i, v := range acts {
		path := fmt.Sprintf("$.actions[%d]", i)
		a, ok := asRecord(v)
		if !ok {
			return fail(path, "object", v, true)
		}
		if _, ok := numericID(a["id"]); !ok {
			return fail(path+".id", "positive safe integer", a["id"], has(a, "id"))
		}
		for _, k := range []string{"entity_type", "action"} {
			v, p := a[k]
			if !p || !isString(v) || !nonempty(v.(string)) {
				return fail(path+"."+k, "nonempty string", v, p)
			}
		}
		if v, p := a["name"]; p && !isString(v) {
			return fail(path+".name", "string", v, true)
		}
		if v, p := a["changes"]; p && !isRecordValue(v) {
			return fail(path+".changes", "object", v, true)
		}
		if v, p := a["owner_ids"]; p && !isOwnerList(v) {
			return fail(path+".owner_ids", "array of nonempty strings", v, true)
		}
		if v, p := a["story_id"]; p {
			if _, ok := numericID(v); !ok {
				return fail(path+".story_id", "positive safe integer", v, true)
			}
		}
	}
	if v, p := e["owner_ids"]; p && !isOwnerList(v) {
		return fail("$.owner_ids", "array of nonempty strings", v, true)
	}
	refs := []any{}
	if v, p := e["references"]; p {
		var ok bool
		refs, ok = v.([]any)
		if !ok {
			return fail("$.references", "array", v, true)
		}
	}
	refNames := map[int64]*string{}
	for i, v := range refs {
		path := fmt.Sprintf("$.references[%d]", i)
		r, ok := asRecord(v)
		if !ok {
			return fail(path, "object", v, true)
		}
		id, ok := numericID(r["id"])
		if !ok {
			return fail(path+".id", "positive safe integer", r["id"], has(r, "id"))
		}
		v, p := r["entity_type"]
		if !p || !isString(v) || !nonempty(v.(string)) {
			return fail(path+".entity_type", "nonempty string", v, p)
		}
		if n, p := r["name"]; p && (!isString(n) || !nonempty(n.(string))) {
			return fail(path+".name", "nonempty string", n, true)
		}
		if r["entity_type"] == "workflow-state" {
			name, ok := r["name"].(string)
			if ok {
				n := normalize(name)
				if old, exists := refNames[id]; !exists {
					refNames[id] = &n
				} else if old == nil || *old != n {
					refNames[id] = nil
				}
			}
		}
	}
	return envelope{stringValue(e["id"]), refNames}, true
}
func empty(out, id string, hasID bool) Result {
	r := Result{Outcome: out, StoryIDs: []int64{}, ActionTypes: []string{}}
	if hasID {
		r.EventID = id
	}
	return r
}
func asRecord(v any) (record, bool)       { r, ok := v.(map[string]any); return r, ok && r != nil }
func nestedRecord(v any, k string) record { r, _ := asRecord(v); n, _ := asRecord(r[k]); return n }
func isRecordValue(v any) bool            { _, ok := asRecord(v); return ok }
func has(r record, k string) bool         { _, ok := r[k]; return ok }
func typeName(v any) string {
	switch v.(type) {
	case nil:
		return "null"
	case map[string]any:
		return "object"
	case []any:
		return "array"
	case string:
		return "string"
	case bool:
		return "boolean"
	case float64, int, int64:
		return "number"
	}
	return "object"
}
func isString(v any) bool          { _, ok := v.(string); return ok }
func nonempty(s string) bool       { return trimText(s) != "" }
func stringValue(v any) string     { s, _ := v.(string); return s }
func aString(v any) (string, bool) { s, ok := v.(string); return s, ok }
func numericID(v any) (int64, bool) {
	f, ok := v.(float64)
	if !ok || math.IsNaN(f) || math.IsInf(f, 0) || f <= 0 || math.Trunc(f) != f || f > 9007199254740991 {
		return 0, false
	}
	return int64(f), true
}
func mustID(v any) int64 { n, _ := numericID(v); return n }
func isOwnerList(v any) bool {
	a, ok := v.([]any)
	if !ok {
		return false
	}
	for _, x := range a {
		s, ok := x.(string)
		if !ok || !nonempty(s) {
			return false
		}
	}
	return true
}
func ownerIncludes(v any, s string) bool {
	a, ok := v.([]any)
	if !ok {
		return false
	}
	for _, x := range a {
		if x == s {
			return true
		}
	}
	return false
}
func contains(a []string, s string) bool {
	for _, v := range a {
		if v == s {
			return true
		}
	}
	return false
}
func ownerChange(v any) (struct{ adds, removes []string }, bool) {
	c := nestedRecord(v, "owner_ids")
	if c == nil || (!has(c, "adds") && !has(c, "removes")) {
		return struct{ adds, removes []string }{}, false
	}
	out := struct{ adds, removes []string }{}
	for k, d := range map[string]*[]string{"adds": &out.adds, "removes": &out.removes} {
		if v, p := c[k]; p {
			a, ok := v.([]any)
			if !ok {
				return out, false
			}
			for _, x := range a {
				s, ok := x.(string)
				if !ok || !nonempty(s) {
					return out, false
				}
				*d = append(*d, s)
			}
		}
	}
	return out, true
}
func scalarChange(v any, k string) (record, bool) {
	c := nestedRecord(v, k)
	if c == nil || !has(c, "old") || !has(c, "new") || !displayScalar(c["old"]) || !displayScalar(c["new"]) || sameScalar(c["old"], c["new"]) {
		return nil, false
	}
	return c, true
}
func displayScalar(v any) bool {
	if v == nil {
		return true
	}
	switch value := v.(type) {
	case string, bool:
		return true
	case float64:
		return !math.IsNaN(value) && !math.IsInf(value, 0)
	}
	return false
}
func sameScalar(a, b any) bool {
	switch x := a.(type) {
	case nil:
		return b == nil
	case string:
		y, ok := b.(string)
		return ok && x == y
	case bool:
		y, ok := b.(bool)
		return ok && x == y
	case float64:
		y, ok := b.(float64)
		return ok && x == y && math.Signbit(x) == math.Signbit(y)
	}
	return false
}

// ECMAScript whitespace differs from Unicode White_Space at U+0085 and U+FEFF.
func textSpace(r rune) bool     { return r == '\ufeff' || (r != '\u0085' && unicode.IsSpace(r)) }
func trimText(s string) string  { return strings.TrimFunc(s, textSpace) }
func normalize(s string) string { return strings.Join(strings.FieldsFunc(s, textSpace), " ") }
func clipUnits(s string, n int) string {
	u := utf16.Encode([]rune(s))
	if len(u) > n {
		u = u[:n]
		if len(u) > 0 && u[len(u)-1] >= 0xd800 && u[len(u)-1] <= 0xdbff {
			u = u[:len(u)-1]
		}
	}
	return string(utf16.Decode(u))
}
func clipEllipsis(s string, n int) string {
	if len(utf16.Encode([]rune(s))) <= n {
		return s
	}
	if n <= 1 {
		return "…"
	}
	return clipUnits(s, n-1) + "…"
}

var (
	decimalID           = regexp.MustCompile(`^\d+$`)
	memberMarkup        = regexp.MustCompile(`(?i)\[@([^\]]+)\]\(shortcutapp://members/[^)\t\n\v\f\r \x{00a0}\x{1680}\x{2000}-\x{200a}\x{2028}\x{2029}\x{202f}\x{205f}\x{3000}\x{feff}]+\)`)
	httpLink            = regexp.MustCompile(`(?i)\b(https?)://`)
	wwwLink             = regexp.MustCompile(`(?i)\bwww\.`)
	broadcastMention    = regexp.MustCompile(`(?i)@(everyone|here)\b`)
	discordMention      = regexp.MustCompile(`<([@#])`)
	markdownPunctuation = regexp.MustCompile("([*_~|`<>#\\[\\]\\(\\)])")
)

func format(s string, bold bool) string {
	matches := memberMarkup.FindAllStringSubmatchIndex(s, -1)
	var b strings.Builder
	at := 0
	for _, m := range matches {
		b.WriteString(escape(s[at:m[0]]))
		n := escape(s[m[2]:m[3]])
		if bold {
			b.WriteString("**@" + n + "**")
		} else {
			b.WriteString("@" + n)
		}
		at = m[1]
	}
	b.WriteString(escape(s[at:]))
	return b.String()
}
func escape(s string) string {
	s = httpLink.ReplaceAllString(s, "$1:\u200b//")
	s = wwwLink.ReplaceAllString(s, "www.\u200b.")
	s = broadcastMention.ReplaceAllString(s, "@\u200b$1")
	s = discordMention.ReplaceAllString(s, "<\u200b$1")
	s = strings.ReplaceAll(s, "\\", "\\\\")
	return markdownPunctuation.ReplaceAllString(s, `\$1`)
}
func commentExcerpt(a record) *string {
	var v any
	if a["entity_type"] == "story-comment" {
		v = a["text"]
	} else {
		v = nestedRecord(a["changes"], "text")["new"]
	}
	s, ok := v.(string)
	if !ok {
		return nil
	}
	s = normalize(s)
	if s == "" {
		return nil
	}
	if len(utf16.Encode([]rune(s))) > 200 {
		s = clipUnits(s, 199) + "…"
	}
	s = format(s, true)
	return &s
}
func display(v any, fallback string) string {
	if v == nil {
		return fallback
	}
	if s, ok := v.(string); ok {
		s = normalize(s)
		if s == "" {
			return fallback
		}
		return format(s, true)
	}
	if n, ok := v.(float64); ok {
		if n == 0 {
			return "0"
		}
		// encoding/json uses ECMAScript's decimal/exponent thresholds.
		encoded, _ := json.Marshal(n)
		return string(encoded)
	}
	return fmt.Sprint(v)
}
func storyTitle(g *group) *string {
	for i := len(g.records) - 1; i >= 0; i-- {
		ar := g.records[i]
		if ar.entity != "story" {
			continue
		}
		title := stringValue(ar.action["name"])
		if c, ok := scalarChange(ar.action["changes"], "name"); ok {
			if s, ok := c["new"].(string); ok {
				title = s
			}
		}
		title = normalize(title)
		if title != "" {
			return &title
		}
	}
	return nil
}
func summaryText(g *group) string {
	sep := "\n"
	for _, s := range g.summaries {
		if strings.HasPrefix(s.kind, "comment.") {
			sep = "\n\n"
			break
		}
	}
	a := []string{}
	for _, s := range g.summaries {
		a = append(a, s.text)
	}
	return strings.Join(a, sep)
}
func storyURL(slug string, id int64) string {
	// Match encodeURIComponent, with parentheses escaped for Markdown links.
	u := strings.NewReplacer("+", "%20", "%21", "!", "%27", "'", "%2A", "*").Replace(url.QueryEscape(slug))
	return fmt.Sprintf("https://app.shortcut.com/%s/story/%d", u, id)
}
func header(g *group, slug string) string {
	title := fmt.Sprintf("Story #%d", g.id)
	if g.title != nil {
		title = clipEllipsis(*g.title, 256)
	}
	label := format(title, true)
	u := storyURL(slug, g.id)
	if len(u) <= 1000 {
		return "### [" + label + "](" + u + ")"
	}
	return "### " + label + " (Shortcut link omitted: workspace URL exceeds message limit)"
}
func block(g *group, slug string) string { return header(g, slug) + "\n\n" + summaryText(g) }
func omission(stories int, changes bool) string {
	d := []string{}
	if changes {
		d = append(d, "additional changes omitted")
	}
	if stories > 0 {
		w := "stories"
		if stories == 1 {
			w = "story"
		}
		d = append(d, fmt.Sprintf("%d more %s omitted", stories, w))
	}
	return "\n… " + strings.Join(d, "; ")
}
func discordContent(changed string, groups []*group, o Options) string {
	prefix := "<@" + o.DiscordUserID + ">"
	suffix := ""
	if t, ok := parseDate(changed); ok {
		suffix = fmt.Sprintf("\n\n<t:%d:F>", t.Unix())
	}
	blocks := make([]string, len(groups))
	for i, g := range groups {
		blocks[i] = block(g, o.WorkspaceSlug)
	}
	complete := prefix + "\n" + strings.Join(blocks, "\n\n") + suffix
	if len(utf16.Encode([]rune(complete))) <= 2000 {
		return complete
	}
	content := prefix
	for i, g := range groups {
		sep := "\n"
		if i > 0 {
			sep = "\n\n"
		}
		candidate := content + sep + blocks[i]
		omitted := len(groups) - i - 1
		reserved := units(suffix)
		if omitted > 0 {
			reserved += units(omission(omitted, false)) + 2
		}
		if units(candidate)+reserved <= 2000 {
			content = candidate
			continue
		}
		h := header(g, o.WorkspaceSlug)
		marker := omission(omitted, true)
		start := content + sep + h + "\n\n"
		avail := 2000 - units(start) - units(marker) - units(suffix)
		if avail >= 0 {
			return start + clipUnits(summaryText(g), avail) + marker + suffix
		}
		return content + sep + omission(omitted+1, false) + suffix
	}
	return content + suffix
}
func units(s string) int { return len(utf16.Encode([]rune(s))) }
func parseDate(s string) (time.Time, bool) {
	if t, e := time.Parse(time.RFC3339Nano, s); e == nil {
		return t, true
	}
	for _, layout := range []string{"2006-01-02", "2006-01", "2006", "2006-01-02 15:04:05Z07:00", "2006-01-02 15:04:05", "Mon, 02 Jan 2006 15:04:05 MST"} {
		if t, e := time.Parse(layout, s); e == nil {
			return t, true
		}
	}
	return time.Time{}, false
}
