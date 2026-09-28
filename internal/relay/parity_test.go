package relay

import (
	"encoding/json"
	"os"
	"os/exec"
	"reflect"
	"slices"
	"testing"
	"unicode/utf16"
)

func TestSharedFixtures(t *testing.T) {
	data, err := os.ReadFile("../../test/fixtures/parity-cases.json")
	if err != nil {
		t.Fatal(err)
	}
	var cases []struct {
		Name            string
		Event           any
		ExpectedOutcome string
	}
	if err := json.Unmarshal(data, &cases); err != nil {
		t.Fatal(err)
	}
	for _, tc := range cases {
		t.Run(tc.Name, func(t *testing.T) {
			result := ProcessEvent(tc.Event, Options{
				ShortcutMemberID: "11111111-1111-4111-8111-111111111111",
				WorkspaceSlug:    "synthetic-workspace",
				DiscordUserID:    "123456789012345678",
			})
			if result.Outcome != tc.ExpectedOutcome {
				t.Fatalf("outcome = %q, want %q", result.Outcome, tc.ExpectedOutcome)
			}
			if result.Payload != nil && len(utf16.Encode([]rune(result.Payload.Content))) > 2000 {
				t.Fatal("Discord content exceeds UTF-16 length limit")
			}
		})
	}
}

// The production relay and normal tests need no Node runtime. Opt in to compare
// against the frozen JavaScript implementation while maintaining this port.
func TestNodeParity(t *testing.T) {
	if os.Getenv("RELAY_NODE_PARITY") != "1" {
		t.Skip("set RELAY_NODE_PARITY=1 to run the Node migration oracle")
	}
	command := exec.Command("node", "../../test/node-parity.mjs")
	command.Env = append(os.Environ(), "TZ=UTC")
	data, err := command.Output()
	if err != nil {
		t.Fatalf("Node oracle: %v", err)
	}
	var cases []struct {
		Name     string
		Event    any
		Options  Options
		Expected Result
		Issue    *ValidationIssue
	}
	if err := json.Unmarshal(data, &cases); err != nil {
		t.Fatal(err)
	}
	if len(cases) < 100 {
		t.Fatalf("expected substantial parity corpus, got %d cases", len(cases))
	}
	for _, tc := range cases {
		t.Run(tc.Name, func(t *testing.T) {
			var issue *ValidationIssue
			options := tc.Options
			options.OnInvalid = func(value ValidationIssue) { issue = &value }
			got := ProcessEvent(tc.Event, options)
			want := tc.Expected
			if got.Outcome != want.Outcome || got.EventID != want.EventID ||
				!reflect.DeepEqual(got.Payload, want.Payload) ||
				!slices.Equal(got.StoryIDs, want.StoryIDs) ||
				!slices.Equal(got.ActionTypes, want.ActionTypes) ||
				!slices.Equal(got.CommentAuthorIDs, want.CommentAuthorIDs) ||
				!slices.Equal(got.CreatorIDs, want.CreatorIDs) {
				gotJSON, _ := json.Marshal(got)
				wantJSON, _ := json.Marshal(want)
				t.Errorf("Go:   %s\nNode: %s", gotJSON, wantJSON)
			}
			if !reflect.DeepEqual(issue, tc.Issue) {
				t.Errorf("diagnostic = %+v, want %+v", issue, tc.Issue)
			}
		})
	}
}
