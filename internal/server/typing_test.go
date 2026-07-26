package server

// Phase 43-2: the typing rate limiter. It takes its clock as an argument
// precisely so this file needs no database, no WSHandler, and no fake time --
// the properties below are the ones that would be invisible in a live test and
// expensive to get wrong.

import (
	"testing"
	"time"

	"github.com/google/uuid"
)

func TestTypingLimiterFirstPingAllowed(t *testing.T) {
	var l typingLimiter
	if !l.allow(uuid.New(), time.Unix(0, 0)) {
		t.Fatal("first ping for a channel was rejected")
	}
}

func TestTypingLimiterRejectsInsideInterval(t *testing.T) {
	var l typingLimiter
	ch := uuid.New()
	now := time.Unix(1000, 0)
	if !l.allow(ch, now) {
		t.Fatal("first ping rejected")
	}
	if l.allow(ch, now.Add(typingMinInterval-time.Millisecond)) {
		t.Fatal("a ping one millisecond inside the interval was accepted")
	}
	if !l.allow(ch, now.Add(typingMinInterval)) {
		t.Fatal("a ping exactly at the interval boundary was rejected")
	}
}

// A rejected ping must NOT move the clock forward. Otherwise a client that
// re-sends slightly too fast never gets another ping through -- the window
// keeps sliding out from under it.
func TestTypingLimiterRejectionDoesNotStamp(t *testing.T) {
	var l typingLimiter
	ch := uuid.New()
	start := time.Unix(1000, 0)
	l.allow(ch, start)

	// Hammer it well inside the window.
	for i := 1; i <= 5; i++ {
		at := start.Add(time.Duration(i) * 100 * time.Millisecond)
		if l.allow(ch, at) {
			t.Fatalf("ping at +%dms accepted inside the interval", i*100)
		}
	}
	// The window is still measured from the accepted ping, not the last
	// rejected one.
	if !l.allow(ch, start.Add(typingMinInterval)) {
		t.Fatal("rejections pushed the window out; client is now starved")
	}
}

func TestTypingLimiterChannelsAreIndependent(t *testing.T) {
	var l typingLimiter
	a, b := uuid.New(), uuid.New()
	now := time.Unix(1000, 0)
	if !l.allow(a, now) {
		t.Fatal("first ping for channel a rejected")
	}
	if !l.allow(b, now) {
		t.Fatal("channel b was throttled by channel a's ping")
	}
}

// The throttle runs before the membership check, so a client can name channels
// it isn't in -- and channels that don't exist. The map must not grow forever.
func TestTypingLimiterCapsChannelMap(t *testing.T) {
	var l typingLimiter
	now := time.Unix(1000, 0)
	for i := 0; i < typingMaxChannels*3; i++ {
		l.allow(uuid.New(), now)
	}
	l.mu.Lock()
	n := len(l.last)
	l.mu.Unlock()
	if n > typingMaxChannels {
		t.Fatalf("limiter map grew to %d entries, cap is %d", n, typingMaxChannels)
	}
}

// Hitting the cap must not permanently wedge a connection: once the stale
// entries can no longer block anything, they are swept and pings flow again.
func TestTypingLimiterSweepsStaleAtCap(t *testing.T) {
	var l typingLimiter
	now := time.Unix(1000, 0)
	for i := 0; i < typingMaxChannels; i++ {
		l.allow(uuid.New(), now)
	}
	later := now.Add(2 * typingMinInterval)
	if !l.allow(uuid.New(), later) {
		t.Fatal("limiter stayed full after every entry aged out")
	}
}
