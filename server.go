package main

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"log"
	"net/http"
	"net/url"
	"os"
	"strconv"
	"strings"
	"time"

	"shortcut-webhook/internal/relay"
)

const maxBodyBytes = 1 << 20

type ServerOptions struct {
	Client        *http.Client
	Logger        func(map[string]any)
	Timeout       time.Duration
	MemberTimeout time.Duration
}

var genericBodies = map[int]string{200: "OK", 400: "Bad Request", 401: "Unauthorized", 404: "Not Found", 405: "Method Not Allowed", 413: "Payload Too Large", 500: "Internal Server Error", 502: "Bad Gateway"}

func NewHandler(config Config, options ServerOptions) http.Handler {
	client := options.Client
	if client == nil {
		client = http.DefaultClient
	}
	clientCopy := *client
	clientCopy.CheckRedirect = func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }
	logger := options.Logger
	if logger == nil {
		logger = func(fields map[string]any) {
			b, err := json.Marshal(fields)
			if err == nil {
				log.New(os.Stdout, "", 0).Print(string(b))
			}
		}
	}
	discordTimeout := options.Timeout
	if discordTimeout <= 0 {
		discordTimeout = 5 * time.Second
	}
	memberTimeout := options.MemberTimeout
	if memberTimeout <= 0 {
		memberTimeout = 2 * time.Second
	}
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		started := time.Now()
		pathname := r.URL.EscapedPath()
		if pathname == "/healthz" {
			if r.Method != http.MethodGet {
				sendResponse(w, 405, http.Header{"Allow": []string{"GET"}})
				return
			}
			sendResponse(w, 200, nil)
			return
		}
		if pathname != "/shortcut" {
			sendResponse(w, 404, nil)
			return
		}
		if r.Method != http.MethodPost {
			sendResponse(w, 405, http.Header{"Allow": []string{"POST"}})
			return
		}
		if r.ContentLength > maxBodyBytes {
			logOutcome(logger, nil, "invalid", started, nil)
			sendResponse(w, 413, nil)
			return
		}
		r.Body = http.MaxBytesReader(w, r.Body, maxBodyBytes)
		raw, err := io.ReadAll(r.Body)
		if err != nil {
			outcome := "invalid"
			status := 400
			var maxErr *http.MaxBytesError
			if errors.As(err, &maxErr) {
				status = 413
			}
			logOutcome(logger, nil, outcome, started, nil)
			sendResponse(w, status, nil)
			return
		}
		signatures := r.Header.Values("Payload-Signature")
		if len(signatures) != 1 || !verifySignature(raw, signatures[0], config.ShortcutWebhookSecret) {
			logOutcome(logger, nil, "invalid", started, nil)
			sendResponse(w, 401, nil)
			return
		}
		var event any
		if err := json.Unmarshal(raw, &event); err != nil {
			logOutcome(logger, nil, "invalid", started, nil)
			sendResponse(w, 400, nil)
			return
		}
		var validationIssue *relay.ValidationIssue
		relayOptions := relay.Options{ShortcutMemberID: config.ShortcutMemberID, WorkspaceSlug: config.WorkspaceSlug, DiscordUserID: config.DiscordUserID}
		if config.Diagnostics {
			relayOptions.OnInvalid = func(issue relay.ValidationIssue) { copyIssue := issue; validationIssue = &copyIssue }
		}
		result := relay.ProcessEvent(event, relayOptions)
		if config.Diagnostics {
			obj, _ := event.(map[string]any)
			_, self := obj["member_id"]
			selfMatch := self && obj["member_id"] == config.ShortcutMemberID
			ownerMatch := false
			if owners, ok := obj["owner_ids"].([]any); ok {
				for _, v := range owners {
					if v == config.ShortcutMemberID {
						ownerMatch = true
					}
				}
			}
			diagnostic := map[string]any{"outcome": "diagnostic", "eventOutcome": result.Outcome, "memberChecks": map[string]bool{"selfAuthored": selfMatch, "aggregateOwnerMatch": ownerMatch}, "shape": eventShape(event)}
			if validationIssue != nil {
				diagnostic["validationError"] = validationIssue
			}
			writeLog(logger, diagnostic)
		}
		switch result.Outcome {
		case "invalid":
			logOutcome(logger, &result, "invalid", started, nil)
			sendResponse(w, 400, nil)
			return
		case "ignored":
			logOutcome(logger, &result, "ignored", started, nil)
			sendResponse(w, 204, nil)
			return
		case "deliver":
			if result.Payload == nil {
				logOutcome(logger, &result, "error", started, nil)
				sendResponse(w, 500, nil)
				return
			}
		default:
			logOutcome(logger, &result, "error", started, nil)
			sendResponse(w, 500, nil)
			return
		}
		authorIDs := uniqueStrings(append(append([]string{}, result.CommentAuthorIDs...), result.CreatorIDs...))
		if config.ShortcutAPIToken != "" && len(authorIDs) > 0 {
			names := lookupMemberNames(r.Context(), &clientCopy, authorIDs, config.ShortcutAPIToken, memberTimeout)
			result = relay.ProcessEvent(event, relay.Options{ShortcutMemberID: config.ShortcutMemberID, WorkspaceSlug: config.WorkspaceSlug, DiscordUserID: config.DiscordUserID, AuthorNames: names})
		}
		status, ok := postDiscord(r.Context(), &clientCopy, config.DiscordWebhookURL, result.Payload, discordTimeout)
		if ok {
			logOutcome(logger, &result, "delivered", started, status)
			sendResponse(w, 204, nil)
			return
		}
		logOutcome(logger, &result, "discord_failed", started, status)
		sendResponse(w, 502, nil)
	})
}

func uniqueStrings(in []string) []string {
	out := make([]string, 0, len(in))
	seen := map[string]bool{}
	for _, s := range in {
		if !seen[s] {
			seen[s] = true
			out = append(out, s)
		}
	}
	return out
}

func postDiscord(parent context.Context, client *http.Client, rawURL string, payload *relay.DiscordPayload, timeout time.Duration) (any, bool) {
	u, err := url.Parse(rawURL)
	if err != nil {
		return nil, false
	}
	q := u.Query()
	q.Set("wait", "true")
	u.RawQuery = q.Encode()
	body, err := json.Marshal(payload)
	if err != nil {
		return nil, false
	}
	ctx, cancel := context.WithTimeout(parent, timeout)
	defer cancel()
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, u.String(), strings.NewReader(string(body)))
	if err != nil {
		return nil, false
	}
	req.Header.Set("Content-Type", "application/json")
	resp, err := client.Do(req)
	if err != nil {
		return nil, false
	}
	defer resp.Body.Close()
	// wait=true confirms delivery in the response status; do not wait for or log
	// the returned message body, which can contain private Story content.
	return resp.StatusCode, resp.StatusCode >= 200 && resp.StatusCode < 300
}

func logOutcome(logger func(map[string]any), result *relay.Result, outcome string, started time.Time, discordStatus any) {
	m := map[string]any{"outcome": outcome, "latencyMs": max(int64(0), time.Since(started).Milliseconds())}
	if result != nil {
		if result.EventID != "" {
			m["eventId"] = result.EventID
		}
		if result.StoryIDs != nil {
			v := make([]string, len(result.StoryIDs))
			for i, n := range result.StoryIDs {
				v[i] = strconv.FormatInt(n, 10)
			}
			m["storyIds"] = v
		}
		if result.ActionTypes != nil {
			m["actionTypes"] = result.ActionTypes
		}
	}
	if discordStatus != nil {
		m["discordStatus"] = discordStatus
	}
	writeLog(logger, m)
}
func writeLog(logger func(map[string]any), fields map[string]any) {
	defer func() { _ = recover() }()
	logger(fields)
}
func sendResponse(w http.ResponseWriter, status int, headers http.Header) {
	for k, values := range headers {
		for _, v := range values {
			w.Header().Add(k, v)
		}
	}
	if status == 204 {
		w.WriteHeader(status)
		return
	}
	body := genericBodies[status]
	if body == "" {
		body = genericBodies[500]
	}
	w.Header().Set("Content-Type", "text/plain; charset=utf-8")
	w.Header().Set("Content-Length", strconv.Itoa(len(body)))
	w.WriteHeader(status)
	_, _ = io.WriteString(w, body)
}
