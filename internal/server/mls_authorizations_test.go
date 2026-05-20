package server

import (
	"testing"
	"time"
)

// fakeClock returns time.Now() values that advance only when the
// test explicitly calls advance(). Lets us test TTL behavior
// without sleeping in real time.
type fakeClock struct {
	t time.Time
}

func newFakeClock() *fakeClock {
	return &fakeClock{t: time.Date(2026, 5, 28, 12, 0, 0, 0, time.UTC)}
}

func (c *fakeClock) now() time.Time {
	return c.t
}

func (c *fakeClock) advance(d time.Duration) {
	c.t = c.t.Add(d)
}

// newTestStore returns a store wired to a fakeClock so we can drive
// TTL deterministically.
func newTestStore() (*MlsAuthorizationStore, *fakeClock) {
	clk := newFakeClock()
	s := &MlsAuthorizationStore{
		entries: make(map[authKey]time.Time),
		ttl:     60 * time.Second,
		now:     clk.now,
	}
	return s, clk
}

func TestPhase11c1_MlsAuth_RecordThenConsume(t *testing.T) {
	s, _ := newTestStore()
	s.Record("ch-1", "bob", AuthKindAdd)
	if !s.Consume("ch-1", "bob", AuthKindAdd) {
		t.Error("Consume should return true for a fresh Record")
	}
	// Second Consume returns false (single-use).
	if s.Consume("ch-1", "bob", AuthKindAdd) {
		t.Error("second Consume should return false (entry already consumed)")
	}
	if s.Len() != 0 {
		t.Errorf("Len() = %d after consume, want 0", s.Len())
	}
}

func TestPhase11c1_MlsAuth_ConsumeWithoutRecord(t *testing.T) {
	s, _ := newTestStore()
	if s.Consume("ch-1", "bob", AuthKindAdd) {
		t.Error("Consume on empty store should return false")
	}
}

func TestPhase11c1_MlsAuth_KindIsolation(t *testing.T) {
	// AuthKindAdd for bob does NOT authorize AuthKindRemove for bob.
	s, _ := newTestStore()
	s.Record("ch-1", "bob", AuthKindAdd)
	if s.Consume("ch-1", "bob", AuthKindRemove) {
		t.Error("AuthKindAdd should not be consumable as AuthKindRemove")
	}
	// The original add authorization is still there.
	if !s.Consume("ch-1", "bob", AuthKindAdd) {
		t.Error("AuthKindAdd should still be consumable after failed Remove consume")
	}
}

func TestPhase11c1_MlsAuth_ChannelIsolation(t *testing.T) {
	// Adding bob to ch-1 does NOT authorize adding bob to ch-2.
	s, _ := newTestStore()
	s.Record("ch-1", "bob", AuthKindAdd)
	if s.Consume("ch-2", "bob", AuthKindAdd) {
		t.Error("authorization for ch-1 should not work for ch-2")
	}
}

func TestPhase11c1_MlsAuth_TargetIsolation(t *testing.T) {
	// Adding bob does NOT authorize adding carol.
	s, _ := newTestStore()
	s.Record("ch-1", "bob", AuthKindAdd)
	if s.Consume("ch-1", "carol", AuthKindAdd) {
		t.Error("authorization for bob should not work for carol")
	}
}

func TestPhase11c1_MlsAuth_TTLExpiry(t *testing.T) {
	s, clk := newTestStore()
	s.Record("ch-1", "bob", AuthKindAdd)
	// Just under TTL: still valid.
	clk.advance(59 * time.Second)
	if !s.Consume("ch-1", "bob", AuthKindAdd) {
		t.Error("Consume at 59s should succeed (TTL is 60s)")
	}
	// Fresh record, advance past TTL.
	s.Record("ch-1", "bob", AuthKindAdd)
	clk.advance(61 * time.Second)
	if s.Consume("ch-1", "bob", AuthKindAdd) {
		t.Error("Consume at 61s should fail (TTL expired)")
	}
	// Expired entry was cleaned up.
	if s.Len() != 0 {
		t.Errorf("Len() = %d after expired Consume, want 0", s.Len())
	}
}

func TestPhase11c1_MlsAuth_RecordOverwrites(t *testing.T) {
	// Two consecutive Record calls -> the second replaces the first.
	// We test this by advancing the clock past the first Record but
	// not past the second: the entry should be consumable, proving
	// the timestamp was bumped by the second Record.
	s, clk := newTestStore()
	s.Record("ch-1", "bob", AuthKindAdd)
	clk.advance(30 * time.Second)
	s.Record("ch-1", "bob", AuthKindAdd) // overwrites timestamp
	clk.advance(45 * time.Second)         // now 75s past first, 45s past second
	if !s.Consume("ch-1", "bob", AuthKindAdd) {
		t.Error("Consume should succeed: second Record bumped the TTL window")
	}
}

func TestPhase11c1_MlsAuth_Sweep(t *testing.T) {
	s, clk := newTestStore()
	s.Record("ch-1", "bob", AuthKindAdd)
	s.Record("ch-1", "carol", AuthKindAdd)
	s.Record("ch-2", "bob", AuthKindRemove)
	if s.Len() != 3 {
		t.Fatalf("Len() = %d before advance, want 3", s.Len())
	}
	clk.advance(70 * time.Second)
	// Add one fresh after the sweep window so we can verify it isn't
	// swept.
	s.Record("ch-3", "dave", AuthKindAdd)

	removed := s.Sweep()
	if removed != 3 {
		t.Errorf("Sweep removed %d entries, want 3", removed)
	}
	if s.Len() != 1 {
		t.Errorf("Len() = %d after sweep, want 1 (the fresh dave entry)", s.Len())
	}
	if !s.Consume("ch-3", "dave", AuthKindAdd) {
		t.Error("fresh entry should still be consumable after sweep")
	}
}

// Concurrent stress test: spin up N goroutines each doing
// Record+Consume on independent keys; verify no panic and final
// state is consistent.
func TestPhase11c1_MlsAuth_Concurrent(t *testing.T) {
	s := NewMlsAuthorizationStore()
	const N = 100
	done := make(chan struct{}, N)
	for i := 0; i < N; i++ {
		go func(i int) {
			defer func() { done <- struct{}{} }()
			ch := "ch-" + itoaPad(i)
			tgt := "tgt-" + itoaPad(i)
			s.Record(ch, tgt, AuthKindAdd)
			if !s.Consume(ch, tgt, AuthKindAdd) {
				t.Errorf("goroutine %d: Consume should succeed", i)
			}
		}(i)
	}
	for i := 0; i < N; i++ {
		<-done
	}
	if s.Len() != 0 {
		t.Errorf("Len() = %d after concurrent Record/Consume, want 0", s.Len())
	}
}

// itoaPad is a tiny helper for the concurrent test; we don't want to
// depend on strconv in a test that only needs to produce distinct
// strings.
func itoaPad(n int) string {
	if n == 0 {
		return "0"
	}
	var buf [20]byte
	i := len(buf)
	for n > 0 {
		i--
		buf[i] = byte('0' + n%10)
		n /= 10
	}
	return string(buf[i:])
}
