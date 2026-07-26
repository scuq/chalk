package integration

// Phase 43-3 integration tests for typing indicators. These cover the two
// properties that no unit test can see, because both live in the round trip
// through Postgres NOTIFY and back out to other connections:
//
//   * a ping reaches the channel's other members
//   * a ping NEVER reaches the typist's own other devices, and never reaches
//     anyone at all when the sender isn't a member
//
// The negative assertions are ordered behind a positive one wherever possible:
// waiting for a frame that must arrive is a real sync point, where a bare
// timeout is only ever a guess.
//
// Skips without CHALK_TEST_PGURL, like every other test in this package.

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"errors"
	"net/http"
	"strings"
	"testing"
	"time"

	"github.com/coder/websocket"
	"github.com/google/uuid"

	"github.com/scuq/chalk/internal/auth"
	"github.com/scuq/chalk/internal/proto"
	"github.com/scuq/chalk/internal/store"
)

// dialAs is dial() with a session cookie. Every WS connection is bound to a
// session-resolved user (phase 09b sub-step 6), and typing needs a real user
// behind the connection -- an anonymous one has nobody to name.
func dialAs(t *testing.T, st *store.Store, baseURL, deviceID string, userID uuid.UUID) *websocket.Conn {
	t.Helper()
	sess, err := st.CreateSession(ctx(t), userID, "typing-test", nil)
	if err != nil {
		t.Fatalf("CreateSession for %s: %v", userID, err)
	}
	cookie := auth.CookieName + "=" + base64.RawURLEncoding.EncodeToString(sess.Token)

	wsURL := strings.Replace(baseURL, "http://", "ws://", 1) + "/ws"
	dctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()

	c, _, err := websocket.Dial(dctx, wsURL, &websocket.DialOptions{
		Subprotocols: []string{proto.Subprotocol},
		HTTPHeader:   http.Header{"Cookie": []string{cookie}},
	})
	if err != nil {
		t.Fatalf("dial: %v", err)
	}
	c.SetReadLimit(proto.MaxFrameBytes)

	hello, _ := proto.NewFrame(proto.TypeHello, "", proto.HelloPayload{DeviceID: deviceID})
	hb, _ := json.Marshal(hello)
	if err := c.Write(dctx, websocket.MessageText, hb); err != nil {
		t.Fatalf("write hello: %v", err)
	}
	_, data, err := c.Read(dctx)
	if err != nil {
		t.Fatalf("read welcome: %v", err)
	}
	var f proto.Frame
	if err := json.Unmarshal(data, &f); err != nil {
		t.Fatalf("decode welcome: %v", err)
	}
	if f.Type != proto.TypeWelcome {
		t.Fatalf("expected welcome, got %s", f.Type)
	}
	return c
}

func writeTyping(t *testing.T, c *websocket.Conn, channelID uuid.UUID) {
	t.Helper()
	frame, _ := proto.NewFrame(proto.TypeTyping, "", proto.TypingPayload{
		ChannelID: channelID.String(),
	})
	data, _ := json.Marshal(frame)
	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
	defer cancel()
	if err := c.Write(ctx, websocket.MessageText, data); err != nil {
		t.Fatalf("write typing: %v", err)
	}
}

// expectNoFrame fails if anything arrives within the window.
func expectNoFrame(t *testing.T, c *websocket.Conn, what string) {
	t.Helper()
	ctx, cancel := context.WithTimeout(context.Background(), 300*time.Millisecond)
	defer cancel()
	_, data, err := c.Read(ctx)
	if err == nil {
		t.Fatalf("%s: unexpectedly received %s", what, string(data))
	}
	if !errors.Is(err, context.DeadlineExceeded) {
		t.Logf("note: read returned non-deadline error %v (still treated as nothing received)", err)
	}
}

func TestTyping_ReachesOtherMembers(t *testing.T) {
	st := openStore(t)
	channelID, aliceDev, bobDev := seedReadsChannel(t, st)

	url, stop := startTestServer(t)
	defer stop()

	a := dialAs(t, st, url, aliceDev.String(), aliceID)
	defer a.Close(websocket.StatusNormalClosure, "")
	b := dialAs(t, st, url, bobDev.String(), bobID)
	defer b.Close(websocket.StatusNormalClosure, "")

	writeTyping(t, a, channelID)

	got := readFrame(t, b, 2*time.Second)
	if got.Type != proto.TypeTypingUpdate {
		t.Fatalf("expected typing_update, got %s", got.Type)
	}
	var p proto.TypingUpdatePayload
	if err := got.DecodePayload(&p); err != nil {
		t.Fatalf("decode payload: %v", err)
	}
	if p.UserID != aliceID.String() {
		t.Errorf("user_id = %q, want alice %q", p.UserID, aliceID)
	}
	if p.ChannelID != channelID.String() {
		t.Errorf("channel_id = %q, want %q", p.ChannelID, channelID)
	}
}

// The one that matters: alice typing on her laptop must not tell her phone
// that she is typing.
func TestTyping_NeverReachesOwnOtherDevice(t *testing.T) {
	st := openStore(t)
	channelID, aliceDev, bobDev := seedReadsChannel(t, st)
	aliceDev2 := seedReadsDevice(t, st, aliceID)

	url, stop := startTestServer(t)
	defer stop()

	a1 := dialAs(t, st, url, aliceDev.String(), aliceID)
	defer a1.Close(websocket.StatusNormalClosure, "")
	a2 := dialAs(t, st, url, aliceDev2.String(), aliceID)
	defer a2.Close(websocket.StatusNormalClosure, "")
	b := dialAs(t, st, url, bobDev.String(), bobID)
	defer b.Close(websocket.StatusNormalClosure, "")

	writeTyping(t, a1, channelID)

	// Bob receiving is the sync point: the fanout loop for this event has
	// run to completion by the time this returns, so alice's second device
	// has either been skipped or already been given the frame.
	if got := readFrame(t, b, 2*time.Second); got.Type != proto.TypeTypingUpdate {
		t.Fatalf("bob: expected typing_update, got %s", got.Type)
	}
	expectNoFrame(t, a2, "alice's second device")
}

func TestTyping_NonMemberReachesNobody(t *testing.T) {
	st := openStore(t)
	channelID, aliceDev, bobDev := seedReadsChannel(t, st)
	carolDev := seedReadsDevice(t, st, carolID)

	url, stop := startTestServer(t)
	defer stop()

	a := dialAs(t, st, url, aliceDev.String(), aliceID)
	defer a.Close(websocket.StatusNormalClosure, "")
	b := dialAs(t, st, url, bobDev.String(), bobID)
	defer b.Close(websocket.StatusNormalClosure, "")
	carol := dialAs(t, st, url, carolDev.String(), carolID)
	defer carol.Close(websocket.StatusNormalClosure, "")

	// Carol is not a member. Her ping is dropped server-side, silently -- she
	// gets no error frame either.
	writeTyping(t, carol, channelID)
	expectNoFrame(t, carol, "carol (non-member)")

	// Alice's ping proves the channel is otherwise live, and pins down what
	// bob's first frame must be: if carol's had leaked, it would have been
	// published before this one.
	writeTyping(t, a, channelID)
	got := readFrame(t, b, 2*time.Second)
	var p proto.TypingUpdatePayload
	if err := got.DecodePayload(&p); err != nil {
		t.Fatalf("decode payload: %v", err)
	}
	if p.UserID != aliceID.String() {
		t.Fatalf("bob's first typing_update names %q, want alice %q", p.UserID, aliceID)
	}
	expectNoFrame(t, b, "bob after alice's ping")
}

// A second ping inside the throttle window is dropped, and dropping it must
// not cost the sender an error frame -- at keystroke rate that would be worse
// than the feature.
func TestTyping_ThrottledPingIsSilent(t *testing.T) {
	st := openStore(t)
	channelID, aliceDev, bobDev := seedReadsChannel(t, st)

	url, stop := startTestServer(t)
	defer stop()

	a := dialAs(t, st, url, aliceDev.String(), aliceID)
	defer a.Close(websocket.StatusNormalClosure, "")
	b := dialAs(t, st, url, bobDev.String(), bobID)
	defer b.Close(websocket.StatusNormalClosure, "")

	writeTyping(t, a, channelID)
	writeTyping(t, a, channelID)

	if got := readFrame(t, b, 2*time.Second); got.Type != proto.TypeTypingUpdate {
		t.Fatalf("bob: expected typing_update, got %s", got.Type)
	}
	expectNoFrame(t, b, "bob after a throttled second ping")
	expectNoFrame(t, a, "alice after a throttled ping")
}

// Guard against the store helper drifting: these tests only mean anything if
// carol really is outside the channel they seed.
func TestTyping_SeedHasCarolOutsideChannel(t *testing.T) {
	st := openStore(t)
	channelID, _, _ := seedReadsChannel(t, st)
	member, err := st.IsMember(ctx(t), channelID, carolID)
	if err != nil {
		t.Fatalf("IsMember: %v", err)
	}
	if member {
		t.Fatal("carol is a member of the seeded channel; the non-member test proves nothing")
	}
}
