package main

import (
	"maps"
	"strings"
	"testing"
)

func TestConfigurationValidation(t *testing.T) {
	base := map[string]string{
		"SHORTCUT_WEBHOOK_SECRET": "private-secret", "SHORTCUT_MEMBER_ID": testConfig().ShortcutMemberID,
		"SHORTCUT_WORKSPACE_SLUG": "workspace", "DISCORD_WEBHOOK_URL": testConfig().DiscordWebhookURL, "DISCORD_USER_ID": "12345",
	}
	for _, tc := range []struct{ key, value string }{
		{"SHORTCUT_WEBHOOK_SECRET", ""}, {"SHORTCUT_MEMBER_ID", "invalid"},
		{"SHORTCUT_WORKSPACE_SLUG", ""}, {"SHORTCUT_WORKSPACE_SLUG", ".."}, {"SHORTCUT_WORKSPACE_SLUG", "a/b"},
		{"SHORTCUT_WORKSPACE_SLUG", "a?b"}, {"SHORTCUT_WORKSPACE_SLUG", "a\ufeffb"},
		{"SHORTCUT_API_TOKEN", " "}, {"SHORTCUT_API_TOKEN", "secret\r\nInjected: header"},
		{"DISCORD_USER_ID", "-123"}, {"DISCORD_USER_ID", "123\n"},
		{"DISCORD_WEBHOOK_URL", "https://evil.example/api/webhooks/123/token"},
		{"DISCORD_WEBHOOK_URL", "https://discord.com/api/webhooks/123/"},
		{"PORT", ""}, {"PORT", "0"}, {"PORT", "65536"}, {"PORT", "1.5"}, {"PORT", " 3000"},
	} {
		env := maps.Clone(base)
		env[tc.key] = tc.value
		_, err := LoadConfig(env)
		if err == nil {
			t.Errorf("accepted invalid %s", tc.key)
			continue
		}
		if strings.Contains(err.Error(), "private-secret") || strings.Contains(err.Error(), "Injected") {
			t.Error("configuration error leaked values")
		}
	}
	for _, port := range []string{"1", "3000", "65535"} {
		env := maps.Clone(base)
		env["PORT"] = port
		if _, err := LoadConfig(env); err != nil {
			t.Errorf("valid port %s: %v", port, err)
		}
	}
}
