# Project

This repository contains a dependency-free Go webhook relay. It receives signed Shortcut Story events, verifies and filters meaningful changes for one configured owner, then sends a safe notification through a Discord incoming webhook.

Follow [`README.md`](README.md) for scope and security requirements, and [`test/fixtures/README.md`](test/fixtures/README.md) for confirmed versus provisional event shapes. The previous `MVP.md` reference has no corresponding file.

# Verification

Use Go's standard tooling for the relay. Run `go test -race ./...` and `go vet ./...` after changes. The retained Node implementation is a migration reference, not the production entry point. Use pnpm for its scripts; run `RELAY_NODE_PARITY=1 go test ./internal/relay -run TestNodeParity` when changing filtering or formatting and Node is available.
