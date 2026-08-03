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
	mu        sync.Mutex
	limit     int
	window    time.Duration
	now       func() time.Time // test hook
	hits      map[string][]time.Time
	lastSweep time.Time
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
	r.sweep(now, cutoff)
	return true
}

// sweep drops keys whose every hit has aged out. Without it the map only ever
// grows: 81-4 keys these limiters by client IP on anonymous endpoints, so a
// flood from many addresses would otherwise retain an entry per address
// forever. Amortized to once per window, under the lock the caller holds.
func (r *RateLimiter) sweep(now, cutoff time.Time) {
	if now.Sub(r.lastSweep) < r.window {
		return
	}
	r.lastSweep = now
	for k, ts := range r.hits {
		if len(ts) == 0 || !ts[len(ts)-1].After(cutoff) {
			delete(r.hits, k)
		}
	}
}

// Len reports how many keys are currently tracked. For tests and diagnostics.
func (r *RateLimiter) Len() int {
	r.mu.Lock()
	defer r.mu.Unlock()
	return len(r.hits)
}
