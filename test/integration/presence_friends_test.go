package integration

// Phase 06 integration tests.
//
// Three test functions, each invokable separately so the bootstrap phase
// script can run the happy-path tests against two live chalkds, then
// SIGKILL chalkd #1, then run the janitor reap test against chalkd #2
// alone:
//
//   TestPhase06_FriendRequestAccept       -- needs HTTP_1 + HTTP_2
//   TestPhase06_PresenceAggregation       -- needs HTTP_1 + HTTP_2
//   TestPhase06_JanitorReapsCrashedInstance
//                                         -- needs HTTP_2 only; injects
//                                            its own zombie state and
//                                            watches the janitor reap
//
// All three skip cleanly if CHALK_TEST_HTTP_N / CHALK_TEST_PGURL env
// vars aren't set (so plain `go test ./...` from a fresh checkout works).
//
// Setup ensures the three canonical users (alice/bob/carol) exist with
// status='active' (idempotent on top of pg_seed_users) and truncates
// phase-06 dynamic state (friendships, presence rows, subscription
// rows, phase-06-test device rows) so each test starts clean.

import (
	"context"
	"encoding/json"
	"os"
	"strconv"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/coder/websocket"
	"github.com/google/uuid"

	"github.com/scuq/chalk/internal/proto"
	"github.com/scuq/chalk/internal/store"
)

const (
	aliceUserID = "00000000-0000-0000-0000-00000000a11c"
	bobUserID   = "00000000-0000-0000-0000-000000000b0b"
	carolUserID = "00000000-0000-0000-0000-0000000ca201"
)

// --- shared env / setup helpers ---------------------------------------

// httpEnvN returns CHALK_TEST_HTTP_N, skipping if unset.
func httpEnvN(t *testing.T, n int) string {
	t.Helper()
	v := os.Getenv("CHALK_TEST_HTTP_" + strconv.Itoa(n))
	if v == "" {
		t.Skipf("CHALK_TEST_HTTP_%d not set; run via bootstrap", n)
	}
	return v
}

// setupPhase06 connects via the existing openStore helper, ensures the
// three users have status='active' (in case prior tests transitioned
// them, though phase 06 has no write path for that yet), and truncates
// phase-06 dynamic state. Returns the Store; cleanup is registered via
// t.Cleanup() inside openStore.
func setupPhase06(t *testing.T) *store.Store {
	t.Helper()
	st := openStore(t) // from helper_test.go

	c, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()

	// Ensure users exist with status='active'. pg_seed_users seeds them
	// without status (the DEFAULT 'active' kicks in via migration 0006).
	// We re-assert here so the test is independent of execution order.
	if _, err := st.Pool.Exec(c,
		`UPDATE users SET status = 'active', status_reason = NULL
		   WHERE id = ANY($1)`,
		[]uuid.UUID{
			uuid.MustParse(aliceUserID),
			uuid.MustParse(bobUserID),
			uuid.MustParse(carolUserID),
		},
	); err != nil {
		t.Fatalf("reset user status: %v", err)
	}

	// Truncate phase-06 dynamic state. Order matters for FKs.
	stmts := []string{
		`DELETE FROM presence_subscriptions`,
		`DELETE FROM device_presence`,
		`DELETE FROM friendships`,
		`DELETE FROM devices WHERE device_label LIKE 'phase-06-test%'`,
	}
	for _, s := range stmts {
		if _, err := st.Pool.Exec(c, s); err != nil {
			t.Fatalf("truncate %q: %v", s, err)
		}
	}
	return st
}

// seedDeviceForUser inserts a device row owned by userID. Used to
// prepare bob's device(s) before bob connects, so the server's
// `lookupUserForDevice` resolves to bob, not alice. (The phase-06
// ensureDeviceForTesting shim hardcodes alice; bob's row must exist
// with bob as owner BEFORE the WS connect.)
func seedDeviceForUser(t *testing.T, st *store.Store, userID, label string) string {
	t.Helper()
	devID := uuid.New()
	c, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	_, err := st.Pool.Exec(c,
		`INSERT INTO devices (id, user_id, device_type, device_label)
		 VALUES ($1, $2, 'desktop', $3)`,
		devID, uuid.MustParse(userID), label,
	)
	if err != nil {
		t.Fatalf("seed device for %s: %v", userID, err)
	}
	return devID.String()
}

// orderUUIDs returns the two UUIDs in lexicographic byte order.
// Mirrors internal/friends/store.go's orderPair; we duplicate the
// trivial logic here so the test doesn't pull friends as a dependency.
func orderUUIDs(a, b string) (uuid.UUID, uuid.UUID) {
	ua := uuid.MustParse(a)
	ub := uuid.MustParse(b)
	for i := 0; i < 16; i++ {
		if ua[i] != ub[i] {
			if ua[i] < ub[i] {
				return ua, ub
			}
			return ub, ua
		}
	}
	return ua, ub
}

// --- ws client --------------------------------------------------------

type phase06Client struct {
	conn   *websocket.Conn
	frames chan proto.Frame
	close  func()
	mu     sync.Mutex
	closed bool
}

// dialPhase06 connects to baseURL/ws, sends hello with the given
// device_id and device_type, reads the welcome synchronously, then
// starts a background reader that pushes incoming frames onto
// cli.frames. Caller MUST defer cli.Close().
func dialPhase06(t *testing.T, baseURL, deviceID, deviceType string) *phase06Client {
	t.Helper()
	wsURL := strings.Replace(baseURL, "http://", "ws://", 1) + "/ws"

	dialCtx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()

	c, _, err := websocket.Dial(dialCtx, wsURL, &websocket.DialOptions{
		Subprotocols: []string{proto.Subprotocol},
	})
	if err != nil {
		t.Fatalf("dial %s: %v", baseURL, err)
	}
	c.SetReadLimit(proto.MaxFrameBytes)

	hello, _ := proto.NewFrame(proto.TypeHello, "h-1", proto.HelloPayload{
		DeviceID: deviceID, DeviceType: deviceType,
	})
	hb, _ := json.Marshal(hello)
	if err := c.Write(dialCtx, websocket.MessageText, hb); err != nil {
		t.Fatalf("hello write: %v", err)
	}

	// Read welcome synchronously, before starting the background reader.
	_, data, err := c.Read(dialCtx)
	if err != nil {
		t.Fatalf("read welcome: %v", err)
	}
	var welcome proto.Frame
	if err := json.Unmarshal(data, &welcome); err != nil {
		t.Fatalf("decode welcome: %v", err)
	}
	if welcome.Type != proto.TypeWelcome {
		t.Fatalf("expected welcome, got %s", welcome.Type)
	}

	cli := &phase06Client{
		conn:   c,
		frames: make(chan proto.Frame, 32),
	}
	readCtx, readCancel := context.WithCancel(context.Background())
	cli.close = func() {
		cli.mu.Lock()
		if cli.closed {
			cli.mu.Unlock()
			return
		}
		cli.closed = true
		cli.mu.Unlock()
		readCancel()
		_ = c.Close(websocket.StatusNormalClosure, "test done")
	}

	go func() {
		defer close(cli.frames)
		for {
			_, raw, err := c.Read(readCtx)
			if err != nil {
				return
			}
			var f proto.Frame
			if err := json.Unmarshal(raw, &f); err != nil {
				continue
			}
			select {
			case cli.frames <- f:
			case <-readCtx.Done():
				return
			}
		}
	}()
	return cli
}

func (c *phase06Client) Close() { c.close() }

func (c *phase06Client) send(t *testing.T, kind, ref string, payload any) {
	t.Helper()
	frame, err := proto.NewFrame(kind, ref, payload)
	if err != nil {
		t.Fatalf("frame %s: %v", kind, err)
	}
	data, _ := json.Marshal(frame)
	wctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
	defer cancel()
	if err := c.conn.Write(wctx, websocket.MessageText, data); err != nil {
		t.Fatalf("write %s: %v", kind, err)
	}
}

// expect reads frames until one of the wanted type arrives. Frames of
// other types are logged + dropped (so async pushes -- e.g. presence
// updates during a friend_request_ack wait -- don't fail an assertion).
func (c *phase06Client) expect(t *testing.T, wantType string, timeout time.Duration) proto.Frame {
	t.Helper()
	deadline := time.Now().Add(timeout)
	for time.Now().Before(deadline) {
		remaining := time.Until(deadline)
		select {
		case f, ok := <-c.frames:
			if !ok {
				t.Fatalf("connection closed while waiting for %s", wantType)
			}
			if f.Type == wantType {
				return f
			}
			t.Logf("expecting %s, dropped %s (ref=%s)", wantType, f.Type, f.Ref)
		case <-time.After(remaining):
		}
	}
	t.Fatalf("timeout waiting for frame type %s after %s", wantType, timeout)
	return proto.Frame{}
}

// drainFrames eats anything queued within dur. Useful for the small
// race between connecting and subscribing.
func drainFrames(c *phase06Client, dur time.Duration) {
	deadline := time.Now().Add(dur)
	for time.Now().Before(deadline) {
		remaining := time.Until(deadline)
		select {
		case <-c.frames:
		case <-time.After(remaining):
			return
		}
	}
}

// waitForPresenceChange watches for a presence frame for userID whose
// state differs from priorState. Returns the new state, or "" on
// timeout. Same-state presence pushes (no aggregate change) are
// silently ignored.
func waitForPresenceChange(c *phase06Client, userID, priorState string, timeout time.Duration) string {
	deadline := time.Now().Add(timeout)
	for time.Now().Before(deadline) {
		remaining := time.Until(deadline)
		select {
		case f, ok := <-c.frames:
			if !ok {
				return ""
			}
			if f.Type != proto.TypePresence {
				continue
			}
			var p proto.PresencePayload
			if err := json.Unmarshal(f.Payload, &p); err != nil {
				continue
			}
			if p.UserID != userID {
				continue
			}
			if p.State == priorState {
				continue
			}
			return p.State
		case <-time.After(remaining):
		}
	}
	return ""
}

// --- TEST 1: friend_request + accept + friend_event push --------------

func TestPhase06_FriendRequestAccept(t *testing.T) {
	httpA := httpEnvN(t, 1)
	httpB := httpEnvN(t, 2)
	st := setupPhase06(t)

	// alice's phone on instance 1. The phase-05 ensureDeviceForTesting
	// shim auto-creates alice's device row on connect (alice is
	// hardcoded as the owner of every unknown device_id).
	alicePhoneDev := uuid.New().String()
	alicePhone := dialPhase06(t, httpA, alicePhoneDev, "phone")
	defer alicePhone.Close()

	// bob's device pre-seeded so lookupUserForDevice returns bob.
	bobDev := seedDeviceForUser(t, st, bobUserID, "phase-06-test-bob")
	bob := dialPhase06(t, httpB, bobDev, "desktop")
	defer bob.Close()

	// bob -> friend_request -> alice
	bob.send(t, proto.TypeFriendRequest, "fr-1", proto.FriendRequestPayload{
		ToUserID: aliceUserID,
	})
	ack := bob.expect(t, proto.TypeFriendRequestAck, 3*time.Second)
	if !strings.Contains(string(ack.Payload), `"status":"requested"`) {
		t.Fatalf("expected status=requested, got %s", string(ack.Payload))
	}

	// alice should see friend_event{kind=request_received, from=bob}
	ev := alicePhone.expect(t, proto.TypeFriendEvent, 3*time.Second)
	var evP proto.FriendEventPayload
	if err := json.Unmarshal(ev.Payload, &evP); err != nil {
		t.Fatalf("decode friend_event: %v", err)
	}
	if evP.Kind != "request_received" {
		t.Fatalf("expected kind=request_received, got %q", evP.Kind)
	}
	if evP.FromUserID != bobUserID {
		t.Fatalf("expected from=bob, got %q", evP.FromUserID)
	}

	// alice accepts.
	alicePhone.send(t, proto.TypeFriendAccept, "fa-1", proto.FriendAcceptPayload{
		FromUserID: bobUserID,
	})
	_ = alicePhone.expect(t, proto.TypeFriendAcceptAck, 3*time.Second)

	// bob receives kind=accepted.
	bobEv := bob.expect(t, proto.TypeFriendEvent, 3*time.Second)
	var bobEvP proto.FriendEventPayload
	if err := json.Unmarshal(bobEv.Payload, &bobEvP); err != nil {
		t.Fatalf("decode bob friend_event: %v", err)
	}
	if bobEvP.Kind != "accepted" || bobEvP.FromUserID != aliceUserID {
		t.Fatalf("unexpected friend_event on bob: %+v", bobEvP)
	}

	// Verify canonical accepted row exists.
	dbCtx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
	defer cancel()
	var count int
	ua, ub := orderUUIDs(aliceUserID, bobUserID)
	if err := st.Pool.QueryRow(dbCtx,
		`SELECT COUNT(*) FROM friendships
		   WHERE user_a = $1 AND user_b = $2 AND status = 'accepted'`,
		ua, ub,
	).Scan(&count); err != nil {
		t.Fatalf("friendships query: %v", err)
	}
	if count != 1 {
		t.Fatalf("expected 1 canonical accepted row, got %d", count)
	}
}

// --- TEST 2: presence aggregation across devices ----------------------

func TestPhase06_PresenceAggregation(t *testing.T) {
	httpA := httpEnvN(t, 1)
	httpB := httpEnvN(t, 2)
	st := setupPhase06(t)

	// Pre-establish friendship so we can focus on presence here.
	dbCtx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	ua, ub := orderUUIDs(aliceUserID, bobUserID)
	if _, err := st.Pool.Exec(dbCtx,
		`INSERT INTO friendships (user_a, user_b, status, requested_at, accepted_at)
		 VALUES ($1, $2, 'accepted', now(), now())`,
		ua, ub,
	); err != nil {
		t.Fatalf("seed friendship: %v", err)
	}

	// alice on instance 1, two devices.
	alicePhoneDev := uuid.New().String()
	alicePhone := dialPhase06(t, httpA, alicePhoneDev, "phone")
	defer alicePhone.Close()

	aliceTabletDev := uuid.New().String()
	aliceTablet := dialPhase06(t, httpA, aliceTabletDev, "tablet")
	defer aliceTablet.Close()

	// bob on instance 2.
	bobDev := seedDeviceForUser(t, st, bobUserID, "phase-06-test-bob")
	bob := dialPhase06(t, httpB, bobDev, "desktop")
	defer bob.Close()

	// Drain any setup-time noise.
	drainFrames(bob, 200*time.Millisecond)

	// bob subscribes to alice.
	bob.send(t, proto.TypePresenceSubscribe, "ps-1", proto.PresenceSubscribePayload{
		UserIDs: []string{aliceUserID},
	})
	subAck := bob.expect(t, proto.TypePresenceSubscribeAck, 3*time.Second)
	var subAckP proto.PresenceSubscribeAckPayload
	if err := json.Unmarshal(subAck.Payload, &subAckP); err != nil {
		t.Fatalf("decode subscribe_ack: %v", err)
	}
	if len(subAckP.Subscribed) != 1 || subAckP.Subscribed[0] != aliceUserID {
		t.Fatalf("expected [alice] subscribed, got %+v", subAckP)
	}

	// Immediate current-state push: online (both devices live).
	curr := bob.expect(t, proto.TypePresence, 3*time.Second)
	var currP proto.PresencePayload
	if err := json.Unmarshal(curr.Payload, &currP); err != nil {
		t.Fatalf("decode presence: %v", err)
	}
	if currP.State != "online" {
		t.Fatalf("expected initial online, got %s", currP.State)
	}

	// Phone disconnects; tablet still online -> aggregate stays online.
	alicePhone.Close()
	if got := waitForPresenceChange(bob, aliceUserID, "online", 2*time.Second); got != "" {
		t.Fatalf("expected aggregate to stay online with tablet up; saw transition to %q", got)
	}

	// Tablet disconnects -> aggregate becomes offline.
	aliceTablet.Close()
	if got := waitForPresenceChange(bob, aliceUserID, "online", 5*time.Second); got != "offline" {
		t.Fatalf("expected offline after last device disconnect; got %q", got)
	}
}

// --- TEST 3: janitor reaps a crashed instance -------------------------

// Self-contained: injects a fake dead instance row + stale device_presence
// row that LOOKS like a chalkd died holding presence for alice. Then
// watches instance 2's janitor reap them. Doesn't depend on the bootstrap
// script's SIGKILL of chalkd #1 having happened in a particular order;
// the SIGKILL is still useful (it ensures no live chalkd is heartbeating
// our zombie's instance_id back to life), but the test is correct even
// if chalkd #1 is somehow still running.
func TestPhase06_JanitorReapsCrashedInstance(t *testing.T) {
	httpB := httpEnvN(t, 2)
	st := setupPhase06(t)

	// Friendship so bob can subscribe to alice.
	dbCtx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	ua, ub := orderUUIDs(aliceUserID, bobUserID)
	if _, err := st.Pool.Exec(dbCtx,
		`INSERT INTO friendships (user_a, user_b, status, requested_at, accepted_at)
		 VALUES ($1, $2, 'accepted', now(), now())`,
		ua, ub,
	); err != nil {
		t.Fatalf("seed friendship: %v", err)
	}

	// Inject zombie instance.
	deadInstanceID := "phase-06-zombie-1"
	if _, err := st.Pool.Exec(dbCtx,
		`INSERT INTO instances (id, last_heartbeat, started_at, host, version)
		 VALUES ($1, now() - INTERVAL '1 hour', now() - INTERVAL '1 hour',
		         'zombie-host', 'phase06')
		 ON CONFLICT (id) DO UPDATE SET last_heartbeat = EXCLUDED.last_heartbeat`,
		deadInstanceID,
	); err != nil {
		t.Fatalf("insert dead instance: %v", err)
	}

	// Alice's phone device + stale presence row pointing at the zombie.
	alicePhoneDev := uuid.New()
	if _, err := st.Pool.Exec(dbCtx,
		`INSERT INTO devices (id, user_id, device_type, device_label)
		 VALUES ($1, $2, 'phone', 'phase-06-test-zombie-alice')`,
		alicePhoneDev, uuid.MustParse(aliceUserID),
	); err != nil {
		t.Fatalf("seed alice device: %v", err)
	}
	if _, err := st.Pool.Exec(dbCtx,
		`INSERT INTO device_presence
		   (device_id, user_id, instance_id, device_type, state, last_seen)
		 VALUES ($1, $2, $3, 'phone', 'online', now() - INTERVAL '5 seconds')`,
		alicePhoneDev, uuid.MustParse(aliceUserID), deadInstanceID,
	); err != nil {
		t.Fatalf("seed stale presence: %v", err)
	}

	// bob connects on instance 2 and subscribes.
	bobDev := seedDeviceForUser(t, st, bobUserID, "phase-06-test-bob")
	bob := dialPhase06(t, httpB, bobDev, "desktop")
	defer bob.Close()

	bob.send(t, proto.TypePresenceSubscribe, "ps-1", proto.PresenceSubscribePayload{
		UserIDs: []string{aliceUserID},
	})
	subAck := bob.expect(t, proto.TypePresenceSubscribeAck, 3*time.Second)
	var subAckP proto.PresenceSubscribeAckPayload
	if err := json.Unmarshal(subAck.Payload, &subAckP); err != nil {
		t.Fatalf("decode subscribe_ack: %v", err)
	}
	if len(subAckP.Subscribed) != 1 {
		t.Fatalf("subscribe should accept alice; got %+v", subAckP)
	}

	// Immediate state: online (stale row says so).
	curr := bob.expect(t, proto.TypePresence, 3*time.Second)
	var currP proto.PresencePayload
	if err := json.Unmarshal(curr.Payload, &currP); err != nil {
		t.Fatalf("decode initial presence: %v", err)
	}
	if currP.State != "online" {
		t.Fatalf("expected initial online (stale row), got %s", currP.State)
	}

	// Wait for instance 2's janitor to reap. Aggressive test timing
	// (500ms sweep / 2s staleness via env vars) means worst-case ~2.5s
	// + NOTIFY round trip. Cap at 8s.
	got := waitForPresenceChange(bob, aliceUserID, "online", 8*time.Second)
	if got != "offline" {
		t.Fatalf("expected janitor to publish offline; got %q", got)
	}

	// Verify the dead instance was reaped.
	var instCount int
	if err := st.Pool.QueryRow(dbCtx,
		`SELECT COUNT(*) FROM instances WHERE id = $1`, deadInstanceID,
	).Scan(&instCount); err != nil {
		t.Fatalf("count instances: %v", err)
	}
	if instCount != 0 {
		t.Fatalf("dead instance not reaped; count=%d", instCount)
	}

	// And device_presence cascaded out.
	var dpCount int
	if err := st.Pool.QueryRow(dbCtx,
		`SELECT COUNT(*) FROM device_presence WHERE instance_id = $1`, deadInstanceID,
	).Scan(&dpCount); err != nil {
		t.Fatalf("count device_presence: %v", err)
	}
	if dpCount != 0 {
		t.Fatalf("stale device_presence not cascaded; count=%d", dpCount)
	}
}
