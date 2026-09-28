package main

import (
	"context"
	"encoding/json"
	"io"
	"net/http"
	"strings"
	"time"
)

func lookupMemberNames(ctx context.Context, client *http.Client, ids []string, token string, timeout time.Duration) map[string]string {
	names := map[string]string{}
	if token == "" {
		return names
	}
	if timeout <= 0 {
		timeout = 2 * time.Second
	}
	ctx, cancel := context.WithTimeout(ctx, timeout)
	defer cancel()
	seen := map[string]bool{}
	count := 0
	for _, id := range ids {
		if !uuidPattern.MatchString(id) || seen[id] {
			continue
		}
		seen[id] = true
		if count == 10 {
			break
		}
		count++
		if ctx.Err() != nil {
			break
		}
		req, err := http.NewRequestWithContext(ctx, http.MethodGet, "https://api.app.shortcut.com/api/v3/members/"+id, nil)
		if err != nil {
			break
		}
		req.Header.Set("Shortcut-Token", token)
		req.Header.Set("Content-Type", "application/json")
		resp, err := client.Do(req)
		if err != nil {
			break
		}
		if resp.StatusCode < 200 || resp.StatusCode >= 300 {
			resp.Body.Close()
			break
		}
		body, readErr := io.ReadAll(io.LimitReader(resp.Body, maxBodyBytes+1))
		resp.Body.Close()
		var member map[string]any
		if readErr != nil || len(body) > maxBodyBytes || json.Unmarshal(body, &member) != nil || ctx.Err() != nil {
			break
		}
		memberID, _ := member["id"].(string)
		if !strings.EqualFold(memberID, id) {
			continue
		}
		profile, _ := member["profile"].(map[string]any)
		for _, field := range []string{"name", "mention_name"} {
			if name, ok := profile[field].(string); ok && strings.TrimFunc(name, textSpace) != "" {
				names[id] = name
				break
			}
		}
	}
	return names
}
