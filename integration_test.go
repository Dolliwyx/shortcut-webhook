package main

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"
	"time"
)

const otherMember = "22222222-2222-2222-2222-222222222222"

func eligibleBody(t *testing.T) []byte {
	t.Helper()
	body, err := json.Marshal(map[string]any{
		"id": "event-eligible", "changed_at": "2025-01-02T03:04:05.000Z",
		"member_id": otherMember, "version": "v1", "owner_ids": []string{testConfig().ShortcutMemberID},
		"actions": []any{map[string]any{"id": 42, "entity_type": "story", "action": "create", "name": "PRIVATE STORY TITLE"}},
	})
	if err != nil {
		t.Fatal(err)
	}
	return body
}

func invoke(h http.Handler, body []byte, sig string) *httptest.ResponseRecorder {
	r := httptest.NewRequest(http.MethodPost, "/shortcut", bytes.NewReader(body))
	if sig != "" {
		r.Header.Set("Payload-Signature", sig)
	}
	w := httptest.NewRecorder()
	h.ServeHTTP(w, r)
	return w
}

func TestSignedDeliveryOverHTTP(t *testing.T) {
	var mu sync.Mutex
	var calls int
	discord := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		mu.Lock()
		defer mu.Unlock()
		calls++
		if r.Method != "POST" || r.URL.Query().Get("wait") != "true" || r.Header.Get("Shortcut-Token") != "" {
			t.Errorf("unexpected upstream request: method=%s query=%s", r.Method, r.URL.RawQuery)
		}
		var payload struct {
			Content         string
			AllowedMentions struct{ Users []string } `json:"allowed_mentions"`
		}
		if err := json.NewDecoder(r.Body).Decode(&payload); err != nil {
			t.Error(err)
		}
		want := "<@123456789012345678>\n### [PRIVATE STORY TITLE](https://app.shortcut.com/workspace/story/42)\n\n-# Created by: Shortcut member\n\n<t:1735787045:F>"
		if payload.Content != want || len(payload.AllowedMentions.Users) != 1 || payload.AllowedMentions.Users[0] != testConfig().DiscordUserID {
			t.Errorf("unexpected payload: %+v", payload)
		}
		_, _ = io.WriteString(w, `{}`)
	}))
	defer discord.Close()
	config := testConfig()
	config.DiscordWebhookURL = discord.URL + "/webhook?wait=false"
	relay := httptest.NewServer(NewHandler(config, ServerOptions{Logger: func(map[string]any) {}}))
	defer relay.Close()
	body := eligibleBody(t)
	r, _ := http.NewRequest("POST", relay.URL+"/shortcut", bytes.NewReader(body))
	r.Header.Set("Payload-Signature", signature(body))
	resp, err := relay.Client().Do(r)
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != 204 {
		t.Fatalf("status = %d", resp.StatusCode)
	}
	mu.Lock()
	defer mu.Unlock()
	if calls != 1 {
		t.Fatalf("calls = %d", calls)
	}
}

func TestAuthenticationAndDiagnosticsBoundary(t *testing.T) {
	config := testConfig()
	config.Diagnostics = true
	var logs []map[string]any
	h := NewHandler(config, ServerOptions{
		Logger: func(v map[string]any) { logs = append(logs, v) },
		Client: &http.Client{Transport: roundTripFunc(func(*http.Request) (*http.Response, error) {
			t.Fatal("invalid/ignored event made upstream request")
			return nil, errors.New("unexpected")
		})},
	})
	for _, tc := range []struct {
		body, sig string
		status    int
	}{
		{"{", "", 401}, {"{", "bad", 401}, {"{", signature([]byte("{")), 400},
	} {
		if w := invoke(h, []byte(tc.body), tc.sig); w.Code != tc.status {
			t.Errorf("status %d want %d", w.Code, tc.status)
		}
	}
	for _, entry := range logs {
		if entry["outcome"] == "diagnostic" {
			t.Fatal("unauthenticated diagnostic")
		}
	}
	body := []byte(`{"id":"private-event","changed_at":"2025-01-01Z","member_id":"` + config.ShortcutMemberID + `","version":"v1","actions":[],"PRIVATE KEY":"PRIVATE VALUE"}`)
	if w := invoke(h, body, signature(body)); w.Code != 204 {
		t.Fatalf("self action status=%d", w.Code)
	}
	if len(logs) != 5 || logs[3]["outcome"] != "diagnostic" || logs[4]["outcome"] != "ignored" {
		t.Fatalf("logs=%+v", logs)
	}
	encoded, _ := json.Marshal(logs[3])
	for _, secret := range []string{"private-event", "PRIVATE", config.ShortcutMemberID} {
		if strings.Contains(string(encoded), secret) {
			t.Fatalf("diagnostic leaked %q", secret)
		}
	}
}

func TestDeliveryFailuresAndRedirectPolicy(t *testing.T) {
	for _, status := range []int{200, 204, 302, 400, 429, 500, 0} {
		t.Run(fmt.Sprint(status), func(t *testing.T) {
			calls := 0
			var logs []map[string]any
			client := &http.Client{Transport: roundTripFunc(func(r *http.Request) (*http.Response, error) {
				calls++
				if calls > 1 {
					t.Fatal("retried or followed upstream redirect")
				}
				if status == 0 {
					return nil, errors.New("PRIVATE URL TOKEN")
				}
				return &http.Response{StatusCode: status, Header: http.Header{"Location": {"https://evil.example/"}}, Body: io.NopCloser(strings.NewReader("PRIVATE BODY")), Request: r}, nil
			})}
			h := NewHandler(testConfig(), ServerOptions{Client: client, Logger: func(v map[string]any) { logs = append(logs, v) }})
			body := eligibleBody(t)
			w := invoke(h, body, signature(body))
			want := 502
			if status >= 200 && status < 300 {
				want = 204
			}
			if w.Code != want || calls != 1 {
				t.Fatalf("status=%d calls=%d", w.Code, calls)
			}
			data, _ := json.Marshal(logs)
			if strings.Contains(string(data), "PRIVATE") || strings.Contains(string(data), testSecret) {
				t.Fatalf("private log: %s", data)
			}
			if client.CheckRedirect != nil {
				t.Fatal("handler modified caller's client")
			}
		})
	}
}

func TestMemberLookupFallbackAndDelivery(t *testing.T) {
	for _, tc := range []struct {
		name, memberJSON, want string
		status                 int
		timeout                bool
	}{
		{"name", `{"id":"` + otherMember + `","profile":{"name":"Alice *Admin*"}}`, "@Alice \\*Admin\\*", 200, false},
		{"username fallback", `{"id":"` + otherMember + `","profile":{"name":123,"mention_name":"alice"}}`, "@alice", 200, false},
		{"null profile", `{"id":"` + otherMember + `","profile":null}`, "Shortcut member", 200, false},
		{"wrong ID", `{"id":"wrong","profile":{"name":"Mallory"}}`, "Shortcut member", 200, false},
		{"bad JSON", `not json`, "Shortcut member", 200, false},
		{"trailing JSON", `{"id":"` + otherMember + `","profile":{"name":"Alice"}} {}`, "Shortcut member", 200, false},
		{"rate limited", `{}`, "Shortcut member", 429, false},
		{"timeout", `{}`, "Shortcut member", 200, true},
	} {
		t.Run(tc.name, func(t *testing.T) {
			config := testConfig()
			config.ShortcutAPIToken = "PRIVATE API TOKEN"
			lookups, deliveries := 0, 0
			client := &http.Client{Transport: roundTripFunc(func(r *http.Request) (*http.Response, error) {
				if r.URL.Host == "api.app.shortcut.com" {
					lookups++
					if r.Header.Get("Shortcut-Token") != config.ShortcutAPIToken {
						t.Error("missing Shortcut token")
					}
					if tc.timeout {
						<-r.Context().Done()
						return nil, r.Context().Err()
					}
					return &http.Response{StatusCode: tc.status, Body: io.NopCloser(strings.NewReader(tc.memberJSON)), Header: make(http.Header)}, nil
				}
				deliveries++
				if r.Header.Get("Shortcut-Token") != "" {
					t.Error("Shortcut token leaked to Discord")
				}
				var payload struct{ Content string }
				if err := json.NewDecoder(r.Body).Decode(&payload); err != nil {
					t.Fatal(err)
				}
				if !strings.Contains(payload.Content, "Created by: "+tc.want) {
					t.Errorf("wrong attribution: %s", payload.Content)
				}
				return &http.Response{StatusCode: 200, Body: io.NopCloser(strings.NewReader("{}")), Header: make(http.Header)}, nil
			})}
			h := NewHandler(config, ServerOptions{Client: client, Logger: func(map[string]any) {}, MemberTimeout: 10 * time.Millisecond})
			body := eligibleBody(t)
			if w := invoke(h, body, signature(body)); w.Code != 204 || lookups != 1 || deliveries != 1 {
				t.Fatalf("status=%d lookups=%d deliveries=%d", w.Code, lookups, deliveries)
			}
		})
	}
}

func TestMemberLookupCapsWorkAndSharesDeadline(t *testing.T) {
	ids := []string{"../member", "https://evil.example", otherMember, otherMember}
	for i := 0; i < 12; i++ {
		ids = append(ids, fmt.Sprintf("00000000-0000-4000-8000-%012d", i))
	}
	calls := 0
	var deadline time.Time
	client := &http.Client{Transport: roundTripFunc(func(r *http.Request) (*http.Response, error) {
		calls++
		d, ok := r.Context().Deadline()
		if !ok {
			t.Fatal("missing deadline")
		}
		if calls == 1 {
			deadline = d
		} else if d != deadline {
			t.Fatal("deadline reset between lookups")
		}
		id := r.URL.Path[strings.LastIndex(r.URL.Path, "/")+1:]
		body := `{"id":"` + id + `","profile":{"name":"Name"}}`
		return &http.Response{StatusCode: 200, Body: io.NopCloser(strings.NewReader(body)), Header: make(http.Header)}, nil
	})}
	names := lookupMemberNames(context.Background(), client, ids, "token", time.Second)
	if calls != 10 || len(names) != 10 {
		t.Fatalf("calls=%d names=%d", calls, len(names))
	}
	lookupMemberNames(context.Background(), client, ids, "", time.Second)
	if calls != 10 {
		t.Fatal("lookup without token")
	}
}

func TestConcurrentRequests(t *testing.T) {
	client := &http.Client{Transport: roundTripFunc(func(*http.Request) (*http.Response, error) {
		return &http.Response{StatusCode: 200, Body: io.NopCloser(strings.NewReader("{}")), Header: make(http.Header)}, nil
	})}
	h := NewHandler(testConfig(), ServerOptions{Client: client, Logger: func(map[string]any) {}})
	body := eligibleBody(t)
	var wg sync.WaitGroup
	for i := 0; i < 20; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			if w := invoke(h, body, signature(body)); w.Code != 204 {
				t.Errorf("status=%d", w.Code)
			}
		}()
	}
	wg.Wait()
}
