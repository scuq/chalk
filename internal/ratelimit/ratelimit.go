// Package ratelimit is a per-key sliding-window limiter. In-memory and
// process-local, which is exactly chalkd's deployment shape (one instance).
// Lifted out of internal/linkpreview in 80-8, when the guest join endpoints
// became its second consumer.
package ratelimit

import (
	"sync"
	"time"
)

// RateLimiter allows limit events per key per window. Handlers key it by
// whatever identity fits the endpoint (user ID for authed surfaces, client
// IP for anonymous ones).
type RateLimiter struct {
	mu     sync.Mutex
	limit  int
	window time.Duration
	now    func() time.Time // test hook
	hits   map[string][]time.Time
}

// New allows limit events per key per window.
func New(limit int, window time.Duration) *RateLimiter {
	return &RateLimiter{
		limit:  limit,
		window: window,
		now:    time.Now,
		hits:   map[string][]time.Time{},
	}
}

// Allow records an attempt for key and reports whether it is within the
// limit. Denied attempts are not recorded (a throttled client polling retry
// doesn't push its recovery further away).
func (r *RateLimiter) Allow(key string) bool {
	r.mu.Lock()
	defer r.mu.Unlock()
	now := r.now()
	cutoff := now.Add(-r.window)

	kept := r.hits[key][:0]
	for _, t := range r.hits[key] {
		if t.After(cutoff) {
			kept = append(kept, t)
		}
	}
	if len(kept) >= r.limit {
		r.hits[key] = kept
		return false
	}
	r.hits[key] = append(kept, now)
	return true
}
