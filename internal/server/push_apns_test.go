package server

// 136-4b: these tests check the push to the iOS app. They check who gets a
// push, what the sender gets, what happens to the row, and how the server
// checks the registration frame. The store and both senders are fakes.

import (
	"context"
	"crypto/ecdh"
	"crypto/rand"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"sort"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/google/uuid"

	"github.com/scuq/chalk/internal/apns"
	"github.com/scuq/chalk/internal/proto"
	"github.com/scuq/chalk/internal/store"
)

// sentNative is one push that fakeAPNs got.
type sentNative struct {
	token   string
	payload []byte
	opts    apns.Options
}

// fakeAPNs is an apnsSender that records its pushes. A token in errs makes
// Send return that error for the token.
type fakeAPNs struct {
	mu   sync.Mutex
	sent []sentNative
	errs map[string]error // by token
}

func (a *fakeAPNs) Send(_ context.Context, dev apns.Device, payload []byte, opts apns.Options) error {
	a.mu.Lock()
	defer a.mu.Unlock()
	a.sent = append(a.sent, sentNative{token: dev.Token, payload: payload, opts: opts})
	return a.errs[dev.Token]
}
func (a *fakeAPNs) Topic() string                 { return "at.73c.chalk" }
func (a *fakeAPNs) Environment() apns.Environment { return apns.Production }
func (a *fakeAPNs) Key() string                   { return "at.73c.chalk/production" }

// tokens returns the tokens that got a push, sorted.
func (a *fakeAPNs) tokens() []string {
	var out []string
	for _, s := range a.sent {
		out = append(out, s.token)
	}
	sort.Strings(out)
	return out
}

// withNative gives the fixture an APNs sender and gives bob an iPhone app
// and dave an iPad app beside the web push rows.
func withNative(f *pushFixture) *fakeAPNs {
	native := &fakeAPNs{errs: map[string]error{}}
	f.d.apns = native
	f.data.subs = append(f.data.subs,
		store.PushSubscription{ID: uuid.New(), UserID: f.bob, Kind: store.PushKindAPNs, Endpoint: "aa01"},
		store.PushSubscription{ID: uuid.New(), UserID: f.dave, Kind: store.PushKindAPNs, Endpoint: "dd02"},
	)
	return native
}

// TestPushDispatchAPNs checks that a message goes to the web push rows and to
// the APNs rows of the away members. It also checks the keys that the
// dispatcher asks for, the APNs options, and that both kinds get the same
// payload.
func TestPushDispatchAPNs(t *testing.T) {
	f := newPushFixture()
	native := withNative(f)
	f.d.dispatch(context.Background(), f.event)

	if got := strings.Join(native.tokens(), ","); got != "aa01,dd02" {
		t.Fatalf("APNs pushed to %s", got)
	}
	if got := strings.Join(f.endpoints(), ","); got != "https://push.cyberdyne.example/bob-phone,https://push.cyberdyne.example/bob-laptop" {
		t.Fatalf("web push pushed to %s", got)
	}
	if want := []string{"CURKEY", "at.73c.chalk/production"}; fmt.Sprint(f.data.gotKeys) != fmt.Sprint(want) {
		t.Fatalf("subscriptions asked with keys %q", f.data.gotKeys)
	}
	var bobNative, bobWeb map[string]any
	for _, s := range native.sent {
		if s.token == "aa01" {
			_ = json.Unmarshal(s.payload, &bobNative)
		}
		if s.opts.TTL != pushTTL || s.opts.Priority != apns.PriorityHigh || s.opts.CollapseID != "" {
			t.Fatalf("APNs options %+v", s.opts)
		}
	}
	bobWeb = f.sender.sent[0].payload
	if fmt.Sprint(bobNative) != fmt.Sprint(bobWeb) {
		t.Fatalf("APNs payload %v differs from web push payload %v", bobNative, bobWeb)
	}
	if len(f.data.touched) != 4 || len(f.data.deleted) != 0 {
		t.Fatalf("touched %d deleted %d", len(f.data.touched), len(f.data.deleted))
	}
}

// TestPushDispatchAPNsCooldownCoversAllDevices checks that a second message in
// the cooldown gives no push to a device of either kind.
func TestPushDispatchAPNsCooldownCoversAllDevices(t *testing.T) {
	f := newPushFixture()
	native := withNative(f)
	f.d.dispatch(context.Background(), f.event)
	f.d.dispatch(context.Background(), f.event)
	if len(native.sent) != 2 || len(f.sender.sent) != 2 {
		t.Fatalf("second message in the cooldown pushed again: apns %d, web %d", len(native.sent), len(f.sender.sent))
	}
}

// TestPushDispatchAPNsPrunesGone checks that apns.ErrGone deletes the row and
// that another error, a 429 answer, keeps it.
func TestPushDispatchAPNsPrunesGone(t *testing.T) {
	f := newPushFixture()
	native := withNative(f)
	native.errs["dd02"] = fmt.Errorf("%w (410 Unregistered)", apns.ErrGone)
	native.errs["aa01"] = &apns.StatusError{Code: 429, Reason: "TooManyRequests"}
	f.d.dispatch(context.Background(), f.event)
	var daveRow uuid.UUID
	for _, s := range f.data.subs {
		if s.Endpoint == "dd02" {
			daveRow = s.ID
		}
	}
	if len(f.data.deleted) != 1 || f.data.deleted[0] != daveRow {
		t.Fatalf("deleted %v, want dave's APNs row only", f.data.deleted)
	}
}

// TestPushDispatchAPNsRowsWithoutSender checks that an APNs row is skipped if
// APNs is off. The dispatcher does not send to it, delete it, or touch it,
// and it does not ask for the APNs key.
func TestPushDispatchAPNsRowsWithoutSender(t *testing.T) {
	f := newPushFixture()
	withNative(f)
	f.d.apns = nil
	f.d.dispatch(context.Background(), f.event)
	if len(f.sender.sent) != 2 {
		t.Fatalf("web push sent %d", len(f.sender.sent))
	}
	for _, s := range f.sender.sent {
		if !strings.HasPrefix(s.endpoint, "https://") {
			t.Fatalf("an APNs row went to the web push sender: %s", s.endpoint)
		}
	}
	if len(f.data.deleted) != 0 || len(f.data.touched) != 2 {
		t.Fatalf("touched %d deleted %d", len(f.data.touched), len(f.data.deleted))
	}
	if fmt.Sprint(f.data.gotKeys) != "[CURKEY]" {
		t.Fatalf("keys %q", f.data.gotKeys)
	}
}

// TestReminderSweepAPNs checks that a due reminder goes to the APNs row of an
// away user.
func TestReminderSweepAPNs(t *testing.T) {
	f := newPushFixture()
	native := withNative(f)
	r := uuid.New()
	f.data.dueWakes = []store.DueReminderWake{{UserID: f.dave, ReminderID: r}}
	if n, err := f.d.sweepReminders(context.Background(), time.Now()); err != nil || n != 1 {
		t.Fatalf("sweep: %d %v", n, err)
	}
	if len(native.sent) != 1 || native.sent[0].token != "dd02" {
		t.Fatalf("APNs sent %+v", native.sent)
	}
	var p reminderPushPayload
	if err := json.Unmarshal(native.sent[0].payload, &p); err != nil || p.Kind != "reminder" || p.ReminderID != r.String() {
		t.Fatalf("payload %s", native.sent[0].payload)
	}
}

// b64url returns b in unpadded base64url.
func b64url(b []byte) string { return base64.RawURLEncoding.EncodeToString(b) }

// TestParsePushSubscribeAPNs checks that a good payload parses, with the
// token in lowercase, and that each bad field gives the right error code.
func TestParsePushSubscribeAPNs(t *testing.T) {
	key, err := ecdh.P256().GenerateKey(rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	ua := key.PublicKey().Bytes()
	good := proto.PushSubscribeAPNsPayload{
		Token:       "00FC13ADFF785122B4AD28809A3420982341241421348097878E577C991DE8F0",
		P256dh:      b64url(ua),
		Auth:        b64url(make([]byte, 16)),
		Scope:       "all",
		Topic:       "at.73c.chalk",
		Environment: "production",
	}
	sub, code, msg := parsePushSubscribeAPNs(good, "at.73c.chalk", apns.Production)
	if code != "" {
		t.Fatalf("good: %s %s", code, msg)
	}
	if sub.endpoint != strings.ToLower(good.Token) || sub.scope != store.PushScopeAll || len(sub.p256dh) != 65 || len(sub.auth) != 16 {
		t.Fatalf("good: %+v", sub)
	}
	cases := []struct {
		name string
		mut  func(*proto.PushSubscribeAPNsPayload)
		code string
	}{
		{"other topic", func(p *proto.PushSubscribeAPNsPayload) { p.Topic = "com.example.other" }, proto.ErrCodePushAPNsMismatch},
		{"sandbox build", func(p *proto.PushSubscribeAPNsPayload) { p.Environment = "sandbox" }, proto.ErrCodePushAPNsMismatch},
		{"empty token", func(p *proto.PushSubscribeAPNsPayload) { p.Token = "" }, proto.ErrCodeBadPayload},
		{"token with a path", func(p *proto.PushSubscribeAPNsPayload) { p.Token = "ab/../cd" }, proto.ErrCodeBadPayload},
		{"short p256dh", func(p *proto.PushSubscribeAPNsPayload) { p.P256dh = b64url(ua[:64]) }, proto.ErrCodeBadPayload},
		{"p256dh not on the curve", func(p *proto.PushSubscribeAPNsPayload) { p.P256dh = b64url(append([]byte{4}, make([]byte, 64)...)) }, proto.ErrCodeBadPayload},
		{"short auth", func(p *proto.PushSubscribeAPNsPayload) { p.Auth = b64url(make([]byte, 15)) }, proto.ErrCodeBadPayload},
		{"bad scope", func(p *proto.PushSubscribeAPNsPayload) { p.Scope = "loud" }, proto.ErrCodeBadPayload},
	}
	for _, tc := range cases {
		p := good
		tc.mut(&p)
		if _, code, _ := parsePushSubscribeAPNs(p, "at.73c.chalk", apns.Production); code != tc.code {
			t.Fatalf("%s: code %q, want %q", tc.name, code, tc.code)
		}
	}
}

// TestPushStateWithAPNs checks the APNs fields of the push state: the topic
// and the environment, the kind, and KeyCurrent for each case of sender and
// subscription.
func TestPushStateWithAPNs(t *testing.T) {
	native := &fakeAPNs{}
	st := withAPNs(pushStatePayload("KEY", nil), native, nil)
	if st.APNsTopic != "at.73c.chalk" || st.APNsEnvironment != "production" || st.Kind != "" {
		t.Fatalf("enabled, no subscription: %+v", st)
	}
	if st := withAPNs(pushStatePayload("", nil), native, nil); st.APNsTopic != "" {
		t.Fatalf("push disabled must not offer APNs: %+v", st)
	}
	if st := withAPNs(pushStatePayload("KEY", nil), nil, nil); st.APNsTopic != "" || st.APNsEnvironment != "" {
		t.Fatalf("no APNs sender: %+v", st)
	}

	sub := &store.PushSubscription{Kind: store.PushKindAPNs, Endpoint: "aa01", Scope: store.PushScopeDMs, VAPIDKey: "at.73c.chalk/production"}
	st = withAPNs(pushStatePayload("KEY", sub), native, sub)
	if !st.Subscribed || st.Kind != "apns" || !st.KeyCurrent {
		t.Fatalf("current APNs subscription: %+v", st)
	}
	sub.VAPIDKey = "at.73c.chalk/sandbox"
	if st := withAPNs(pushStatePayload("KEY", sub), native, sub); st.KeyCurrent {
		t.Fatalf("APNs subscription for another environment: %+v", st)
	}
	sub.VAPIDKey = "at.73c.chalk/production"
	if st := withAPNs(pushStatePayload("KEY", sub), nil, sub); st.KeyCurrent {
		t.Fatalf("APNs subscription while APNs is off: %+v", st)
	}

	web := &store.PushSubscription{Kind: store.PushKindWebPush, Endpoint: "https://push.cyberdyne.example/a", Scope: store.PushScopeAll, VAPIDKey: "KEY"}
	if st := withAPNs(pushStatePayload("KEY", web), native, web); !st.KeyCurrent || st.Kind != "webpush" {
		t.Fatalf("web push subscription: %+v", st)
	}
}

// TestPushSubscribeAPNsNotForGuests checks that push_subscribe_apns is not on
// the guest allowlist. It also checks that errors.Is finds apns.ErrGone in a
// wrapped error.
func TestPushSubscribeAPNsNotForGuests(t *testing.T) {
	if guestAllowedFrames[proto.TypePushSubscribeAPNs] {
		t.Fatal("guests must not reach push_subscribe_apns")
	}
	if !errors.Is(fmt.Errorf("x: %w", apns.ErrGone), apns.ErrGone) {
		t.Fatal("wrapped ErrGone")
	}
}
