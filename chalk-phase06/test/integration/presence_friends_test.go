package integration_test

// Phase 06 integration test.
//
// Scenario:
//   * Two chalkd instances against the same Postgres.
//   * alice connects on instance 1 with two devices (phone + tablet).
//   * bob connects on instance 2 (desktop).
//   * bob sends a friend_request to alice.
//   * alice's connected devices receive a friend_event with kind=request_received.
//   * alice accepts via friend_accept.
//   * bob's connected device receives a friend_event with kind=accepted.
//   * bob subscribes to alice's presence; immediately receives her current
//     state (online, because phone+tablet are both connected).
//   * alice's phone disconnects; bob sees no change (tablet still online).
//   * alice's tablet disconnects; bob sees offline.
//   * bob re-subscribes after reconnecting; subscription persists per-device.
//   * Instance 1 is killed without cleanup; janitor on instance 2 detects
//     and emits offline within the configured staleness window.
//
// Test config shrinks heartbeat/janitor/demotion intervals so the run
// completes in seconds rather than the production 15s+ windows.

import (
	"context"
	"encoding/json"
	"fmt"
	"log"
	"net/http"
	"os"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/coder/websocket"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/scuq/chalk/internal/friends"
	"github.com/scuq/chalk/internal/migrate"
	"github.com/scuq/chalk/internal/presence"
	"github.com/scuq/chalk/internal/proto"
	"github.com/scuq/chalk/internal/server"
	"github.com/scuq/chalk/internal/store"
)

const (
	aliceUserID = "00000000-0000-0000-0000-00000000a11c"
	bobUserID   = "00000000-0000-0000-0000-000000000b0b"
)

// testTimeout caps the whole test. Real test under stress should still
// fit comfortably; if it doesn't, the assertion-by-deadline pattern
// returns a useful failure message instead of hanging.
const testTimeout = 60 * time.Second

func TestPresenceAndFriendsTwoInstances(t *testing.T) {
	if os.Getenv("CHALK_INTEGRATION_DSN") == "" {
		t.Skip("CHALK_INTEGRATION_DSN not set; skipping")
	}
	dsn := os.Getenv("CHALK_INTEGRATION_DSN")

	ctx, cancel := context.WithTimeout(context.Background(), testTimeout)
	defer cancel()

	// One pool used for setup (migrations, fixture truncation, fixture
	// inserts). Server instances each open their own pool.
	setupPool, err := pgxpool.New(ctx, dsn)
	if err != nil {
		t.Fatalf("setup pool: %v", err)
	}
	defer setupPool.Close()

	if err := migrate.Up(ctx, setupPool); err != nil {
		t.Fatalf("migrate: %v", err)
	}
	if err := seedTestUsers(ctx, setupPool); err != nil {
		t.Fatalf("seed: %v", err)
	}
	if err := truncatePhase06State(ctx, setupPool); err != nil {
		t.Fatalf("truncate: %v", err)
	}

	// Loop config: aggressive intervals for fast feedback.
	loopCfg := presence.LoopConfig{
		HeartbeatInterval: 500 * time.Millisecond,
		JanitorInterval:   500 * time.Millisecond,
		InstanceStaleness: 2 * time.Second,
		DemotionInterval:  500 * time.Millisecond,
	}

	srv1, addr1, pool1, cancel1 := startServer(t, ctx, dsn, "test-instance-1", loopCfg)
	defer cancel1()
	srv2, addr2, _, cancel2 := startServer(t, ctx, dsn, "test-instance-2", loopCfg)
	defer cancel2()
	_, _ = srv1, srv2

	// Wait for both pubsub listeners to be ready.
	select {
	case <-srv1.PubsubReady():
	case <-time.After(5 * time.Second):
		t.Fatal("instance 1 pubsub never ready")
	}
	select {
	case <-srv2.PubsubReady():
	case <-time.After(5 * time.Second):
		t.Fatal("instance 2 pubsub never ready")
	}

	// alice phone on instance 1
	alicePhoneDev := uuid.New().String()
	alicePhone := dialClient(t, ctx, addr1, alicePhoneDev, "phone")
	defer alicePhone.Close()
	_ = expectWelcome(t, alicePhone)

	// alice tablet on instance 1
	aliceTabletDev := uuid.New().String()
	aliceTablet := dialClient(t, ctx, addr1, aliceTabletDev, "tablet")
	defer aliceTablet.Close()
	_ = expectWelcome(t, aliceTablet)

	// To represent bob on a different instance, we need a way for bob's
	// device_id to map to bob's user_id. ensureDeviceForTesting hardcodes
	// alice as the owner of any device_id. So for the bob path we must
	// pre-create a device row owned by bob BEFORE bob connects.
	bobDeviceID := uuid.New()
	if _, err := setupPool.Exec(ctx,
		`INSERT INTO devices (id, user_id, device_type, device_label)
		 VALUES ($1, $2, 'desktop', 'phase-06-test-bob')
		 ON CONFLICT (id) DO NOTHING`,
		bobDeviceID, uuid.MustParse(bobUserID),
	); err != nil {
		t.Fatalf("seed bob device: %v", err)
	}

	bob := dialClient(t, ctx, addr2, bobDeviceID.String(), "desktop")
	defer bob.Close()
	_ = expectWelcome(t, bob)

	// --- friend_request ---

	send(t, bob, proto.TypeFriendRequest, "fr-1", proto.FriendRequestPayload{
		ToUserID: aliceUserID,
	})
	ack := expectFrame(t, bob, proto.TypeFriendRequestAck, 3*time.Second)
	if !strings.Contains(string(ack.Payload), `"status":"requested"`) {
		t.Fatalf("expected status=requested, got %s", string(ack.Payload))
	}

	// alice's devices should each see a friend_event with kind=request_received.
	for _, c := range []*wsClient{alicePhone, aliceTablet} {
		ev := expectFrame(t, c, proto.TypeFriendEvent, 3*time.Second)
		var p proto.FriendEventPayload
		_ = json.Unmarshal(ev.Payload, &p)
		if p.Kind != "request_received" || p.FromUserID != bobUserID {
			t.Fatalf("unexpected friend_event: %+v", p)
		}
	}

	// --- friend_accept ---

	send(t, alicePhone, proto.TypeFriendAccept, "fa-1", proto.FriendAcceptPayload{
		FromUserID: bobUserID,
	})
	_ = expectFrame(t, alicePhone, proto.TypeFriendAcceptAck, 3*time.Second)

	// bob receives accepted.
	bobEv := expectFrame(t, bob, proto.TypeFriendEvent, 3*time.Second)
	var bobEvP proto.FriendEventPayload
	_ = json.Unmarshal(bobEv.Payload, &bobEvP)
	if bobEvP.Kind != "accepted" {
		t.Fatalf("expected accepted, got %s", bobEvP.Kind)
	}

	// --- presence subscribe ---

	send(t, bob, proto.TypePresenceSubscribe, "ps-1", proto.PresenceSubscribePayload{
		UserIDs: []string{aliceUserID},
	})
	subAck := expectFrame(t, bob, proto.TypePresenceSubscribeAck, 3*time.Second)
	var subAckP proto.PresenceSubscribeAckPayload
	_ = json.Unmarshal(subAck.Payload, &subAckP)
	if len(subAckP.Subscribed) != 1 || subAckP.Subscribed[0] != aliceUserID {
		t.Fatalf("expected subscribed=[alice], got %+v", subAckP)
	}

	// Immediate push of current state.
	curr := expectFrame(t, bob, proto.TypePresence, 3*time.Second)
	var currP proto.PresencePayload
	_ = json.Unmarshal(curr.Payload, &currP)
	if currP.State != "online" {
		t.Fatalf("expected online, got %s", currP.State)
	}

	// --- disconnect alice's phone; bob should NOT see a state change ---
	// (alice's tablet is still online, so aggregate stays online)
	alicePhone.Close()

	// Wait briefly; ensure no presence frame arrives.
	select {
	case f := <-bob.frames:
		if f.Type == proto.TypePresence {
			var p proto.PresencePayload
			_ = json.Unmarshal(f.Payload, &p)
			if p.State != "online" {
				t.Fatalf("unexpected state change to %s while tablet still up", p.State)
			}
		}
	case <-time.After(2 * time.Second):
		// No frame: as expected, since aggregate didn't change.
	}

	// --- disconnect alice's tablet; bob should see offline ---
	aliceTablet.Close()

	deadline := time.Now().Add(8 * time.Second)
	gotOffline := false
	for time.Now().Before(deadline) && !gotOffline {
		select {
		case f := <-bob.frames:
			if f.Type != proto.TypePresence {
				continue
			}
			var p proto.PresencePayload
			_ = json.Unmarshal(f.Payload, &p)
			if p.State == "offline" && p.UserID == aliceUserID {
				gotOffline = true
			}
		case <-time.After(500 * time.Millisecond):
		}
	}
	if !gotOffline {
		t.Fatal("did not receive offline within 8s of last device disconnecting")
	}

	// --- janitor sweep ---
	// Reconnect alice's phone on instance 1, then forcibly kill instance 1
	// without giving it a chance to clear its own presence rows. The
	// janitor on instance 2 should reap instance 1 within 2s
	// (InstanceStaleness) of the heartbeat stopping, and bob should see
	// alice transition to offline again.

	alicePhoneDev2 := uuid.New().String()
	alicePhone2 := dialClient(t, ctx, addr1, alicePhoneDev2, "phone")
	defer alicePhone2.Close()
	_ = expectWelcome(t, alicePhone2)

	// bob's subscription is still active, so he gets an online push.
	gotOnline := false
	deadline = time.Now().Add(3 * time.Second)
	for time.Now().Before(deadline) && !gotOnline {
		select {
		case f := <-bob.frames:
			if f.Type != proto.TypePresence {
				continue
			}
			var p proto.PresencePayload
			_ = json.Unmarshal(f.Payload, &p)
			if p.State == "online" && p.UserID == aliceUserID {
				gotOnline = true
			}
		case <-time.After(500 * time.Millisecond):
		}
	}
	if !gotOnline {
		t.Fatal("alice not seen online after reconnect")
	}

	// Forcibly stop instance 1 by closing its DB pool, then canceling.
	// Closing the pool first prevents the server's clean-shutdown handler
	// from publishing presence-cleared NOTIFYs -- it tries, gets errors,
	// and gives up. The stale device_presence rows for instance 1 stay
	// in the DB, and instance 1's heartbeats stop. This is the unclean
	// crash scenario the janitor exists to handle.
	pool1.Close()
	cancel1()

	// Wait for janitor on instance 2 to reap.
	// staleness=2s + janitor sweep <= 500ms + propagation <= a few hundred ms.
	gotOfflineAgain := false
	deadline = time.Now().Add(10 * time.Second)
	for time.Now().Before(deadline) && !gotOfflineAgain {
		select {
		case f := <-bob.frames:
			if f.Type != proto.TypePresence {
				continue
			}
			var p proto.PresencePayload
			_ = json.Unmarshal(f.Payload, &p)
			if p.State == "offline" && p.UserID == aliceUserID {
				gotOfflineAgain = true
			}
		case <-time.After(500 * time.Millisecond):
		}
	}
	if !gotOfflineAgain {
		t.Fatal("janitor did not reap dead instance within 10s")
	}
}

// --- test helpers -----------------------------------------------------

func startServer(
	t *testing.T,
	ctx context.Context,
	dsn, instanceID string,
	loopCfg presence.LoopConfig,
) (*server.Server, string, *pgxpool.Pool, context.CancelFunc) {
	t.Helper()

	pool, err := pgxpool.New(ctx, dsn)
	if err != nil {
		t.Fatalf("pool %s: %v", instanceID, err)
	}
	st := &store.Store{Pool: pool}

	srvCtx, srvCancel := context.WithCancel(ctx)

	srv, err := server.NewServer(server.Options{
		Listen:             "127.0.0.1:0",
		Store:              st,
		WSConfig:           server.DefaultWSConfig(),
		InstanceID:         instanceID,
		Logger:             log.New(testLogWriter{t}, instanceID+" ", 0),
		Presence:           &presence.Store{Pool: pool},
		Friends:            &friends.Store{Pool: pool},
		PresenceLoopConfig: &loopCfg,
	})
	if err != nil {
		t.Fatalf("new server %s: %v", instanceID, err)
	}

	addr := srv.Addr().String()
	serveErr := make(chan error, 1)
	go func() {
		serveErr <- srv.Serve(srvCtx)
	}()

	// Wait briefly for the listener to be accepting.
	for i := 0; i < 50; i++ {
		resp, err := http.Get("http://" + addr + "/healthz")
		if err == nil {
			resp.Body.Close()
			break
		}
		time.Sleep(50 * time.Millisecond)
	}

	cleanup := func() {
		srvCancel()
		select {
		case <-serveErr:
		case <-time.After(5 * time.Second):
			t.Logf("%s did not shut down within 5s", instanceID)
		}
		// Pool may already be closed if the test simulated a crash;
		// pgxpool.Pool.Close is idempotent.
		pool.Close()
	}
	return srv, addr, pool, cleanup
}

// testLogWriter forwards server logs into testing.T.
type testLogWriter struct{ t *testing.T }

func (w testLogWriter) Write(b []byte) (int, error) {
	w.t.Logf("%s", strings.TrimRight(string(b), "\n"))
	return len(b), nil
}

// wsClient is a minimal test client.
type wsClient struct {
	conn   *websocket.Conn
	frames chan proto.Frame
	close  func()
	mu     sync.Mutex
	closed bool
}

func dialClient(t *testing.T, ctx context.Context, addr, deviceID, deviceType string) *wsClient {
	t.Helper()
	url := "ws://" + addr + "/ws"
	c, _, err := websocket.Dial(ctx, url, &websocket.DialOptions{
		Subprotocols: []string{proto.Subprotocol},
	})
	if err != nil {
		t.Fatalf("dial %s: %v", url, err)
	}
	c.SetReadLimit(proto.MaxFrameBytes)

	hello, _ := proto.NewFrame(proto.TypeHello, "h-1", proto.HelloPayload{
		DeviceID: deviceID, DeviceType: deviceType,
	})
	hb, _ := json.Marshal(hello)
	wctx, cancel := context.WithTimeout(ctx, 3*time.Second)
	defer cancel()
	if err := c.Write(wctx, websocket.MessageText, hb); err != nil {
		t.Fatalf("hello write: %v", err)
	}

	cli := &wsClient{
		conn:   c,
		frames: make(chan proto.Frame, 32),
	}
	readCtx, readCancel := context.WithCancel(ctx)
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
			_, data, err := c.Read(readCtx)
			if err != nil {
				return
			}
			var f proto.Frame
			if err := json.Unmarshal(data, &f); err != nil {
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

func (c *wsClient) Close() { c.close() }

func send(t *testing.T, c *wsClient, kind, ref string, payload any) {
	t.Helper()
	frame, err := proto.NewFrame(kind, ref, payload)
	if err != nil {
		t.Fatalf("frame: %v", err)
	}
	data, _ := json.Marshal(frame)
	wctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
	defer cancel()
	if err := c.conn.Write(wctx, websocket.MessageText, data); err != nil {
		t.Fatalf("write %s: %v", kind, err)
	}
}

// expectWelcome reads frames until a Welcome arrives or the timeout fires.
func expectWelcome(t *testing.T, c *wsClient) proto.WelcomePayload {
	t.Helper()
	f := expectFrame(t, c, proto.TypeWelcome, 5*time.Second)
	var w proto.WelcomePayload
	_ = json.Unmarshal(f.Payload, &w)
	return w
}

// expectFrame reads frames until one with the matching type appears.
// Frames of other types are silently dropped (so e.g. ping side-effects
// or async pushes don't fail an assertion).
func expectFrame(t *testing.T, c *wsClient, wantType string, timeout time.Duration) proto.Frame {
	t.Helper()
	deadline := time.Now().Add(timeout)
	for time.Now().Before(deadline) {
		select {
		case f, ok := <-c.frames:
			if !ok {
				t.Fatalf("connection closed while waiting for %s", wantType)
			}
			if f.Type == wantType {
				return f
			}
			t.Logf("waiting for %s, dropped %s", wantType, f.Type)
		case <-time.After(500 * time.Millisecond):
		}
	}
	t.Fatalf("timeout waiting for frame type %s", wantType)
	return proto.Frame{}
}

// seedTestUsers ensures alice and bob exist with status='active'.
// The phase 03 fixture already seeds alice; we add bob if absent.
func seedTestUsers(ctx context.Context, pool *pgxpool.Pool) error {
	_, err := pool.Exec(ctx,
		`INSERT INTO users (id, handle, status)
		 VALUES ($1, 'alice', 'active'),
		        ($2, 'bob', 'active'),
		        ($3, 'carol', 'active')
		 ON CONFLICT (id) DO UPDATE
		   SET status = 'active', status_reason = NULL`,
		uuid.MustParse(aliceUserID),
		uuid.MustParse(bobUserID),
		uuid.MustParse("00000000-0000-0000-0000-0000000ca201"),
	)
	return err
}

// truncatePhase06State removes phase-06 dynamic state between test runs.
// Run order matters: presence depends on instances and devices; subscriptions
// depend on devices.
func truncatePhase06State(ctx context.Context, pool *pgxpool.Pool) error {
	stmts := []string{
		`DELETE FROM presence_subscriptions`,
		`DELETE FROM device_presence`,
		`DELETE FROM instances`,
		`DELETE FROM friendships`,
		`DELETE FROM devices WHERE device_label LIKE 'phase-06-test%'`,
	}
	for _, s := range stmts {
		if _, err := pool.Exec(ctx, s); err != nil {
			return fmt.Errorf("truncate %q: %w", s, err)
		}
	}
	return nil
}
