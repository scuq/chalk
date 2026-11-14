package server

import (
	"context"
	"encoding/json"
	"io"
	"log"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/google/uuid"

	"github.com/scuq/chalk/internal/pubsub"
	"github.com/scuq/chalk/internal/store"
	"github.com/scuq/chalk/internal/webpush"
)

// 65-5: these tests check who gets a push, what it says, and what happens to
// the subscription. The store and the sender are fakes.

type fakePushData struct {
	msg       store.Message
	ch        pushChannel
	memberIDs []uuid.UUID
	onlineU   map[uuid.UUID]bool
	handles   map[uuid.UUID]string
	subs      []store.PushSubscription
	badgeN    map[uuid.UUID]int
	gotKey    string
	gotIsDM   bool
	gotUsers  []uuid.UUID
	deleted   []uuid.UUID
	touched   []uuid.UUID
}

func (f *fakePushData) message(context.Context, time.Time, uuid.UUID) (store.Message, error) {
	return f.msg, nil
}
func (f *fakePushData) channel(context.Context, uuid.UUID) (pushChannel, error) { return f.ch, nil }
func (f *fakePushData) members(context.Context, uuid.UUID) ([]uuid.UUID, error) {
	return f.memberIDs, nil
}
func (f *fakePushData) online(context.Context, []uuid.UUID) (map[uuid.UUID]bool, error) {
	return f.onlineU, nil
}
func (f *fakePushData) handle(_ context.Context, id uuid.UUID) (string, error) {
	return f.handles[id], nil
}
func (f *fakePushData) subscriptions(_ context.Context, users []uuid.UUID, isDM bool, key string) ([]store.PushSubscription, error) {
	f.gotUsers, f.gotIsDM, f.gotKey = users, isDM, key
	var out []store.PushSubscription
	for _, s := range f.subs {
		for _, u := range users {
			if s.UserID == u {
				out = append(out, s)
			}
		}
	}
	return out, nil
}
func (f *fakePushData) badges(context.Context, []uuid.UUID) (map[uuid.UUID]int, error) {
	return f.badgeN, nil
}
func (f *fakePushData) deleteSubscription(_ context.Context, id uuid.UUID) error {
	f.deleted = append(f.deleted, id)
	return nil
}
func (f *fakePushData) touchSubscription(_ context.Context, id uuid.UUID) error {
	f.touched = append(f.touched, id)
	return nil
}

type sentPush struct {
	endpoint string
	payload  map[string]any
	opts     webpush.Options
}

type fakeSender struct {
	mu   sync.Mutex
	sent []sentPush
	errs map[string]error // by endpoint
}

func (s *fakeSender) Send(_ context.Context, sub webpush.Subscription, payload []byte, opts webpush.Options) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	var m map[string]any
	_ = json.Unmarshal(payload, &m)
	s.sent = append(s.sent, sentPush{endpoint: sub.Endpoint, payload: m, opts: opts})
	return s.errs[sub.Endpoint]
}
func (s *fakeSender) PublicKey() string { return "CURKEY" }

type pushFixture struct {
	data                    *fakePushData
	sender                  *fakeSender
	d                       *pushDispatcher
	alice, bob, carol, dave uuid.UUID
	event                   pubsub.Event
}

func newPushFixture() *pushFixture {
	alice, bob, carol, dave := uuid.New(), uuid.New(), uuid.New(), uuid.New()
	chID, msgID, thread := uuid.New(), uuid.New(), uuid.New()
	data := &fakePushData{
		msg: store.Message{ID: msgID, ChannelID: chID, SenderUserID: alice, ThreadID: &thread,
			Body: []byte("SECRET-CIPHERTEXT")},
		ch:        pushChannel{Name: "general"},
		memberIDs: []uuid.UUID{alice, bob, carol, dave},
		onlineU:   map[uuid.UUID]bool{carol: true},
		handles:   map[uuid.UUID]string{alice: "alice"},
		subs: []store.PushSubscription{
			{ID: uuid.New(), UserID: alice, Endpoint: "https://push.cyberdyne.example/alice"},
			{ID: uuid.New(), UserID: bob, Endpoint: "https://push.cyberdyne.example/bob-phone"},
			{ID: uuid.New(), UserID: bob, Endpoint: "https://push.cyberdyne.example/bob-laptop"},
			{ID: uuid.New(), UserID: carol, Endpoint: "https://push.cyberdyne.example/carol"},
		},
		badgeN: map[uuid.UUID]int{bob: 3},
	}
	sender := &fakeSender{errs: map[string]error{}}
	d := newPushDispatcher(data, sender, "inst-1", log.New(io.Discard, "", 0))
	return &pushFixture{data: data, sender: sender, d: d, alice: alice, bob: bob, carol: carol, dave: dave,
		event: pubsub.Event{Kind: "message", MessageID: msgID, ChannelID: chID, InstanceID: "inst-1"}}
}

func (f *pushFixture) endpoints() []string {
	var out []string
	for _, s := range f.sender.sent {
		out = append(out, s.endpoint)
	}
	return out
}

func TestPushDispatchRecipients(t *testing.T) {
	f := newPushFixture()
	f.d.dispatch(context.Background(), f.event)

	// Alice is the sender. Carol is online. Dave has no subscription.
	// Both devices of bob get the push.
	got := strings.Join(f.endpoints(), ",")
	if got != "https://push.cyberdyne.example/bob-phone,https://push.cyberdyne.example/bob-laptop" {
		t.Fatalf("pushed to %s", got)
	}
	for _, u := range f.data.gotUsers {
		if u == f.alice || u == f.carol {
			t.Fatalf("subscriptions asked for %s", u)
		}
	}
	if f.data.gotKey != "CURKEY" || f.data.gotIsDM {
		t.Fatalf("subscriptions asked with key %q isDM %v", f.data.gotKey, f.data.gotIsDM)
	}
	if len(f.data.touched) != 2 || len(f.data.deleted) != 0 {
		t.Fatalf("touched %d deleted %d", len(f.data.touched), len(f.data.deleted))
	}
}

func TestPushDispatchPayload(t *testing.T) {
	f := newPushFixture()
	f.d.dispatch(context.Background(), f.event)
	if len(f.sender.sent) == 0 {
		t.Fatal("nothing sent")
	}
	p := f.sender.sent[0]
	want := map[string]any{
		"v": 1.0, "kind": "message", "channel_id": f.data.msg.ChannelID.String(),
		"message_id": f.data.msg.ID.String(), "thread_id": f.data.msg.ThreadID.String(),
		"sender_handle": "alice", "channel_name": "general", "is_dm": false, "unread": 3.0,
	}
	if len(p.payload) != len(want) {
		t.Fatalf("payload has keys %v", p.payload)
	}
	for k, v := range want {
		if p.payload[k] != v {
			t.Fatalf("payload[%s] = %v, want %v", k, p.payload[k], v)
		}
	}
	raw, _ := json.Marshal(p.payload)
	if strings.Contains(string(raw), "SECRET") {
		t.Fatal("message body reached the payload")
	}
	if p.opts.TTL != pushTTL || p.opts.Topic != "chalk" || p.opts.Urgency != webpush.UrgencyNormal {
		t.Fatalf("options %+v", p.opts)
	}
}

func TestPushDispatchDM(t *testing.T) {
	f := newPushFixture()
	f.data.ch = pushChannel{Name: "dm-bob", IsDM: true}
	f.data.memberIDs = []uuid.UUID{f.alice, f.bob}
	f.d.dispatch(context.Background(), f.event)
	if !f.data.gotIsDM {
		t.Fatal("subscriptions not asked for a DM")
	}
	if _, has := f.sender.sent[0].payload["channel_name"]; has {
		t.Fatal("a DM push names the channel")
	}
	if f.sender.sent[0].payload["is_dm"] != true {
		t.Fatal("is_dm not set")
	}
}

func TestPushDispatchSkips(t *testing.T) {
	f := newPushFixture()
	f.data.ch.Voice = true
	f.d.dispatch(context.Background(), f.event)
	if len(f.sender.sent) != 0 {
		t.Fatal("voice room chat pushed")
	}

	f = newPushFixture()
	ev := f.event
	ev.ChannelID = store.DefaultChannelID
	f.d.dispatch(context.Background(), ev)
	if len(f.sender.sent) != 0 {
		t.Fatal("default channel pushed")
	}

	f = newPushFixture()
	f.data.onlineU = map[uuid.UUID]bool{f.bob: true, f.carol: true, f.dave: true}
	f.d.dispatch(context.Background(), f.event)
	if len(f.sender.sent) != 0 {
		t.Fatal("pushed although everyone is online")
	}
}

func TestPushDispatchCooldown(t *testing.T) {
	f := newPushFixture()
	f.d.dispatch(context.Background(), f.event)
	n := len(f.sender.sent)
	f.d.dispatch(context.Background(), f.event)
	if len(f.sender.sent) != n {
		t.Fatal("a second message in the cooldown pushed again")
	}
	// Another channel has its own cooldown.
	f.data.msg.ChannelID = uuid.New()
	f.d.dispatch(context.Background(), f.event)
	if len(f.sender.sent) != 2*n {
		t.Fatalf("other channel: %d pushes, want %d", len(f.sender.sent)-n, n)
	}
}

func TestPushDispatchPrunesGone(t *testing.T) {
	f := newPushFixture()
	f.sender.errs["https://push.cyberdyne.example/bob-phone"] = webpush.ErrGone
	f.sender.errs["https://push.cyberdyne.example/bob-laptop"] = &webpush.StatusError{Code: 429}
	f.d.dispatch(context.Background(), f.event)
	if len(f.data.deleted) != 1 || f.data.deleted[0] != f.data.subs[1].ID {
		t.Fatalf("deleted %v", f.data.deleted)
	}
	if len(f.data.touched) != 0 {
		t.Fatalf("touched %v after failures", f.data.touched)
	}
}

func TestPushOnMessageInstanceGuard(t *testing.T) {
	f := newPushFixture()
	other := f.event
	other.InstanceID = "inst-2"
	f.d.onMessage(other)
	if len(f.d.queue) != 0 {
		t.Fatal("another instance's event was queued")
	}
	f.d.onMessage(f.event)
	if len(f.d.queue) != 1 {
		t.Fatal("own event not queued")
	}
	// A full queue drops the event and does not block the listener.
	for i := 0; i < pushQueueLen+5; i++ {
		f.d.onMessage(f.event)
	}
	if len(f.d.queue) != pushQueueLen {
		t.Fatalf("queue length %d", len(f.d.queue))
	}
}

func TestPushRunStopsWithContext(t *testing.T) {
	f := newPushFixture()
	ctx, cancel := context.WithCancel(context.Background())
	done := make(chan struct{})
	go func() { f.d.run(ctx); close(done) }()
	f.d.onMessage(f.event)
	deadline := time.Now().Add(2 * time.Second)
	for {
		f.sender.mu.Lock()
		n := len(f.sender.sent)
		f.sender.mu.Unlock()
		if n > 0 {
			break
		}
		if time.Now().After(deadline) {
			t.Fatal("workers sent nothing")
		}
		time.Sleep(5 * time.Millisecond)
	}
	cancel()
	select {
	case <-done:
	case <-time.After(2 * time.Second):
		t.Fatal("run did not return after cancel")
	}
}

func TestPushPayloadFits(t *testing.T) {
	p := pushPayload{V: 1, Kind: "message", ChannelID: uuid.NewString(), MessageID: uuid.NewString(),
		ThreadID: uuid.NewString(), IsDM: false, Unread: store.MaxPushBadge,
		SenderHandle: strings.Repeat("\U0001F600", maxPushName),
		ChannelName:  strings.Repeat("\U0001F600", maxPushName)}
	b, _ := json.Marshal(p)
	if len(b) > webpush.PaddedLen-1 {
		t.Fatalf("largest payload is %d bytes, more than %d", len(b), webpush.PaddedLen-1)
	}
}
