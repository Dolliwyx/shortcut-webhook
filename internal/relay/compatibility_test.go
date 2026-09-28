package relay

import (
	"math"
	"strings"
	"testing"
)

func TestFormattingCompatibility(t *testing.T) {
	for _, tc := range []struct {
		value float64
		want  string
	}{
		{1e-7, "1e-7"}, {1e-6, "0.000001"}, {1e20, "100000000000000000000"}, {1e21, "1e+21"}, {math.Copysign(0, -1), "0"},
	} {
		e := event([]any{story(42, "update", map[string]any{"changes": map[string]any{"estimate": scalar(nil, tc.value)}})})
		e["owner_ids"] = []any{member}
		r := ProcessEvent(e, opts())
		if r.Payload == nil || !strings.Contains(r.Payload.Content, "Updated estimate: **"+tc.want+"**") {
			t.Errorf("value %v: %+v", tc.value, r.Payload)
		}
	}
	e := event([]any{story(42, "create", map[string]any{
		"name": "\ufeff Hello\u0085world\u2028 ", "description": "\ufeffDetails", "owner_ids": []any{member},
	})})
	o := opts()
	o.WorkspaceSlug = "team!':+*()"
	r := ProcessEvent(e, o)
	want := "### [Hello\u0085world](https://app.shortcut.com/team!'%3A%2B*%28%29/story/42)"
	if r.Payload == nil || !strings.Contains(r.Payload.Content, want) || !strings.Contains(r.Payload.Content, "\n\nDetails\n\n") {
		t.Fatalf("whitespace or URL escaping changed: %+v", r.Payload)
	}
}

func TestValidationPrecedesSelfSuppression(t *testing.T) {
	e := event([]any{})
	e["member_id"] = member
	e["references"] = nil
	if r := ProcessEvent(e, opts()); r.Outcome != "invalid" {
		t.Fatalf("outcome=%s", r.Outcome)
	}
}

func TestMultiStoryOwnershipAndIgnoredChanges(t *testing.T) {
	for _, tc := range []struct {
		name    string
		actions []any
		outcome string
	}{
		{"ambiguous aggregate", []any{story(1, "update", map[string]any{"changes": map[string]any{"estimate": scalar(nil, float64(2))}}), story(2, "update", map[string]any{"changes": map[string]any{"estimate": scalar(nil, float64(3))}})}, "ignored"},
		{"deletion excluded", []any{story(1, "delete", nil), story(2, "update", map[string]any{"changes": map[string]any{"estimate": scalar(nil, float64(3))}})}, "deliver"},
		{"labels only", []any{story(1, "update", map[string]any{"changes": map[string]any{"labels": scalar("a", "b")}})}, "ignored"},
		{"identical scalar", []any{story(1, "update", map[string]any{"changes": map[string]any{"estimate": scalar(float64(3), float64(3))}})}, "ignored"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			e := event(tc.actions)
			e["owner_ids"] = []any{member}
			if r := ProcessEvent(e, opts()); r.Outcome != tc.outcome {
				t.Fatalf("outcome=%s want=%s", r.Outcome, tc.outcome)
			}
		})
	}
}

func TestTimestampFallback(t *testing.T) {
	for _, changedAt := range []string{"invalid", "1700000000000"} {
		e := event([]any{story(1, "create", map[string]any{"owner_ids": []any{member}})})
		e["changed_at"] = changedAt
		r := ProcessEvent(e, opts())
		if r.Outcome != "deliver" || strings.Contains(r.Payload.Content, "<t:") {
			t.Fatalf("unexpected timestamp: %+v", r.Payload)
		}
	}
}
