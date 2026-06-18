package server

import (
	"context"
	"errors"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/google/uuid"
)

// fakeConn returns a Conn whose closeFn just records the call.
// Phase 09a: assigns a fresh connID alongside the deviceID.
func fakeConn(deviceID string) (*Conn, *atomic.Int32) {
	var calls atomic.Int32
	c := NewConn(uuid.New().String(), deviceID, "", func(error) {
		calls.Add(1)
	})
	return c, &calls
}

// fakeConnWithID is fakeConn but lets the test pin the connID. Used by
// tests that need predictable IDs to assert hub.GetByConnID semantics.
func fakeConnWithID(connID, deviceID string) (*Conn, *atomic.Int32) {
	var calls atomic.Int32
	c := NewConn(connID, deviceID, "", func(error) {
		calls.Add(1)
	})
	return c, &calls
}

func TestHubRegisterAndUnregister(t *testing.T) {
	h := NewHub()
	c1, _ := fakeConn("dev-1")

	h.Register(c1)
	if got := h.Count(); got != 1 {
		t.Fatalf("count: %d", got)
	}
	if h.Get("dev-1") != c1 {
		t.Fatal("Get returned wrong conn")
	}

	h.Unregister(c1)
	if got := h.Count(); got != 0 {
		t.Fatalf("count after unregister: %d", got)
	}
	if h.Get("dev-1") != nil {
		t.Fatal("Get should return nil after unregister")
	}
}

// Phase 09a step 4: same-device_id Register no longer evicts. Two
// conns sharing a deviceID coexist; neither is closed by Register.
// They have distinct Conn.IDs (assigned in step 1) and routing
// goes via byConnID / byUser, so the hub's primary fan-out doesn't
// care about deviceID collisions.
func TestHubRegisterSameDeviceCoexists(t *testing.T) {
	h := NewHub()
	c1, calls1 := fakeConn("dev-1")
	c2, calls2 := fakeConn("dev-1")

	h.Register(c1)
	h.Register(c2)

	// Neither conn should have been closed. Give Register a moment
	// in case any background goroutine were still expected to fire
	// (it shouldn't, but assert hard either way).
	time.Sleep(50 * time.Millisecond)
	if calls1.Load() != 0 {
		t.Fatalf("c1 should not be closed; got %d calls", calls1.Load())
	}
	if calls2.Load() != 0 {
		t.Fatalf("c2 should not be closed; got %d calls", calls2.Load())
	}

	// conns map is "last writer wins" lookup, so Get returns c2.
	if h.Get("dev-1") != c2 {
		t.Fatal("Get(dev-1) should return the most-recently-registered conn")
	}

	// Both conns are reachable via byConnID.
	if h.GetByConnID(c1.ID) != c1 {
		t.Fatal("c1 missing from byConnID after re-register")
	}
	if h.GetByConnID(c2.ID) != c2 {
		t.Fatal("c2 missing from byConnID after re-register")
	}
}

// Phase 09a step 4: when two same-deviceID conns share a userID,
// both end up in the user's set. Fan-out to that user reaches both
// tabs.
func TestHubRegisterSameDeviceSameUserBothInByUser(t *testing.T) {
	h := NewHub()
	c1, _ := fakeConnWithUser("conn-1", "dev-shared", "alice")
	c2, _ := fakeConnWithUser("conn-2", "dev-shared", "alice")
	h.Register(c1)
	h.Register(c2)

	got := h.ConnsForUser("alice")
	if len(got) != 2 {
		t.Fatalf("expected 2 conns for alice, got %d", len(got))
	}
	ids := map[string]bool{got[0].ID: true, got[1].ID: true}
	if !ids["conn-1"] || !ids["conn-2"] {
		t.Fatalf("expected both conn IDs in set, got %v", ids)
	}
}

// Phase 09a step 4: fan-out to a user with two same-deviceID tabs
// reaches both, and the sender-conn exception suppresses the
// sender's tab only.
func TestHubFanOutToUserMultiTab(t *testing.T) {
	h := NewHub()
	sender, _ := fakeConnWithUser("conn-sender", "dev-shared", "alice")
	other, _ := fakeConnWithUser("conn-other", "dev-shared", "alice")
	h.Register(sender)
	h.Register(other)

	h.FanOutToUser("alice", "conn-sender", []byte("echo"))

	select {
	case <-sender.Send:
		t.Fatal("sender tab received its own echo")
	default:
	}
	select {
	case got := <-other.Send:
		if string(got) != "echo" {
			t.Errorf("other tab got %q", got)
		}
	case <-time.After(time.Second):
		t.Fatal("other tab did not receive sender's message")
	}
}

func TestHubUnregisterAfterReregisterIsNoop(t *testing.T) {
	// Phase 09a step 4: c1 and c2 share dev-1 and coexist. The
	// conns map points at c2 (last writer). Unregister(c1) doesn't
	// touch the conns map (cur != c1), so Get(dev-1) still returns
	// c2. This protects the lookup from spurious deletion when
	// an older conn's writeLoop calls Unregister after the user
	// has already opened a newer connection from the same device.
	h := NewHub()
	c1, _ := fakeConn("dev-1")
	c2, _ := fakeConn("dev-1")

	h.Register(c1)
	h.Register(c2)

	h.Unregister(c1)

	if h.Get("dev-1") != c2 {
		t.Fatal("Unregister(c1) must not remove c2 from the conns map")
	}
}

func TestHubBroadcastExcludesSender(t *testing.T) {
	h := NewHub()
	a, _ := fakeConn("a")
	b, _ := fakeConn("b")
	c, _ := fakeConn("c")
	h.Register(a)
	h.Register(b)
	h.Register(c)

	h.Broadcast("a", []byte("hello"))

	// a must NOT receive its own broadcast
	select {
	case <-a.Send:
		t.Fatal("sender received its own broadcast")
	default:
	}

	// b and c must each receive
	for _, conn := range []*Conn{b, c} {
		select {
		case got := <-conn.Send:
			if string(got) != "hello" {
				t.Errorf("%s got %q", conn.DeviceID, got)
			}
		case <-time.After(time.Second):
			t.Fatalf("%s did not receive broadcast", conn.DeviceID)
		}
	}
}

func TestHubBroadcastFreshSkipsConnsRegisteredAfterMessage(t *testing.T) {
	h := NewHub()
	old, _ := fakeConn("old")
	old.CreatedAt = time.Unix(1000, 0) // registered "long ago"
	fresh, _ := fakeConn("fresh")
	fresh.CreatedAt = time.Unix(3000, 0) // registered "later"
	h.Register(old)
	h.Register(fresh)

	// Broadcast a message timestamped between old and fresh -- only old
	// should receive it. fresh joined after this message and is not
	// entitled to live delivery of it.
	msgTS := time.Unix(2000, 0)
	h.BroadcastFresh("nobody", []byte("hello"), msgTS)

	select {
	case got := <-old.Send:
		if string(got) != "hello" {
			t.Errorf("old got %q", got)
		}
	case <-time.After(time.Second):
		t.Fatal("old did not receive a message it should have")
	}

	select {
	case got := <-fresh.Send:
		t.Fatalf("fresh unexpectedly received stale message: %q", got)
	case <-time.After(50 * time.Millisecond):
		// OK -- nothing should arrive
	}
}

func TestHubBroadcastFreshTieGoesToReceiver(t *testing.T) {
	// A conn registered at exactly the message timestamp should still
	// receive: the boundary is exclusive on the "after" side.
	h := NewHub()
	exact, _ := fakeConn("exact")
	exact.CreatedAt = time.Unix(2000, 0)
	h.Register(exact)

	h.BroadcastFresh("nobody", []byte("hello"), time.Unix(2000, 0))

	select {
	case <-exact.Send:
		// expected
	case <-time.After(time.Second):
		t.Fatal("tie case: conn at exactly messageTS did not receive")
	}
}

func TestHubBroadcastFreshStillExcludesSender(t *testing.T) {
	// Sender exclusion still applies even if the sender's CreatedAt is
	// before the messageTS (which it always will be -- you can't send a
	// message before you connect).
	h := NewHub()
	sender, _ := fakeConn("sender")
	sender.CreatedAt = time.Unix(1000, 0)
	other, _ := fakeConn("other")
	other.CreatedAt = time.Unix(1000, 0)
	h.Register(sender)
	h.Register(other)

	h.BroadcastFresh("sender", []byte("hello"), time.Unix(2000, 0))

	select {
	case <-sender.Send:
		t.Fatal("sender received own message under BroadcastFresh")
	default:
	}
	select {
	case <-other.Send:
		// expected
	case <-time.After(time.Second):
		t.Fatal("other did not receive")
	}
}

func TestHubBroadcastSlowClientGetsClosed(t *testing.T) {
	h := NewHub()

	// "slow" has a full send buffer, so it gets closed.
	slow, slowCalls := fakeConn("slow")
	for i := 0; i < sendBufSize; i++ {
		slow.Send <- []byte("fill")
	}
	h.Register(slow)

	// "fast" has space, receives normally.
	fast, _ := fakeConn("fast")
	h.Register(fast)

	h.Broadcast("", []byte("blast"))

	// fast got it
	select {
	case <-fast.Send:
		// ok
	case <-time.After(time.Second):
		t.Fatal("fast did not receive broadcast")
	}

	// slow gets Close called (eventually, since it's go'd).
	deadline := time.Now().Add(time.Second)
	for time.Now().Before(deadline) {
		if slowCalls.Load() >= 1 {
			break
		}
		time.Sleep(10 * time.Millisecond)
	}
	if slowCalls.Load() < 1 {
		t.Fatalf("slow connection should have been closed; calls=%d", slowCalls.Load())
	}
}

func TestConnEnqueueAfterCloseFails(t *testing.T) {
	c, _ := fakeConn("x")
	c.Close(errors.New("test"))
	if err := c.Enqueue([]byte("nope")); err == nil {
		t.Fatal("expected enqueue-after-close to fail")
	}
}

func TestConnCloseIsIdempotent(t *testing.T) {
	c, calls := fakeConn("x")
	c.Close(errors.New("first"))
	c.Close(errors.New("second"))
	c.Close(errors.New("third"))
	if calls.Load() != 1 {
		t.Fatalf("closeFn called %d times, want 1", calls.Load())
	}
}

func TestConnEnqueueFullReturnsErrSendFull(t *testing.T) {
	c, _ := fakeConn("x")
	for i := 0; i < sendBufSize; i++ {
		if err := c.Enqueue([]byte("fill")); err != nil {
			t.Fatalf("fill[%d]: %v", i, err)
		}
	}
	err := c.Enqueue([]byte("overflow"))
	if !errors.Is(err, ErrSendFull) {
		t.Fatalf("expected ErrSendFull, got %v", err)
	}
}

// Race regression test: many goroutines registering/unregistering/broadcasting
// concurrently must not deadlock or trigger -race warnings.
func TestHubConcurrencyRace(t *testing.T) {
	h := NewHub()
	const N = 50
	var wg sync.WaitGroup

	// Register N conns
	conns := make([]*Conn, N)
	for i := 0; i < N; i++ {
		c, _ := fakeConn(string(rune('a'+(i%26))) + string(rune('a'+(i/26))))
		conns[i] = c
		// Drain Send so Enqueue keeps space
		go func(c *Conn) {
			for {
				select {
				case <-c.Send:
				case <-c.closed:
					return
				}
			}
		}(c)
	}
	for _, c := range conns {
		wg.Add(1)
		go func(c *Conn) {
			defer wg.Done()
			h.Register(c)
		}(c)
	}
	wg.Wait()

	// Concurrent broadcasts + counts
	for i := 0; i < 100; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			h.Broadcast("", []byte("ping"))
			_ = h.Count()
		}()
	}
	wg.Wait()

	// Unregister all
	for _, c := range conns {
		wg.Add(1)
		go func(c *Conn) {
			defer wg.Done()
			h.Unregister(c)
			c.Close(nil)
		}(c)
	}
	wg.Wait()

	if h.Count() != 0 {
		t.Errorf("expected hub empty, got %d", h.Count())
	}
}

// ---- Phase 09a step 1 tests --------------------------------------------
// The Hub keeps a parallel byConnID index. Production code does not yet
// read it (step 2 will), but the tests below verify it stays consistent
// with the device_id-keyed map under register/unregister/close.

func TestHubByConnIDRegisterAndUnregister(t *testing.T) {
	h := NewHub()
	c, _ := fakeConnWithID("conn-1", "dev-1")

	h.Register(c)
	if got := h.GetByConnID("conn-1"); got != c {
		t.Fatalf("GetByConnID after register: got %v, want %v", got, c)
	}
	// Sanity: legacy lookup still works.
	if got := h.Get("dev-1"); got != c {
		t.Fatalf("Get(deviceID) after register: got %v, want %v", got, c)
	}

	h.Unregister(c)
	if got := h.GetByConnID("conn-1"); got != nil {
		t.Fatalf("GetByConnID after unregister: got %v, want nil", got)
	}
	if got := h.Get("dev-1"); got != nil {
		t.Fatalf("Get(deviceID) after unregister: got %v, want nil", got)
	}
}

func TestHubByConnIDIsPerConnNotPerDevice(t *testing.T) {
	// Two conns from the same device get different connIDs. As of
	// phase 09a step 4 they coexist in the hub: there is no
	// eviction. The byConnID map contains both.
	h := NewHub()
	c1, _ := fakeConnWithID("conn-1", "dev-shared")
	c2, _ := fakeConnWithID("conn-2", "dev-shared")

	h.Register(c1)
	h.Register(c2)

	if got := h.GetByConnID("conn-1"); got != c1 {
		t.Fatalf("c1 should be in byConnID: got %v", got)
	}
	if got := h.GetByConnID("conn-2"); got != c2 {
		t.Fatalf("c2 should be in byConnID: got %v", got)
	}
}

func TestHubByConnIDStaleUnregisterIsNoop(t *testing.T) {
	// Unregister(c1) removes c1 from byConnID and removes c1 from
	// the conns map iff conns[c1.DeviceID] still points at c1.
	// Since c2 was registered second under the same deviceID, the
	// conns map points at c2 -- so the deviceID-keyed delete in
	// Unregister(c1) no-ops, leaving conns[dev-shared] == c2.
	// byConnID["conn-1"] is deleted; byConnID["conn-2"] survives.
	h := NewHub()
	c1, _ := fakeConnWithID("conn-1", "dev-shared")
	c2, _ := fakeConnWithID("conn-2", "dev-shared")

	h.Register(c1)
	h.Register(c2)

	h.Unregister(c1)

	if got := h.GetByConnID("conn-2"); got != c2 {
		t.Fatalf("Unregister(c1) removed c2 from byConnID: got %v", got)
	}
	if got := h.GetByConnID("conn-1"); got != nil {
		t.Fatalf("Unregister(c1) left c1 in byConnID: got %v", got)
	}
	if got := h.Get("dev-shared"); got != c2 {
		t.Fatalf("Unregister(c1) removed c2 from conns: got %v", got)
	}
}

func TestHubCloseAllClearsByConnID(t *testing.T) {
	h := NewHub()
	conns := make([]*Conn, 3)
	for i := range conns {
		c, _ := fakeConnWithID("conn-"+string(rune('a'+i)), "dev-"+string(rune('a'+i)))
		// Drain Send so Close doesn't block any internal teardown.
		go func(c *Conn) {
			for {
				select {
				case <-c.Send:
				case <-c.closed:
					return
				}
			}
		}(c)
		h.Register(c)
		conns[i] = c
	}

	ctx, cancel := contextBackgroundFor(t, time.Second)
	defer cancel()
	h.CloseAll(ctx, errors.New("shutdown"))

	for i := range conns {
		id := "conn-" + string(rune('a'+i))
		if got := h.GetByConnID(id); got != nil {
			t.Fatalf("CloseAll left %s in byConnID: %v", id, got)
		}
	}
	if h.Count() != 0 {
		t.Fatalf("conns map not empty after CloseAll: %d", h.Count())
	}
}

func TestHubEmptyConnIDIsNotIndexed(t *testing.T) {
	// Backward-compat path: callers that pass id="" should not crash
	// or accidentally collide in byConnID. The conn still registers
	// in the deviceID map; byConnID just doesn't get an entry.
	h := NewHub()
	c, _ := fakeConnWithID("", "dev-1")

	h.Register(c)

	if got := h.Get("dev-1"); got != c {
		t.Fatal("conn with empty ID should still register in deviceID map")
	}
	if got := h.GetByConnID(""); got != nil {
		t.Fatalf("empty-ID lookup should return nil, got %v", got)
	}

	h.Unregister(c)
	if h.Count() != 0 {
		t.Fatal("unregister should still work for empty-ID conn")
	}
}

// contextBackgroundFor mirrors context.WithTimeout but with a
// failure-on-expiration t.Fatalf so tests don't hang on regression.
func contextBackgroundFor(t *testing.T, d time.Duration) (ctx context.Context, cancel func()) {
	t.Helper()
	ctx, cancel = context.WithTimeout(context.Background(), d)
	return
}

// ---- Phase 09a step 2 tests --------------------------------------------
// Hub gains a byUser index keyed by userID, each entry holding a
// userConnSet keyed by Conn.ID. Production code in 09a does not yet
// read this; step 3 will. These tests prove the new index stays
// consistent with the device_id and byConnID maps under
// register / unregister / supersede / multi-user / close-all /
// anonymous (UserID=="").

func fakeConnWithUser(connID, deviceID, userID string) (*Conn, *atomic.Int32) {
	var calls atomic.Int32
	c := NewConn(connID, deviceID, userID, func(error) {
		calls.Add(1)
	})
	return c, &calls
}

func TestHubByUserRegisterAndUnregister(t *testing.T) {
	h := NewHub()
	c, _ := fakeConnWithUser("conn-1", "dev-1", "alice")

	h.Register(c)

	got := h.ConnsForUser("alice")
	if len(got) != 1 || got[0] != c {
		t.Fatalf("ConnsForUser(alice) after register: got %v, want [c]", got)
	}
	if h.CountUsers() != 1 {
		t.Fatalf("CountUsers after register: got %d, want 1", h.CountUsers())
	}

	h.Unregister(c)

	if got := h.ConnsForUser("alice"); len(got) != 0 {
		t.Fatalf("ConnsForUser(alice) after unregister: got %v, want []", got)
	}
	if h.CountUsers() != 0 {
		t.Fatalf("CountUsers after unregister: got %d, want 0", h.CountUsers())
	}
}

func TestHubByUserTwoTabsSameUser(t *testing.T) {
	// Two conns from same user with DIFFERENT deviceIDs and conn IDs
	// (e.g. user has chalk open on phone AND laptop). Both should be
	// in alice's set.
	h := NewHub()
	c1, _ := fakeConnWithUser("conn-1", "phone", "alice")
	c2, _ := fakeConnWithUser("conn-2", "laptop", "alice")
	h.Register(c1)
	h.Register(c2)

	got := h.ConnsForUser("alice")
	if len(got) != 2 {
		t.Fatalf("ConnsForUser(alice): got %d conns, want 2", len(got))
	}
	// Order is map iteration order; check both are present by ID.
	gotIDs := map[string]bool{}
	for _, c := range got {
		gotIDs[c.ID] = true
	}
	if !gotIDs["conn-1"] || !gotIDs["conn-2"] {
		t.Fatalf("expected both conn IDs in set, got %v", gotIDs)
	}
}

func TestHubByUserDifferentUsers(t *testing.T) {
	h := NewHub()
	a, _ := fakeConnWithUser("a-conn", "a-dev", "alice")
	b, _ := fakeConnWithUser("b-conn", "b-dev", "bob")
	h.Register(a)
	h.Register(b)

	if h.CountUsers() != 2 {
		t.Fatalf("CountUsers: got %d, want 2", h.CountUsers())
	}
	aliceConns := h.ConnsForUser("alice")
	bobConns := h.ConnsForUser("bob")
	if len(aliceConns) != 1 || aliceConns[0] != a {
		t.Fatalf("alice set wrong: %v", aliceConns)
	}
	if len(bobConns) != 1 || bobConns[0] != b {
		t.Fatalf("bob set wrong: %v", bobConns)
	}
}

func TestHubByUserUnregisterOneLeavesOther(t *testing.T) {
	h := NewHub()
	c1, _ := fakeConnWithUser("conn-1", "phone", "alice")
	c2, _ := fakeConnWithUser("conn-2", "laptop", "alice")
	h.Register(c1)
	h.Register(c2)

	h.Unregister(c1)

	got := h.ConnsForUser("alice")
	if len(got) != 1 || got[0] != c2 {
		t.Fatalf("after unregister c1: want [c2], got %v", got)
	}
	if h.CountUsers() != 1 {
		t.Fatalf("CountUsers: got %d, want 1", h.CountUsers())
	}
}

func TestHubByUserUnregisterLastDropsSet(t *testing.T) {
	// When the last conn for a user is unregistered, the userConnSet
	// itself should be removed from byUser (so CountUsers reflects
	// "users with active conns" rather than "users we've ever seen").
	h := NewHub()
	c, _ := fakeConnWithUser("conn-1", "dev-1", "alice")
	h.Register(c)
	if h.CountUsers() != 1 {
		t.Fatalf("setup: CountUsers=%d", h.CountUsers())
	}
	h.Unregister(c)
	if h.CountUsers() != 0 {
		t.Fatalf("CountUsers after final unregister: got %d, want 0", h.CountUsers())
	}
	// Idempotent: a second Unregister of the same conn must not panic
	// (the userConnSet was already removed; the byUser lookup misses).
	h.Unregister(c)
	if h.CountUsers() != 0 {
		t.Fatalf("CountUsers after second unregister: got %d, want 0", h.CountUsers())
	}
}

func TestHubByUserSameDeviceSameUserCoexists(t *testing.T) {
	// Phase 09a step 4: two conns sharing deviceID and userID
	// (two browser tabs of the same user on the same device)
	// coexist in the hub. byUser[alice] contains both.
	h := NewHub()
	c1, _ := fakeConnWithUser("conn-1", "dev-shared", "alice")
	c2, _ := fakeConnWithUser("conn-2", "dev-shared", "alice")
	h.Register(c1)
	h.Register(c2)

	got := h.ConnsForUser("alice")
	if len(got) != 2 {
		t.Fatalf("want 2 conns for alice, got %d", len(got))
	}
	ids := map[string]bool{got[0].ID: true, got[1].ID: true}
	if !ids["conn-1"] || !ids["conn-2"] {
		t.Fatalf("expected both conn IDs, got %v", ids)
	}
}

func TestHubByUserAnonymousNotIndexed(t *testing.T) {
	// Conns with UserID=="" exist in conns + byConnID but never in
	// byUser. They're "anonymous" -- still present on the hub for
	// broadcast purposes, but not addressable by user.
	h := NewHub()
	c, _ := fakeConnWithUser("conn-1", "dev-1", "")
	h.Register(c)

	if h.CountUsers() != 0 {
		t.Fatalf("anonymous conn should not increment CountUsers: got %d", h.CountUsers())
	}
	if got := h.ConnsForUser(""); got != nil {
		t.Fatalf("ConnsForUser(\"\") should return nil, got %v", got)
	}
	// Sanity: the conn is still in the legacy maps.
	if h.Get("dev-1") != c {
		t.Fatal("anonymous conn missing from deviceID map")
	}
	if h.GetByConnID("conn-1") != c {
		t.Fatal("anonymous conn missing from byConnID map")
	}

	h.Unregister(c)
	if h.Count() != 0 {
		t.Fatal("unregister failed for anonymous conn")
	}
}

func TestHubByUserUnregisterOneOfTwoLeavesOther(t *testing.T) {
	// Two conns same (deviceID, userID). Unregister one; the other
	// remains in byUser.
	h := NewHub()
	c1, _ := fakeConnWithUser("conn-1", "dev-shared", "alice")
	c2, _ := fakeConnWithUser("conn-2", "dev-shared", "alice")
	h.Register(c1)
	h.Register(c2)

	h.Unregister(c1)

	got := h.ConnsForUser("alice")
	if len(got) != 1 || got[0] != c2 {
		t.Fatalf("after Unregister(c1): want [c2], got %v", got)
	}
}

func TestHubCloseAllClearsByUser(t *testing.T) {
	h := NewHub()
	users := []string{"alice", "bob", "carol"}
	conns := make([]*Conn, len(users))
	for i, u := range users {
		c, _ := fakeConnWithUser("conn-"+u, "dev-"+u, u)
		go func(c *Conn) {
			for {
				select {
				case <-c.Send:
				case <-c.closed:
					return
				}
			}
		}(c)
		h.Register(c)
		conns[i] = c
	}
	if h.CountUsers() != 3 {
		t.Fatalf("setup: CountUsers=%d", h.CountUsers())
	}

	ctx, cancel := contextBackgroundFor(t, time.Second)
	defer cancel()
	h.CloseAll(ctx, errors.New("shutdown"))

	if h.CountUsers() != 0 {
		t.Fatalf("CloseAll left %d users in byUser", h.CountUsers())
	}
	for _, u := range users {
		if got := h.ConnsForUser(u); got != nil && len(got) != 0 {
			t.Fatalf("CloseAll left conns for %s: %v", u, got)
		}
	}
}

func TestHubConnsForUserSnapshotIndependentOfHub(t *testing.T) {
	// The slice returned by ConnsForUser is a snapshot. A
	// subsequent Unregister must not mutate the returned slice.
	h := NewHub()
	c1, _ := fakeConnWithUser("conn-1", "phone", "alice")
	c2, _ := fakeConnWithUser("conn-2", "laptop", "alice")
	h.Register(c1)
	h.Register(c2)

	snap := h.ConnsForUser("alice")
	if len(snap) != 2 {
		t.Fatalf("setup: snap=%d", len(snap))
	}

	h.Unregister(c1)

	// snap should still hold 2 references.
	if len(snap) != 2 {
		t.Fatalf("snapshot mutated after Unregister: len=%d", len(snap))
	}
}

// ---- Phase 09a step 3 tests --------------------------------------------
// FanOutFresh, FanOutToUser, FanOutToUserFresh exercise the new
// echo-suppression-by-connID + per-user routing semantics. The old
// Broadcast/BroadcastFresh tests above still pass to prove backwards
// compatibility.

func TestHubFanOutFreshExcludesByConnID(t *testing.T) {
	h := NewHub()
	// Two conns with different connIDs; "sender" should not see its
	// own message; "other" should.
	sender, _ := fakeConnWithID("conn-sender", "dev-sender")
	other, _ := fakeConnWithID("conn-other", "dev-other")
	h.Register(sender)
	h.Register(other)

	h.FanOutFresh("conn-sender", []byte("hello"), time.Now())

	select {
	case <-sender.Send:
		t.Fatal("sender received its own message under FanOutFresh")
	default:
	}
	select {
	case got := <-other.Send:
		if string(got) != "hello" {
			t.Errorf("other got %q", got)
		}
	case <-time.After(time.Second):
		t.Fatal("other did not receive")
	}
}

func TestHubFanOutFreshEmptyExceptDeliversToAll(t *testing.T) {
	// Empty exceptConnID is a valid "deliver to everyone" signal,
	// for cross-instance traffic where the local conn is not the
	// originator.
	h := NewHub()
	a, _ := fakeConnWithID("conn-a", "dev-a")
	b, _ := fakeConnWithID("conn-b", "dev-b")
	h.Register(a)
	h.Register(b)

	h.FanOutFresh("", []byte("global"), time.Now())

	for _, c := range []*Conn{a, b} {
		select {
		case got := <-c.Send:
			if string(got) != "global" {
				t.Errorf("%s got %q", c.DeviceID, got)
			}
		case <-time.After(time.Second):
			t.Fatalf("%s did not receive", c.DeviceID)
		}
	}
}

func TestHubFanOutFreshSkipsStale(t *testing.T) {
	// Same fresh-filter semantics as BroadcastFresh, but with
	// connID-keyed exception.
	h := NewHub()
	old, _ := fakeConnWithID("conn-old", "dev-old")
	old.CreatedAt = time.Unix(1000, 0)
	fresh, _ := fakeConnWithID("conn-fresh", "dev-fresh")
	fresh.CreatedAt = time.Unix(3000, 0)
	h.Register(old)
	h.Register(fresh)

	h.FanOutFresh("", []byte("hello"), time.Unix(2000, 0))

	select {
	case <-old.Send:
		// expected
	case <-time.After(time.Second):
		t.Fatal("old did not receive a message it should have")
	}
	select {
	case got := <-fresh.Send:
		t.Fatalf("fresh received stale message: %q", got)
	case <-time.After(50 * time.Millisecond):
		// OK
	}
}

func TestHubFanOutToUserSendsOnlyToUser(t *testing.T) {
	// alice has two conns; bob has one. FanOutToUser("alice") should
	// reach both alice conns and not bob.
	h := NewHub()
	a1, _ := fakeConnWithUser("conn-a1", "dev-phone", "alice")
	a2, _ := fakeConnWithUser("conn-a2", "dev-laptop", "alice")
	b, _ := fakeConnWithUser("conn-b", "dev-bob", "bob")
	h.Register(a1)
	h.Register(a2)
	h.Register(b)

	h.FanOutToUser("alice", "", []byte("for alice"))

	for _, c := range []*Conn{a1, a2} {
		select {
		case got := <-c.Send:
			if string(got) != "for alice" {
				t.Errorf("%s got %q", c.ID, got)
			}
		case <-time.After(time.Second):
			t.Fatalf("alice's conn %s did not receive", c.ID)
		}
	}
	select {
	case got := <-b.Send:
		t.Fatalf("bob received a message for alice: %q", got)
	case <-time.After(50 * time.Millisecond):
		// OK
	}
}

func TestHubFanOutToUserExceptConnID(t *testing.T) {
	// alice's two tabs (same deviceID, distinct connIDs):
	// exceptConnID suppresses the sender's tab; the other tab
	// receives.
	h := NewHub()
	sender, _ := fakeConnWithUser("conn-sender", "dev-shared", "alice")
	other, _ := fakeConnWithUser("conn-other", "dev-shared", "alice")
	h.Register(sender)
	h.Register(other)

	h.FanOutToUser("alice", "conn-sender", []byte("echo"))

	select {
	case <-sender.Send:
		t.Fatal("sender's conn received its own echo")
	default:
	}
	select {
	case got := <-other.Send:
		if string(got) != "echo" {
			t.Errorf("other tab got %q", got)
		}
	case <-time.After(time.Second):
		t.Fatal("other tab did not receive")
	}
}

func TestHubFanOutToUserNoOpForUnknownUser(t *testing.T) {
	h := NewHub()
	a, _ := fakeConnWithUser("conn-a", "dev-a", "alice")
	h.Register(a)

	// Should not panic, not block, not deliver to anyone.
	h.FanOutToUser("nobody", "", []byte("ghost"))

	select {
	case got := <-a.Send:
		t.Fatalf("alice received message addressed to 'nobody': %q", got)
	case <-time.After(50 * time.Millisecond):
		// OK
	}
}

func TestHubFanOutToUserEmptyUserIDIsNoOp(t *testing.T) {
	// Defensive: empty userID never delivers, even if anonymous
	// conns exist on the hub.
	h := NewHub()
	anon, _ := fakeConnWithUser("conn-anon", "dev-anon", "")
	h.Register(anon)

	h.FanOutToUser("", "", []byte("nope"))

	select {
	case got := <-anon.Send:
		t.Fatalf("anonymous conn received empty-user-target message: %q", got)
	case <-time.After(50 * time.Millisecond):
		// OK
	}
}

func TestHubFanOutToUserFreshSkipsStale(t *testing.T) {
	// Same combination: per-user fan-out plus fresh filter.
	h := NewHub()
	old, _ := fakeConnWithUser("conn-old", "dev-old", "alice")
	old.CreatedAt = time.Unix(1000, 0)
	fresh, _ := fakeConnWithUser("conn-fresh", "dev-fresh", "alice")
	fresh.CreatedAt = time.Unix(3000, 0)
	h.Register(old)
	h.Register(fresh)

	h.FanOutToUserFresh("alice", "", []byte("hello"), time.Unix(2000, 0))

	select {
	case <-old.Send:
		// expected
	case <-time.After(time.Second):
		t.Fatal("old conn did not receive")
	}
	select {
	case got := <-fresh.Send:
		t.Fatalf("fresh conn received stale message: %q", got)
	case <-time.After(50 * time.Millisecond):
		// OK
	}
}

func TestHubFanOutToUserFreshCombinesExceptAndFresh(t *testing.T) {
	// Three conns for alice:
	//   - sender (conn-sender, old)        -- exception triggers; no delivery
	//   - witness (conn-witness, old)      -- delivery
	//   - latecomer (conn-latecomer, new)  -- stale filter; no delivery
	h := NewHub()
	sender, _ := fakeConnWithUser("conn-sender", "dev-a", "alice")
	sender.CreatedAt = time.Unix(1000, 0)
	witness, _ := fakeConnWithUser("conn-witness", "dev-b", "alice")
	witness.CreatedAt = time.Unix(1000, 0)
	latecomer, _ := fakeConnWithUser("conn-latecomer", "dev-c", "alice")
	latecomer.CreatedAt = time.Unix(3000, 0)
	h.Register(sender)
	h.Register(witness)
	h.Register(latecomer)

	h.FanOutToUserFresh("alice", "conn-sender", []byte("msg"), time.Unix(2000, 0))

	select {
	case <-sender.Send:
		t.Fatal("sender received its own message")
	default:
	}
	select {
	case got := <-witness.Send:
		if string(got) != "msg" {
			t.Errorf("witness got %q", got)
		}
	case <-time.After(time.Second):
		t.Fatal("witness did not receive")
	}
	select {
	case got := <-latecomer.Send:
		t.Fatalf("latecomer received stale message: %q", got)
	case <-time.After(50 * time.Millisecond):
		// OK
	}
}

// ---- Phase 09a step 5 regression test ---------------------------------
// FanOutFresh must iterate every conn, even when multiple share a
// deviceID. Pre-step-4 the conns map was 1:1 with deviceIDs (eviction
// guaranteed uniqueness) so iterating conns reached every conn.
// Post-step-4 the conns map is "last writer wins" and misses
// duplicates -- FanOutFresh now iterates byConnID.

func TestHubFanOutFreshReachesAllSameDeviceConns(t *testing.T) {
	// Two conns sharing deviceID (multi-tab). FanOutFresh from neither
	// of their connIDs should reach BOTH conns.
	h := NewHub()
	a, _ := fakeConnWithID("conn-a", "dev-shared")
	b, _ := fakeConnWithID("conn-b", "dev-shared")
	h.Register(a)
	h.Register(b)

	h.FanOutFresh("", []byte("global"), time.Now())

	for _, c := range []*Conn{a, b} {
		select {
		case got := <-c.Send:
			if string(got) != "global" {
				t.Errorf("%s got %q", c.ID, got)
			}
		case <-time.After(time.Second):
			t.Fatalf("conn %s did not receive (FanOutFresh missed a same-deviceID conn)", c.ID)
		}
	}
}

func TestHubFanOutFreshExcludesByConnIDWithSameDevice(t *testing.T) {
	// Two same-device conns; exclude conn-a only. conn-b receives.
	h := NewHub()
	a, _ := fakeConnWithID("conn-a", "dev-shared")
	b, _ := fakeConnWithID("conn-b", "dev-shared")
	h.Register(a)
	h.Register(b)

	h.FanOutFresh("conn-a", []byte("for-b"), time.Now())

	select {
	case <-a.Send:
		t.Fatal("conn-a received message it should have been excluded from")
	default:
	}
	select {
	case got := <-b.Send:
		if string(got) != "for-b" {
			t.Errorf("conn-b got %q", got)
		}
	case <-time.After(time.Second):
		t.Fatal("conn-b did not receive")
	}
}
