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
