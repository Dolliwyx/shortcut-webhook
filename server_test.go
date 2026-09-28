package main

import (
	"context"
	"crypto/hmac"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"strconv"
	"strings"
	"testing"
	"time"
)

const testSecret = "server-test-secret"

func testConfig() Config {
	return Config{ShortcutWebhookSecret: testSecret, ShortcutMemberID: "11111111-1111-1111-1111-111111111111", WorkspaceSlug: "workspace", DiscordWebhookURL: "https://discord.com/api/webhooks/123/token", DiscordUserID: "123456789012345678"}
}
func signature(body []byte) string {
	h := hmac.New(sha256.New, []byte(testSecret))
	_, _ = h.Write(body)
	return hex.EncodeToString(h.Sum(nil))
}

func TestSignatureRawBytesAndHexCase(t *testing.T) {
	body := []byte(`{"ok":true}`)
	sig := signature(body)
	if !verifySignature(body, sig, testSecret) || !verifySignature(body, strings.ToUpper(sig), testSecret) {
		t.Fatal("valid signature rejected")
	}
	if verifySignature([]byte(`{ "ok": true }`), sig, testSecret) || verifySignature(body, sig+"0", testSecret) || verifySignature(body, sig, "wrong") {
		t.Fatal("invalid signature accepted")
	}
}

func TestLoadConfigAndStrictDiscordURL(t *testing.T) {
	env := map[string]string{"SHORTCUT_WEBHOOK_SECRET": testSecret, "SHORTCUT_MEMBER_ID": testConfig().ShortcutMemberID, "SHORTCUT_WORKSPACE_SLUG": "workspace", "DISCORD_WEBHOOK_URL": "https://discord.com/api/webhooks/123/token", "DISCORD_USER_ID": "12345"}
	c, err := LoadConfig(env)
	if err != nil || c.Port != 3000 {
		t.Fatalf("config: %#v %v", c, err)
	}
	for _, bad := range []string{"https://discord.com:443/api/webhooks/123/token", "https://user@discord.com/api/webhooks/123/token", "http://discord.com/api/webhooks/123/token", "https://discord.com/api/webhooks/no/token"} {
		env["DISCORD_WEBHOOK_URL"] = bad
		if _, err = LoadConfig(env); err == nil {
			t.Errorf("accepted %q", bad)
		}
	}
}

func TestDiagnosticsRedactsValuesAndBoundsTraversal(t *testing.T) {
	shape := eventShape(map[string]any{"PRIVATE KEY": map[string]any{"text": "PRIVATE VALUE"}, "entity_type": "story-comment", "action": "create", "id": float64(42), "actions": []any{map[string]any{"changes": map[string]any{"comment_ids": map[string]any{"adds": []any{float64(42)}}}}}})
	encoded, err := json.Marshal(shape)
	if err != nil {
		t.Fatal(err)
	}
	text := string(encoded)
	for _, secret := range []string{"PRIVATE KEY", "PRIVATE VALUE", "42"} {
		if strings.Contains(text, secret) {
			t.Fatalf("diagnostics leaked %q: %s", secret, text)
		}
	}
	if len(shape.Fields) > 200 {
		t.Fatalf("unbounded fields: %d", len(shape.Fields))
	}
	if !strings.Contains(text, "redacted-key-") || !strings.Contains(text, "sameNumberAs") {
		t.Fatalf("missing diagnostic relationships: %s", text)
	}
	wide := map[string]any{}
	for i := 0; i < 300; i++ {
		wide["private-key-"+strconv.Itoa(i)] = "secret"
	}
	if got := eventShape(wide); !got.Truncated || len(got.Fields) > 200 {
		t.Fatalf("wide object not bounded: %#v", got)
	}
}

func TestRoutesSignatureAndBodyLimit(t *testing.T) {
	h := NewHandler(testConfig(), ServerOptions{Logger: func(map[string]any) {}})
	for _, tc := range []struct {
		method, path string
		status       int
		allow        string
	}{{"GET", "/healthz", 200, ""}, {"POST", "/healthz", 405, "GET"}, {"GET", "/shortcut", 405, "POST"}, {"GET", "/unknown", 404, ""}, {"GET", "/%68ealthz", 404, ""}, {"POST", "/%73hortcut", 404, ""}} {
		r := httptest.NewRequest(tc.method, tc.path, nil)
		w := httptest.NewRecorder()
		h.ServeHTTP(w, r)
		if w.Code != tc.status || w.Header().Get("Allow") != tc.allow {
			t.Errorf("%s %s: %d %q", tc.method, tc.path, w.Code, w.Header().Get("Allow"))
		}
	}
	valid := []byte(`{}`)
	for _, dup := range []bool{false, true} {
		r := httptest.NewRequest("POST", "/shortcut", strings.NewReader(string(valid)))
		r.Header.Add("Payload-Signature", signature(valid))
		if dup {
			r.Header.Add("Payload-Signature", signature(valid))
		}
		w := httptest.NewRecorder()
		h.ServeHTTP(w, r)
		want := 400
		if dup {
			want = 401
		}
		if w.Code != want {
			t.Errorf("duplicate=%v status=%d", dup, w.Code)
		}
	}
	body := make([]byte, maxBodyBytes+1)
	r := httptest.NewRequest("POST", "/shortcut", strings.NewReader(string(body)))
	r.Header.Set("Payload-Signature", signature(body))
	w := httptest.NewRecorder()
	h.ServeHTTP(w, r)
	if w.Code != 413 {
		t.Fatalf("oversize: %d", w.Code)
	}
	body = make([]byte, maxBodyBytes)
	body[0] = ' '
	r = httptest.NewRequest("POST", "/shortcut", strings.NewReader(string(body)))
	r.Header.Set("Payload-Signature", signature(body))
	w = httptest.NewRecorder()
	h.ServeHTTP(w, r)
	if w.Code != 400 {
		t.Fatalf("exact limit: %d", w.Code)
	}
}

type roundTripFunc func(*http.Request) (*http.Response, error)

func (f roundTripFunc) RoundTrip(r *http.Request) (*http.Response, error) { return f(r) }

func TestOutboundRedirectRejectedAndTimeoutCancelled(t *testing.T) {
	calls := 0
	client := &http.Client{Transport: roundTripFunc(func(r *http.Request) (*http.Response, error) {
		calls++
		return &http.Response{StatusCode: 302, Header: make(http.Header), Body: io.NopCloser(strings.NewReader("")), Request: r}, nil
	})}
	_, ok := postDiscord(context.Background(), client, "https://discord.com/api/webhooks/123/token", nil, time.Second)
	if ok || calls != 1 {
		t.Fatalf("redirect accepted or followed: ok=%v calls=%d", ok, calls)
	}
	started := make(chan struct{})
	cancelled := make(chan struct{})
	blocked := &http.Client{Transport: roundTripFunc(func(r *http.Request) (*http.Response, error) {
		close(started)
		<-r.Context().Done()
		close(cancelled)
		return nil, r.Context().Err()
	})}
	done := make(chan struct{})
	go func() {
		defer close(done)
		_, _ = postDiscord(context.Background(), blocked, "https://discord.com/api/webhooks/123/token", nil, 10*time.Millisecond)
	}()
	<-started
	<-done
	select {
	case <-cancelled:
	case <-time.After(time.Second):
		t.Fatal("outbound request was not cancelled")
	}
}
