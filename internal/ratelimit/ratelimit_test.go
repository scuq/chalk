package ratelimit

import (
	"testing"
	"time"
)

func TestRateLimiter(t *testing.T) {
	r := New(3, time.Minute)
	now := time.Unix(1000, 0)
	r.now = func() time.Time { return now }

	for i := 0; i < 3; i++ {
		if !r.Allow("alice") {
			t.Fatalf("attempt %d should be allowed", i+1)
		}
	}
	if r.Allow("alice") {
		t.Fatal("4th attempt within window must be denied")
	}
	if !r.Allow("bob") {
		t.Fatal("keys are independent")
	}
	now = now.Add(61 * time.Second)
	if !r.Allow("alice") {
		t.Fatal("window expiry must restore the allowance")
	}
}

// 81-4: these limiters are keyed by client IP on anonymous endpoints, so a
// flood from many addresses must not leave an entry per address behind.
func TestRateLimiterEvictsIdleKeys(t *testing.T) {
	r := New(3, time.Minute)
	now := time.Unix(1000, 0)
	r.now = func() time.Time { return now }

	for i := 0; i < 500; i++ {
		r.Allow(string(rune('a'+i%26)) + time.Duration(i).String())
	}
	if r.Len() < 100 {
		t.Fatalf("expected the flood to be tracked, got %d keys", r.Len())
	}

	// Every hit is now stale. One more attempt triggers the sweep.
	now = now.Add(2 * time.Minute)
	r.Allow("straggler")
	if r.Len() != 1 {
		t.Errorf("after the sweep %d keys remain, want only the straggler", r.Len())
	}

	// The straggler itself is still live, and its allowance is intact.
	for i := 0; i < 2; i++ {
		if !r.Allow("straggler") {
			t.Fatalf("straggler attempt %d should be allowed", i+2)
		}
	}
	if r.Allow("straggler") {
		t.Error("the sweep must not have reset the straggler's allowance")
	}
}
