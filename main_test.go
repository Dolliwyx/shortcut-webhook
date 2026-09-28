package main

import "testing"

func TestRunRejectsInvalidConfiguration(t *testing.T) {
	t.Setenv("SHORTCUT_WEBHOOK_SECRET", "")
	err := run()
	if err == nil || err.Error() != "configuration_error" {
		t.Fatalf("run() = %v, want configuration_error", err)
	}
}
