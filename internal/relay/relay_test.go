package relay

import (
	"encoding/json"
	"strings"
	"testing"
	"unicode/utf16"
)

const member = "target-member"

func opts() Options {
	return Options{ShortcutMemberID: member, WorkspaceSlug: "team(test)", DiscordUserID: "123456", AuthorNames: map[string]string{}}
}
func event(actions []any) map[string]any {
	return map[string]any{"id": "event-1", "changed_at": "2025-01-02T03:04:05Z", "member_id": "other", "version": "v1", "actions": actions}
}
func story(id float64, op string, fields map[string]any) map[string]any {
	a := map[string]any{"id": id, "entity_type": "story", "action": op}
	for k, v := range fields {
		a[k] = v
	}
	return a
}
func scalar(old, new any) map[string]any { return map[string]any{"old": old, "new": new} }
func TestValidationDiagnosticsAndPresence(t *testing.T) {
	for _, tc := range []struct {
		name         string
		mutate       func(map[string]any)
		path, actual string
	}{
		{"missing id", func(e map[string]any) { delete(e, "id") }, "$.id", "undefined"},
		{"null id", func(e map[string]any) { e["id"] = nil }, "$.id", "null"},
		{"case sensitive field", func(e map[string]any) { delete(e, "member_id"); e["Member_id"] = "other" }, "$.member_id", "undefined"},
		{"unsafe integer", func(e map[string]any) { e["actions"] = []any{story(9007199254740992, "update", nil)} }, "$.actions[0].id", "number"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			e := event([]any{})
			tc.mutate(e)
			var issues []ValidationIssue
			r := ProcessEvent(e, Options{ShortcutMemberID: member, WorkspaceSlug: "x", DiscordUserID: "1", OnInvalid: func(i ValidationIssue) { issues = append(issues, i) }})
			if r.Outcome != "invalid" || len(issues) != 1 || issues[0].Path != tc.path || issues[0].Actual != tc.actual {
				t.Fatalf("result=%+v issues=%+v", r, issues)
			}
			if r.StoryIDs == nil || r.ActionTypes == nil {
				t.Fatalf("empty arrays must be initialized: %+v", r)
			}
		})
	}
	valid := event([]any{})
	r := ProcessEvent(valid, opts())
	if r.Outcome != "ignored" {
		t.Fatalf("omitted optional references: %+v", r)
	}
	valid["references"] = nil
	r = ProcessEvent(valid, opts())
	if r.Outcome != "invalid" {
		t.Fatalf("explicit null references: %+v", r)
	}
}
func TestGroupingFilteringAndMetadata(t *testing.T) {
	e := event([]any{story(2, "update", map[string]any{"changes": map[string]any{"owner_ids": map[string]any{"adds": []any{member}}, "workflow_state_id": scalar(float64(1), float64(2))}}), story(1, "create", map[string]any{"owner_ids": []any{member}, "name": "Created"})})
	r := ProcessEvent(e, opts())
	if r.Outcome != "deliver" || len(r.StoryIDs) != 2 || r.StoryIDs[0] != 2 || r.StoryIDs[1] != 1 {
		t.Fatalf("unexpected result: %+v", r)
	}
	metadata := r
	metadata.Payload = nil
	if strings.Contains(mustJSON(t, metadata), "Created") || strings.Contains(mustJSON(t, metadata), "workflow") {
		t.Fatal("private display data leaked into metadata")
	}
	if r.Payload == nil || !strings.Contains(r.Payload.Content, "team%28test%29/story/1") || r.Payload.AllowedMentions.Users[0] != "123456" {
		t.Fatalf("payload: %+v", r.Payload)
	}
}
func TestAmbiguousCommentAssociationAndReferenceConflict(t *testing.T) {
	e := event([]any{map[string]any{"id": float64(9), "entity_type": "story-comment", "action": "create", "text": "secret"}, story(2, "update", map[string]any{"changes": map[string]any{"comment_ids": map[string]any{"adds": []any{float64(9)}}, "owner_ids": map[string]any{"adds": []any{member}}}}), story(3, "update", map[string]any{"changes": map[string]any{"comment_ids": map[string]any{"adds": []any{float64(9)}}}})})
	r := ProcessEvent(e, opts())
	if r.Outcome != "deliver" || strings.Contains(r.Payload.Content, "secret") {
		t.Fatalf("ambiguous association used: %+v", r)
	}
	ref := event([]any{story(2, "update", map[string]any{"changes": map[string]any{"owner_ids": map[string]any{"adds": []any{member}}, "workflow_state_id": scalar(float64(1), float64(8))}})})
	ref["references"] = []any{map[string]any{"id": float64(8), "entity_type": "workflow-state", "name": "Ready"}, map[string]any{"id": float64(8), "entity_type": "workflow-state", "name": "Other"}}
	r = ProcessEvent(ref, opts())
	if !strings.Contains(r.Payload.Content, "**8**") {
		t.Fatalf("conflicting reference should fall back to id: %s", r.Payload.Content)
	}
}
func TestUTF16ClippingAndEscaping(t *testing.T) {
	// The title limit is 256 UTF-16 units; never emit half of a surrogate pair.
	title := strings.Repeat("a", 255) + "😀z"
	e := event([]any{story(4, "create", map[string]any{"owner_ids": []any{member}, "name": title, "description": "@everyone https://example.com <@987> [@Evil](shortcutapp://members/id) " + strings.Repeat("😀", 1100)})})
	r := ProcessEvent(e, opts())
	u := len(utf16Units(r.Payload.Content))
	if u > 2000 {
		t.Fatalf("message is %d UTF-16 units", u)
	}
	if !strings.Contains(r.Payload.Content, strings.Repeat("a", 255)+"…") || !strings.Contains(r.Payload.Content, "@\u200beveryone") || strings.Contains(r.Payload.Content, "<@987>") {
		t.Fatalf("unsafe or malformed content: %s", r.Payload.Content)
	}
	comment := event([]any{map[string]any{"id": float64(9), "entity_type": "comment", "action": "create", "story_id": float64(4), "changes": map[string]any{"text": map[string]any{"new": strings.Repeat("😀", 101)}}}})
	comment["owner_ids"] = []any{member}
	r = ProcessEvent(comment, opts())
	if !strings.Contains(r.Payload.Content, strings.Repeat("😀", 99)+"…") {
		t.Fatalf("200 UTF-16 unit excerpt boundary failed: %s", r.Payload.Content)
	}
}
func TestResultJSONContract(t *testing.T) {
	r := ProcessEvent(nil, opts())
	b, err := json.Marshal(r)
	if err != nil {
		t.Fatal(err)
	}
	if string(b) != `{"outcome":"invalid","storyIds":[],"actionTypes":[]}` {
		t.Fatalf("unexpected JSON: %s", b)
	}
}
func mustJSON(t *testing.T, v any) string {
	t.Helper()
	b, e := json.Marshal(v)
	if e != nil {
		t.Fatal(e)
	}
	return string(b)
}
func utf16Units(s string) []uint16 { return utf16.Encode([]rune(s)) }
