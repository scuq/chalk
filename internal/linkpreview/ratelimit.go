package linkpreview

import (
	"sync"
	"time"
)

// RateLimiter is a per-key sliding-window limiter. It exists so an authed
// user can't turn the preview fetcher into a crawling proxy: the handlers
// key it by user ID. In-memory and process-local, which is exactly chalkd's
// deployment shape (one instance).
type RateLimiter struct {
	mu     sync.Mutex
	limit  int
	window time.Duration
	now    func() time.Time // test hook
	hits   map[string][]time.Time
}

// NewRateLimiter allows limit events per key per window.
func NewRateLimiter(limit int, window time.Duration) *RateLimiter {
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
