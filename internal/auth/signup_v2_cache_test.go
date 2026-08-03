package auth

import (
	"errors"
	"testing"
	"time"
)

// 81-4: with open registration an anonymous caller drives insertions into the
// pending-signup cache directly, and entries live 15 minutes. The cap is what
// keeps a signup flood from being a memory-exhaustion primitive -- and it has
// to lift again as entries expire, or one flood would block signups for the
// rest of the process's life.
func TestSignupV2CachePutRefusesAtCapacity(t *testing.T) {
	c := NewSignupV2Cache()
	now := time.Unix(1000, 0)
	c.now = func() time.Time { return now }

	for i := 0; i < signupV2MaxEntries; i++ {
		if _, err := c.Put(pendingSignup{}); err != nil {
			t.Fatalf("Put %d below capacity: %v", i, err)
		}
	}
	if _, err := c.Put(pendingSignup{}); !errors.Is(err, ErrSignupCapacity) {
		t.Fatalf("Put past the cap = %v, want ErrSignupCapacity", err)
	}

	now = now.Add(signupV2TTL + time.Minute)
	if _, err := c.Put(pendingSignup{}); err != nil {
		t.Fatalf("Put after the backlog expired: %v", err)
	}
}
