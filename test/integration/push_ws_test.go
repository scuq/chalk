package integration

import (
	"context"
	"crypto/ecdh"
	"crypto/rand"
	"encoding/base64"
	"encoding/json"
	"net"
	"net/http"
	"strings"
	"testing"
	"time"

	"github.com/coder/websocket"
	"github.com/google/uuid"

	"github.com/scuq/chalk/internal/auth"
	"github.com/scuq/chalk/internal/innerchan"
	"github.com/scuq/chalk/internal/proto"
	"github.com/scuq/chalk/internal/server"
	"github.com/scuq/chalk/internal/store"
	"github.com/scuq/chalk/internal/webpush"
)

// 65-4: the push frames end to end against a real chalkd with a real login
// session. The properties: the server refuses a plaintext connection, a sealed one
// gets the key and can subscribe and unsubscribe, the row is bound to the
// session, the server refuses a subscription with another key, and a session that
// ended cannot subscribe.

type pushHarness struct {
	t      *testing.T
	st     *store.Store
	wsURL  string
	vapid  string
	userID uuid.UUID
	token  []byte
}

func startPushServer(t *testing.T) *pushHarness {
	t.Helper()
	st := openStore(t)
	idKey, _ := innerchan.GenerateServerKey()
	priv, err := innerchan.ParseServerKey(idKey)
	if err != nil {
		t.Fatal(err)
	}
	vapidPriv, vapidPub, err := webpush.GenerateVAPIDKey()
	if err != nil {
		t.Fatal(err)
	}
	vk, err := webpush.ParseVAPIDKey(vapidPriv, "https://chat.cyberdyne.example")
	if err != nil {
		t.Fatal(err)
	}
	wsCfg := server.DefaultWSConfig()
	wsCfg.ServerIDKey = priv
	srv, err := server.NewServer(server.Options{
		Listen: "127.0.0.1:0", Store: st, Hub: server.NewHub(), WSConfig: wsCfg,
		Push: webpush.NewSender(vk, 5*time.Second),
	})
	if err != nil {
		t.Fatalf("NewServer: %v", err)
	}
	sctx, cancel := context.WithCancel(context.Background())
	done := make(chan struct{})
	go func() { defer close(done); _ = srv.Serve(sctx) }()
	t.Cleanup(func() { cancel(); <-done })
	url := "http://" + srv.Addr().String()
	waitHealthz(t, url)
	select {
	case <-srv.PubsubReady():
	case <-time.After(5 * time.Second):
		t.Fatal("pubsub not ready")
	}

	c := ctx(t)
	userID := uuid.New()
	handle := "push" + strings.ReplaceAll(userID.String()[:8], "-", "")
	if _, err := st.Pool.Exec(c,
		`INSERT INTO users (id, handle, username, display_name, email) VALUES ($1,$2,$3,$4,$5)`,
		userID, handle, handle, handle, handle+"@cyberdyne.example"); err != nil {
		t.Fatalf("insert user: %v", err)
	}
	t.Cleanup(func() {
		_, _ = st.Pool.Exec(context.Background(), `DELETE FROM users WHERE id = $1`, userID)
	})
	sess, err := st.CreateSession(c, userID, "push-test", net.ParseIP("127.0.0.1"))
	if err != nil {
		t.Fatal(err)
	}
	return &pushHarness{t: t, st: st, wsURL: strings.Replace(url, "http://", "ws://", 1) + "/ws",
		vapid: vapidPub, userID: userID, token: sess.Token}
}

// pushConn is one connection, sealed or plaintext.
type pushConn struct {
	t    *testing.T
	c    *websocket.Conn
	sess *innerchan.Session // nil for a plaintext connection
	n    int
}

func (h *pushHarness) dial(sealed bool) *pushConn {
	t := h.t
	t.Helper()
	c0 := ctx(t)
	hdr := http.Header{}
	hdr.Set("Cookie", auth.CookieName+"="+base64.RawURLEncoding.EncodeToString(h.token))
	c, _, err := websocket.Dial(c0, h.wsURL, &websocket.DialOptions{
		Subprotocols: []string{proto.Subprotocol}, HTTPHeader: hdr,
	})
	if err != nil {
		t.Fatalf("dial: %v", err)
	}
	t.Cleanup(func() { c.Close(websocket.StatusNormalClosure, "") })
	pc := &pushConn{t: t, c: c}
	if sealed {
		eph := mustEph(t)
		nonce := mustNonce(t)
		hello, _ := proto.NewFrame(proto.TypeInnerHello, "", proto.InnerHelloPayload{
			ProtoVersion: innerchan.ProtoVersion,
			ClientEphPub: base64.StdEncoding.EncodeToString(eph.pub),
			ClientNonce:  base64.StdEncoding.EncodeToString(nonce),
		})
		writeJSON(t, c0, c, hello)
		var ack proto.Frame
		readJSON(t, c0, c, &ack)
		var ap proto.InnerAckPayload
		if err := ack.DecodePayload(&ap); err != nil {
			t.Fatal(err)
		}
		serverEph, _ := base64.StdEncoding.DecodeString(ap.ServerEphPub)
		serverEd, _ := base64.StdEncoding.DecodeString(ap.ServerEd25519Pub)
		th := innerchan.TranscriptHash(eph.pub, serverEph, nonce, serverEd)
		if pc.sess, err = innerchan.DeriveSession(ecdhShared(t, eph.priv, serverEph), th); err != nil {
			t.Fatal(err)
		}
	}
	pc.send(proto.TypeHello, proto.HelloPayload{DeviceID: uuid.NewString()})
	if f := pc.read(); f.Type != proto.TypeWelcome {
		t.Fatalf("want welcome, got %s", f.Type)
	}
	return pc
}

func (pc *pushConn) send(typ string, payload any) string {
	pc.t.Helper()
	pc.n++
	ref := "p" + string(rune('a'+pc.n))
	f, _ := proto.NewFrame(typ, ref, payload)
	b, _ := json.Marshal(f)
	msgType := websocket.MessageText
	if pc.sess != nil {
		var err error
		if b, err = pc.sess.SealFromClient(b); err != nil {
			pc.t.Fatal(err)
		}
		msgType = websocket.MessageBinary
	}
	if err := pc.c.Write(ctx(pc.t), msgType, b); err != nil {
		pc.t.Fatalf("write %s: %v", typ, err)
	}
	return ref
}

func (pc *pushConn) read() proto.Frame {
	pc.t.Helper()
	_, data, err := pc.c.Read(ctx(pc.t))
	if err != nil {
		pc.t.Fatalf("read: %v", err)
	}
	if pc.sess != nil {
		if data, err = pc.sess.OpenToClient(data); err != nil {
			pc.t.Fatalf("open: %v", err)
		}
	}
	var f proto.Frame
	if err := json.Unmarshal(data, &f); err != nil {
		pc.t.Fatalf("decode: %v", err)
	}
	return f
}

// call sends one request and returns the frame that answers its ref.
func (pc *pushConn) call(typ string, payload any) proto.Frame {
	pc.t.Helper()
	ref := pc.send(typ, payload)
	for i := 0; i < 50; i++ {
		if f := pc.read(); f.Ref == ref {
			return f
		}
	}
	pc.t.Fatalf("no answer to %s", typ)
	return proto.Frame{}
}

func wantErr(t *testing.T, f proto.Frame, code string) {
	t.Helper()
	var ep proto.ErrorPayload
	_ = f.DecodePayload(&ep)
	if f.Type != proto.TypeError || ep.Code != code {
		t.Fatalf("want error %s, got %s %+v", code, f.Type, ep)
	}
}

func wantState(t *testing.T, f proto.Frame, typ string) proto.PushStatePayload {
	t.Helper()
	if f.Type != typ {
		t.Fatalf("want %s, got %s %s", typ, f.Type, f.Payload)
	}
	var st proto.PushStatePayload
	if err := f.DecodePayload(&st); err != nil {
		t.Fatal(err)
	}
	return st
}

func TestPushFramesEndToEnd(t *testing.T) {
	h := startPushServer(t)

	// A plaintext connection gets no key and cannot subscribe.
	plain := h.dial(false)
	wantErr(t, plain.call(proto.TypePushState, nil), proto.ErrCodePushUnsealed)

	pc := h.dial(true)
	st := wantState(t, pc.call(proto.TypePushState, nil), proto.TypePushStateAck)
	if !st.Enabled || st.VAPIDPublicKey != h.vapid || st.Subscribed {
		t.Fatalf("initial state: %+v", st)
	}

	ua, _ := ecdh.P256().GenerateKey(rand.Reader)
	authSecret := make([]byte, 16)
	_, _ = rand.Read(authSecret)
	sub := proto.PushSubscribePayload{
		Endpoint:       "https://push.cyberdyne.example/send/" + uuid.NewString(),
		P256dh:         base64.RawURLEncoding.EncodeToString(ua.PublicKey().Bytes()),
		Auth:           base64.RawURLEncoding.EncodeToString(authSecret),
		Scope:          "dms",
		VAPIDPublicKey: "BOLDKEY",
	}
	wantErr(t, pc.call(proto.TypePushSubscribe, sub), proto.ErrCodePushKeyStale)

	sub.VAPIDPublicKey = h.vapid
	st = wantState(t, pc.call(proto.TypePushSubscribe, sub), proto.TypePushSubscribeAck)
	if !st.Subscribed || !st.KeyCurrent || st.Endpoint != sub.Endpoint || st.Scope != "dms" {
		t.Fatalf("after subscribe: %+v", st)
	}
	row, err := h.st.GetPushSubscriptionForSession(ctx(t), h.token)
	if err != nil || row.UserID != h.userID || row.VAPIDKey != h.vapid {
		t.Fatalf("stored row: %v %+v", err, row)
	}

	st = wantState(t, pc.call(proto.TypePushUnsubscribe, nil), proto.TypePushUnsubscribeAck)
	if st.Subscribed {
		t.Fatalf("after unsubscribe: %+v", st)
	}

	// Logout in another tab ends the session. The open socket cannot
	// subscribe after that.
	if err := h.st.DeleteSession(ctx(t), h.token); err != nil {
		t.Fatal(err)
	}
	wantErr(t, pc.call(proto.TypePushSubscribe, sub), proto.ErrCodePushNoSession)
}
