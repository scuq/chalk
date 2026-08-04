// Package integration runs Go tests against a real Postgres instance.
//
// To run these locally, bring up the dev stack (`make dev`) or point at any
// Postgres with the migrations applied, then seed fixtures/users.sql:
//
//	CHALK_TEST_PGURL=postgres://chalk:chalk@127.0.0.1:5432/chalk?sslmode=disable \
//	  go test ./test/integration/...
//
// Tests SKIP if CHALK_TEST_PGURL is unset, so `go test ./...` from a fresh
// checkout does the right thing.
package integration

import (
	"context"
	"os"
	"testing"
	"time"

	"github.com/scuq/chalk/internal/store"
)

func dbURL(t *testing.T) string {
	t.Helper()
	u := os.Getenv("CHALK_TEST_PGURL")
	if u == "" {
		t.Skip("CHALK_TEST_PGURL not set; skipping integration test")
	}
	return u
}

// openStore connects and registers cleanup. Caller must NOT call Close.
func openStore(t *testing.T) *store.Store {
	t.Helper()
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	st, err := store.Open(ctx, dbURL(t))
	if err != nil {
		t.Fatalf("store.Open: %v", err)
	}
	t.Cleanup(st.Close)
	return st
}

// ctx returns a per-test context with a generous default timeout.
func ctx(t *testing.T) context.Context {
	t.Helper()
	c, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	t.Cleanup(cancel)
	return c
}
