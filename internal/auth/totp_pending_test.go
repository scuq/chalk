// chalk -- phase31-slice31-2 pending-2FA cache tests.
package auth

import (
	"testing"
	"time"

	"github.com/google/uuid"
)

func TestPendingTOTPIssueTakeOneShot(t *testing.T) {
	c := NewPendingTOTPCache(time.Minute)
	uid := uuid.New()

	tok, err := c.Issue(uid, "password")
	if err != nil {
		t.Fatalf("Issue: %v", err)
	}
	if tok == "" {
		t.Fatal("empty token")
	}

	got, err := c.Take(tok)
	if err != nil {
		t.Fatalf("Take: %v", err)
	}
	if got.UserID != uid || got.Method != "password" {
		t.Fatalf("wrong entry: %+v", got)
	}

	// one-shot: second Take must miss
	if _, err := c.Take(tok); err != ErrPendingNotFound {
		t.Fatalf("expected ErrPendingNotFound on reuse, got %v", err)
	}
}

func TestPendingTOTPExpiry(t *testing.T) {
	c := NewPendingTOTPCache(time.Minute)
	base := time.Now()
	c.now = func() time.Time { return base }

	tok, err := c.Issue(uuid.New(), "password")
	if err != nil {
		t.Fatalf("Issue: %v", err)
	}

	// advance past TTL
	c.now = func() time.Time { return base.Add(2 * time.Minute) }
	if _, err := c.Take(tok); err != ErrPendingExpired {
		t.Fatalf("expected ErrPendingExpired, got %v", err)
	}
}

func TestPendingTOTPUnknownToken(t *testing.T) {
	c := NewPendingTOTPCache(time.Minute)
	if _, err := c.Take("nope"); err != ErrPendingNotFound {
		t.Fatalf("expected ErrPendingNotFound, got %v", err)
	}
}

func TestPendingTOTPPrunesExpiredOnIssue(t *testing.T) {
	c := NewPendingTOTPCache(time.Minute)
	base := time.Now()
	c.now = func() time.Time { return base }

	if _, err := c.Issue(uuid.New(), "password"); err != nil {
		t.Fatalf("Issue: %v", err)
	}
	if c.Len() != 1 {
		t.Fatalf("expected 1 entry, got %d", c.Len())
	}

	// advance past TTL, then a new Issue should prune the stale one
	c.now = func() time.Time { return base.Add(2 * time.Minute) }
	if _, err := c.Issue(uuid.New(), "password"); err != nil {
		t.Fatalf("Issue: %v", err)
	}
	if c.Len() != 1 {
		t.Fatalf("expected stale entry pruned, got %d entries", c.Len())
	}
}
