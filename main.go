package main

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"os"
	"os/signal"
	"strconv"
	"strings"
	"syscall"
	"time"
)

func main() {
	if err := run(); err != nil {
		// Never print errors that may contain configuration secrets or URLs.
		_ = json.NewEncoder(os.Stderr).Encode(map[string]string{"outcome": err.Error()})
		os.Exit(1)
	}
}

func run() error {
	env := make(map[string]string)
	for _, entry := range os.Environ() {
		key, value, _ := strings.Cut(entry, "=")
		env[key] = value
	}
	config, err := LoadConfig(env)
	if err != nil {
		return errors.New("configuration_error")
	}

	server := &http.Server{
		Addr:              ":" + strconv.Itoa(config.Port),
		Handler:           NewHandler(config, ServerOptions{}),
		ReadHeaderTimeout: 5 * time.Second,
		ReadTimeout:       15 * time.Second,
		WriteTimeout:      30 * time.Second,
		IdleTimeout:       60 * time.Second,
	}
	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()
	finished := make(chan error, 1)
	go func() { finished <- server.ListenAndServe() }()
	select {
	case err := <-finished:
		if !errors.Is(err, http.ErrServerClosed) {
			return errors.New("server_error")
		}
	case <-ctx.Done():
		shutdown, cancel := context.WithTimeout(context.Background(), 10*time.Second)
		defer cancel()
		if err := server.Shutdown(shutdown); err != nil {
			_ = server.Close()
			return errors.New("shutdown_error")
		}
	}
	return nil
}
