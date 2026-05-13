package auth

import (
	"context"
	"errors"
	"sync"
	"testing"
	"time"

	"github.com/go-webauthn/webauthn/webauthn"
	"github.com/google/uuid"
)

// fakeNow returns a settable clock for tests that need to advance time.
type fakeNow struct {
	mu sync.Mutex
	t  time.Time
}

func newFakeNow(start time.Time) *fakeNow { return &fakeNow{t: start} }
func (f *fakeNow) now() time.Time {
	f.mu.Lock()
	defer f.mu.Unlock()
	return f.t
}
func (f *fakeNow) advance(d time.Duration) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.t = f.t.Add(d)
}

func newTestCache(t *testing.T, ttl time.Duration, clock *fakeNow) *CeremonyCache {
	t.Helper()
	c := NewCeremonyCache(ttl)
	if clock != nil {
		c.now = clock.now
	}
	return c
}

func sampleEntry() CeremonyEntry {
	return CeremonyEntry{
		Kind: KindRegistration,
		Session: webauthn.SessionData{
			Challenge: "test-challenge",
		},
		PendingUser: PendingUser{
			ID:          uuid.New(),
			Username:    "alice",
			DisplayName: "Alice",
			Email:       "alice@example.invalid",
		},
	}
}

func TestPutAndTake(t *testing.T) {
	c := newTestCache(t, time.Minute, nil)
	entry := sampleEntry()
	c.Put("ch1", entry)
	if c.Len() != 1 {
		t.Errorf("Len = %d, want 1", c.Len())
	}
	got, err := c.Take("ch1")
	if err != nil {
		t.Fatalf("Take: %v", err)
	}
	if got.PendingUser.Username != "alice" {
		t.Errorf("PendingUser.Username = %q", got.PendingUser.Username)
	}
	if c.Len() != 0 {
		t.Errorf("Len after Take = %d, want 0", c.Len())
	}
}

func TestTakeIsOneShot(t *testing.T) {
	c := newTestCache(t, time.Minute, nil)
	c.Put("ch1", sampleEntry())
	if _, err := c.Take("ch1"); err != nil {
		t.Fatalf("first Take: %v", err)
	}
	_, err := c.Take("ch1")
	if !errors.Is(err, ErrCeremonyNotFound) {
		t.Errorf("second Take: expected ErrCeremonyNotFound, got %v", err)
	}
}

func TestTakeMissingIsNotFound(t *testing.T) {
	c := newTestCache(t, time.Minute, nil)
	_, err := c.Take("never-stored")
	if !errors.Is(err, ErrCeremonyNotFound) {
		t.Errorf("expected ErrCeremonyNotFound, got %v", err)
	}
}

func TestTakeExpired(t *testing.T) {
	clock := newFakeNow(time.Unix(1000, 0))
	c := newTestCache(t, 5*time.Minute, clock)
	c.Put("ch1", sampleEntry())
	clock.advance(6 * time.Minute)
	_, err := c.Take("ch1")
	if !errors.Is(err, ErrCeremonyExpired) {
		t.Errorf("expected ErrCeremonyExpired, got %v", err)
	}
	// Even after returning expired, the entry is consumed (one-shot).
	if c.Len() != 0 {
		t.Errorf("expired entry should be removed; Len = %d", c.Len())
	}
}

func TestPrune(t *testing.T) {
	clock := newFakeNow(time.Unix(1000, 0))
	c := newTestCache(t, 5*time.Minute, clock)
	// Three entries, then advance time so all expire.
	c.Put("a", sampleEntry())
	c.Put("b", sampleEntry())
	c.Put("c", sampleEntry())
	if removed := c.Prune(); removed != 0 {
		t.Errorf("Prune before expiry = %d, want 0", removed)
	}
	clock.advance(6 * time.Minute)
	if removed := c.Prune(); removed != 3 {
		t.Errorf("Prune after expiry = %d, want 3", removed)
	}
	if c.Len() != 0 {
		t.Errorf("Len after Prune = %d, want 0", c.Len())
	}
}

func TestPrunePartial(t *testing.T) {
	clock := newFakeNow(time.Unix(1000, 0))
	c := newTestCache(t, 5*time.Minute, clock)
	c.Put("old", sampleEntry())
	clock.advance(3 * time.Minute)
	c.Put("new", sampleEntry())
	clock.advance(3 * time.Minute)
	// Now "old" is 6 min old (expired); "new" is 3 min old (alive).
	if removed := c.Prune(); removed != 1 {
		t.Errorf("Prune = %d, want 1", removed)
	}
	if c.Len() != 1 {
		t.Errorf("Len after partial prune = %d, want 1", c.Len())
	}
	if _, err := c.Take("new"); err != nil {
		t.Errorf("alive entry should still be takeable: %v", err)
	}
}

func TestEmptyKeyRejected(t *testing.T) {
	c := newTestCache(t, time.Minute, nil)
	c.Put("", sampleEntry())
	if c.Len() != 0 {
		t.Errorf("Put('') stored an entry; Len = %d", c.Len())
	}
}

func TestConcurrentPutTake(t *testing.T) {
	// Spin up many goroutines doing Put + Take pairs on distinct
	// keys. Looks for races (run under -race) and ensures the
	// final Len matches what's expected.
	c := newTestCache(t, time.Minute, nil)
	const N = 100
	var wg sync.WaitGroup
	for i := 0; i < N; i++ {
		wg.Add(1)
		go func(i int) {
			defer wg.Done()
			key := uuid.New().String()
			c.Put(key, sampleEntry())
			if _, err := c.Take(key); err != nil {
				t.Errorf("Take(%s): %v", key, err)
			}
		}(i)
	}
	wg.Wait()
	if c.Len() != 0 {
		t.Errorf("Len after concurrent run = %d, want 0", c.Len())
	}
}

func TestRunJanitorStops(t *testing.T) {
	// Janitor should exit promptly when its context is canceled.
	c := newTestCache(t, time.Minute, nil)
	ctx, cancel := context.WithCancel(context.Background())
	done := make(chan struct{})
	go func() {
		c.RunJanitor(ctx, 10*time.Millisecond)
		close(done)
	}()
	cancel()
	select {
	case <-done:
		// good
	case <-time.After(2 * time.Second):
		t.Fatal("RunJanitor did not exit after ctx cancel")
	}
}

func TestRunJanitorPrunes(t *testing.T) {
	// Drive the janitor with a fast interval and a fake clock; verify
	// expired entries vanish.
	clock := newFakeNow(time.Unix(1000, 0))
	c := newTestCache(t, 100*time.Millisecond, clock)
	c.Put("a", sampleEntry())

	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	go c.RunJanitor(ctx, 10*time.Millisecond)

	// Wait a bit, then advance the cache's clock past the TTL.
	time.Sleep(20 * time.Millisecond)
	clock.advance(200 * time.Millisecond)
	// Give the janitor a few tick cycles to notice.
	deadline := time.Now().Add(2 * time.Second)
	for time.Now().Before(deadline) {
		if c.Len() == 0 {
			return
		}
		time.Sleep(15 * time.Millisecond)
	}
	t.Errorf("janitor did not prune expired entry; Len = %d", c.Len())
}

func TestDefaultTTLApplied(t *testing.T) {
	c := NewCeremonyCache(0)
	if c.ttl != DefaultCeremonyTTL {
		t.Errorf("ttl = %v, want %v", c.ttl, DefaultCeremonyTTL)
	}
}
