package main

import (
	"fmt"
	"net/url"
	"regexp"
	"strconv"
	"strings"
	"unicode"
)

type Config struct {
	ShortcutWebhookSecret string
	ShortcutAPIToken      string
	ShortcutMemberID      string
	WorkspaceSlug         string
	DiscordWebhookURL     string
	DiscordUserID         string
	Port                  int
	Diagnostics           bool
}

var (
	uuidPattern    = regexp.MustCompile(`(?i)^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$`)
	decimalPattern = regexp.MustCompile(`^[0-9]+$`)
	visibleASCII   = regexp.MustCompile(`^[\x21-\x7e]+$`)
)

func LoadConfig(env map[string]string) (Config, error) {
	var c Config
	var errors []string
	c.ShortcutWebhookSecret = env["SHORTCUT_WEBHOOK_SECRET"]
	c.ShortcutAPIToken = env["SHORTCUT_API_TOKEN"]
	c.ShortcutMemberID = env["SHORTCUT_MEMBER_ID"]
	c.WorkspaceSlug = env["SHORTCUT_WORKSPACE_SLUG"]
	c.DiscordWebhookURL = env["DISCORD_WEBHOOK_URL"]
	c.DiscordUserID = env["DISCORD_USER_ID"]
	if c.ShortcutWebhookSecret == "" {
		errors = append(errors, "SHORTCUT_WEBHOOK_SECRET")
	}
	if c.ShortcutAPIToken != "" && !visibleASCII.MatchString(c.ShortcutAPIToken) {
		errors = append(errors, "SHORTCUT_API_TOKEN")
	}
	if !uuidPattern.MatchString(c.ShortcutMemberID) {
		errors = append(errors, "SHORTCUT_MEMBER_ID")
	}
	if !validWorkspaceSlug(c.WorkspaceSlug) {
		errors = append(errors, "SHORTCUT_WORKSPACE_SLUG")
	}
	if !validDiscordWebhookURL(c.DiscordWebhookURL) {
		errors = append(errors, "DISCORD_WEBHOOK_URL")
	}
	if !decimalPattern.MatchString(c.DiscordUserID) {
		errors = append(errors, "DISCORD_USER_ID")
	}
	c.Port = 3000
	if port, ok := env["PORT"]; ok {
		if !decimalPattern.MatchString(port) {
			errors = append(errors, "PORT")
		} else if n, err := strconv.Atoi(port); err != nil || n < 1 || n > 65535 {
			errors = append(errors, "PORT")
		} else {
			c.Port = n
		}
	}
	c.Diagnostics = env["SHORTCUT_DIAGNOSTICS"] == "1"
	if len(errors) > 0 {
		return Config{}, fmt.Errorf("Invalid configuration: %s", strings.Join(errors, ", "))
	}
	return c, nil
}

func validWorkspaceSlug(s string) bool {
	if s == "" || s == "." || s == ".." {
		return false
	}
	for _, r := range s {
		if textSpace(r) || strings.ContainsRune("/?#", r) {
			return false
		}
	}
	return true
}

// Match JavaScript's whitespace rules at the configuration/lookup boundary.
func textSpace(r rune) bool { return r == '\ufeff' || (r != '\u0085' && unicode.IsSpace(r)) }

func validDiscordWebhookURL(raw string) bool {
	if raw == "" || strings.ContainsAny(raw, "\\\r\n\t ") {
		return false
	}
	u, err := url.Parse(raw)
	if err != nil || !strings.EqualFold(u.Scheme, "https") || !strings.EqualFold(u.Hostname(), "discord.com") || u.User != nil || u.Port() != "" || u.Opaque != "" {
		return false
	}
	// Preserve the authority allowlist, including rejection of an explicit :443.
	authority := raw
	if i := strings.Index(authority, "://"); i >= 0 {
		authority = authority[i+3:]
	} else {
		return false
	}
	if i := strings.IndexAny(authority, "/?#"); i >= 0 {
		authority = authority[:i]
	}
	if !strings.EqualFold(authority, "discord.com") {
		return false
	}
	parts := strings.Split(u.EscapedPath(), "/")
	return len(parts) == 5 && parts[1] == "api" && parts[2] == "webhooks" && decimalPattern.MatchString(parts[3]) && parts[4] != "" && !strings.Contains(parts[4], "/")
}
