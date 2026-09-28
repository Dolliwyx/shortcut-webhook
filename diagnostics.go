package main

import (
	"fmt"
	"sort"
	"strconv"
)

type eventShapeResult struct {
	Fields    []map[string]any `json:"fields"`
	Truncated bool             `json:"truncated"`
}

var safeDiagnosticKeys = map[string]bool{}
var diagnosticLabels = map[string]map[string]bool{
	"entity_type": setOf("story", "story-comment", "comment", "epic", "epic-comment", "task", "label", "workflow-state"),
	"action":      setOf("create", "update", "delete"),
}

func init() {
	for _, key := range []string{"id", "changed_at", "member_id", "owner_ids", "version", "primary_id", "actions", "references", "entity_type", "action", "name", "changes", "story_id", "story", "comment_id", "comment_ids", "comment", "comments", "text", "description", "task_ids", "label_ids", "follower_ids", "mention_ids", "mentioned_member_ids", "story_type", "workflow_state_id", "deadline", "estimate", "old", "new", "adds", "removes", "created_at", "updated_at", "author_id", "app_url", "url"} {
		safeDiagnosticKeys[key] = true
	}
}
func setOf(values ...string) map[string]bool {
	s := map[string]bool{}
	for _, v := range values {
		s[v] = true
	}
	return s
}

func eventShape(event any) eventShapeResult {
	result := eventShapeResult{Fields: []map[string]any{}}
	numbers := map[float64]string{}
	var visit func(any, string, int, string)
	visit = func(value any, path string, depth int, fieldName string) {
		if len(result.Fields) >= 200 {
			result.Truncated = true
			return
		}
		typ := "null"
		switch value.(type) {
		case map[string]any:
			typ = "object"
		case []any:
			typ = "array"
		case string:
			typ = "string"
		case bool:
			typ = "boolean"
		case float64:
			typ = "number"
		}
		field := map[string]any{"path": path, "type": typ}
		if labels, ok := diagnosticLabels[fieldName]; ok && typ == "string" {
			if labels[value.(string)] {
				field["knownValue"] = value
			} else {
				field["knownValue"] = "unrecognized"
			}
		}
		if typ == "number" {
			key := value.(float64)
			if first, ok := numbers[key]; ok {
				field["sameNumberAs"] = first
			} else {
				numbers[key] = path
			}
		}
		result.Fields = append(result.Fields, field)
		if value == nil {
			return
		}
		if depth >= 8 {
			switch x := value.(type) {
			case map[string]any:
				if len(x) > 0 {
					result.Truncated = true
				}
			case []any:
				if len(x) > 0 {
					result.Truncated = true
				}
			}
			return
		}
		switch x := value.(type) {
		case []any:
			limit := len(x)
			if limit > 10 {
				limit = 10
				result.Truncated = true
			}
			for i := 0; i < limit; i++ {
				if len(result.Fields) >= 200 {
					result.Truncated = true
					break
				}
				visit(x[i], path+"["+strconv.Itoa(i)+"]", depth+1, "")
			}
		case map[string]any:
			keys := make([]string, 0, len(x))
			for k := range x {
				keys = append(keys, k)
			}
			sort.Strings(keys)
			for i, k := range keys {
				if len(result.Fields) >= 200 {
					result.Truncated = true
					break
				}
				segment := fmt.Sprintf("[redacted-key-%d]", i)
				if safeDiagnosticKeys[k] {
					segment = "." + k
				}
				visit(x[k], path+segment, depth+1, k)
			}
		}
	}
	visit(event, "$", 0, "")
	return result
}
