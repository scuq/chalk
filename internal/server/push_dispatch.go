package server

// 65-5: the web push dispatcher.
// When a new message is committed, the instance that published it sends a push.
// The push goes to each channel member who is not the sender and has no online device.
//
// The payload holds no message content.
// The server has only ciphertext, and pushPayload has no field for a body.
// The payload carries the sender's handle, the name and kind of the channel, ids, and a badge count.
// RFC 8291 encrypts the payload to the browser, and webpush pads it to one fixed length.
// The push service therefore sees neither the names nor their length.
//
// The pubsub listener calls onMessage on its own goroutine, so onMessage only queues the event.
// A small pool of workers does the database reads and the HTTP requests.

import (
	"context"
	"encoding/json"
	"errors"
	"log"
	"sync"
	"time"

	"github.com/google/uuid"

	"github.com/scuq/chalk/internal/pubsub"
	"github.com/scuq/chalk/internal/ratelimit"
	"github.com/scuq/chalk/internal/store"
	"github.com/scuq/chalk/internal/webpush"
)

const (
	// pushQueueLen is the number of message events that wait for a worker.
	// If the queue is full, the dispatcher drops the event and sends none of its pushes.
	pushQueueLen = 256
	// pushWorkers is the number of events handled at the same time.
	pushWorkers = 4
	// pushCooldown is the shortest time between two pushes to one user for
	// one channel. A burst of messages gives one push.
	pushCooldown = 60 * time.Second
	// pushTTL is how long a push service keeps an undelivered push.
	pushTTL = 24 * time.Hour
	// pushTopic is the Topic header of every push. It is a constant, so it
	// names no channel. A push service that holds several undelivered
	// pushes with one topic keeps only the newest. 65-13: The value must
	// have at most 32 characters and must be a canonical base64url string.
	// Apple answers BadWebPushTopic to "chalk".
	pushTopic = "chalkmsg"
	// pushEventTimeout is the time limit for the work on one message event.
	pushEventTimeout = 30 * time.Second
	// maxPushName caps a handle or channel name in the payload, so the
	// payload always fits webpush.PaddedLen.
	maxPushName = 80
)

// pushPayload is the plaintext of every push. On purpose, it has no field
// for message content.
type pushPayload struct {
	V            int    `json:"v"`
	Kind         string `json:"kind"`
	ChannelID    string `json:"channel_id"`
	MessageID    string `json:"message_id"`
	ThreadID     string `json:"thread_id,omitempty"`
	SenderHandle string `json:"sender_handle"`
	ChannelName  string `json:"channel_name,omitempty"`
	IsDM         bool   `json:"is_dm"`
	Unread       int    `json:"unread"`
}

// pushChannel holds the channel facts that the dispatcher needs.
type pushChannel struct {
	Name  string
	IsDM  bool
	Voice bool
}

// pushData is the part of the database that the dispatcher reads and writes.
type pushData interface {
	message(ctx context.Context, ts time.Time, id uuid.UUID) (store.Message, error)
	channel(ctx context.Context, id uuid.UUID) (pushChannel, error)
	members(ctx context.Context, channelID uuid.UUID) ([]uuid.UUID, error)
	online(ctx context.Context, userIDs []uuid.UUID) (map[uuid.UUID]bool, error)
	handle(ctx context.Context, userID uuid.UUID) (string, error)
	subscriptions(ctx context.Context, userIDs []uuid.UUID, isDM bool, vapidKey string) ([]store.PushSubscription, error)
	badges(ctx context.Context, userIDs []uuid.UUID) (map[uuid.UUID]int, error)
	deleteSubscription(ctx context.Context, id uuid.UUID) error
	touchSubscription(ctx context.Context, id uuid.UUID) error
	// 87-8: the wake records that are due. See store.ClaimDueReminderWakes.
	claimReminderWakes(ctx context.Context, now time.Time, limit int) ([]store.DueReminderWake, error)
}

// pushSender is the part of *webpush.Sender the dispatcher uses.
type pushSender interface {
	Send(ctx context.Context, sub webpush.Subscription, payload []byte, opts webpush.Options) error
	PublicKey() string
}

// pushDispatcher queues message events and sends their pushes.
type pushDispatcher struct {
	data       pushData
	sender     pushSender
	instanceID string
	logger     *log.Logger
	cooldown   *ratelimit.RateLimiter
	queue      chan pubsub.Event
}

// newPushDispatcher returns a dispatcher that sends only the events that instanceID published.
func newPushDispatcher(data pushData, sender pushSender, instanceID string, logger *log.Logger) *pushDispatcher {
	return &pushDispatcher{
		data:       data,
		sender:     sender,
		instanceID: instanceID,
		logger:     logger,
		cooldown:   ratelimit.New(1, pushCooldown),
		queue:      make(chan pubsub.Event, pushQueueLen),
	}
}

// onMessage queues ev if this instance published it.
// Every instance that listens on the channel receives the event.
// Only the publisher pushes, so each message is pushed once.
// onMessage never blocks. If the queue is full, it drops ev and logs.
func (d *pushDispatcher) onMessage(ev pubsub.Event) {
	if ev.InstanceID != d.instanceID {
		return
	}
	select {
	case d.queue <- ev:
	default:
		d.logger.Printf("push: queue full, message %s not pushed", ev.MessageID)
	}
}

// run starts the workers. It returns after ctx ends and all workers stop.
func (d *pushDispatcher) run(ctx context.Context) {
	var wg sync.WaitGroup
	for i := 0; i < pushWorkers; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			for {
				select {
				case <-ctx.Done():
					return
				case ev := <-d.queue:
					ectx, cancel := context.WithTimeout(ctx, pushEventTimeout)
					d.dispatch(ectx, ev)
					cancel()
				}
			}
		}()
	}
	wg.Wait()
}

// dispatch sends the pushes for one message event.
// It sends none for the default channel or for the chat of a voice room.
// If the read of the message, channel, members, presence, or subscriptions
// fails, it logs and returns.
// If the read of the sender handle or the badges fails, it logs and sends
// the push without them.
func (d *pushDispatcher) dispatch(ctx context.Context, ev pubsub.Event) {
	if ev.ChannelID == store.DefaultChannelID {
		return // the default channel has no members
	}
	msg, err := d.data.message(ctx, ev.TS, ev.MessageID)
	if err != nil {
		d.logger.Printf("push: message %s: %v", ev.MessageID, err)
		return
	}
	ch, err := d.data.channel(ctx, msg.ChannelID)
	if err != nil {
		d.logger.Printf("push: channel %s: %v", msg.ChannelID, err)
		return
	}
	if ch.Voice {
		return // the chat of a voice room does not push
	}
	members, err := d.data.members(ctx, msg.ChannelID)
	if err != nil {
		d.logger.Printf("push: members of %s: %v", msg.ChannelID, err)
		return
	}
	online, err := d.data.online(ctx, members)
	if err != nil {
		d.logger.Printf("push: presence: %v", err)
		return
	}
	var away []uuid.UUID
	for _, uid := range members {
		if uid != msg.SenderUserID && !online[uid] {
			away = append(away, uid)
		}
	}
	if len(away) == 0 {
		return
	}
	subs, err := d.data.subscriptions(ctx, away, ch.IsDM, d.sender.PublicKey())
	if err != nil {
		d.logger.Printf("push: subscriptions: %v", err)
		return
	}
	// Decide the cooldown once for each user.
	// All devices of a user then get the same pushes.
	var users []uuid.UUID
	allowed := map[uuid.UUID]bool{}
	byUser := map[uuid.UUID][]store.PushSubscription{}
	for _, sub := range subs {
		ok, decided := allowed[sub.UserID]
		if !decided {
			ok = d.cooldown.Allow(sub.UserID.String() + ":" + msg.ChannelID.String())
			allowed[sub.UserID] = ok
			if ok {
				users = append(users, sub.UserID)
			}
		}
		if ok {
			byUser[sub.UserID] = append(byUser[sub.UserID], sub)
		}
	}
	if len(users) == 0 {
		return
	}
	senderHandle, err := d.data.handle(ctx, msg.SenderUserID)
	if err != nil {
		d.logger.Printf("push: sender handle: %v", err)
		senderHandle = ""
	}
	badges, err := d.data.badges(ctx, users)
	if err != nil {
		d.logger.Printf("push: badges: %v", err)
		badges = map[uuid.UUID]int{}
	}
	base := pushPayload{
		V:            1,
		Kind:         "message",
		ChannelID:    msg.ChannelID.String(),
		MessageID:    msg.ID.String(),
		SenderHandle: capRunes(senderHandle, maxPushName),
		IsDM:         ch.IsDM,
	}
	if msg.ThreadID != nil {
		base.ThreadID = msg.ThreadID.String()
	}
	if !ch.IsDM {
		// The stored name of a DM is a client label.
		// The title of a DM push is the sender.
		base.ChannelName = capRunes(ch.Name, maxPushName)
	}
	opts := webpush.Options{TTL: pushTTL, Topic: pushTopic, Urgency: webpush.UrgencyNormal}
	for _, uid := range users {
		p := base
		p.Unread = badges[uid]
		body, err := json.Marshal(p)
		if err != nil {
			continue
		}
		for _, sub := range byUser[uid] {
			d.send(ctx, sub, body, opts)
		}
	}
}

// send posts one push to sub.
// On success, it touches the subscription.
// If the push service answers [webpush.ErrGone], it deletes the subscription.
// After any other error, it only logs.
func (d *pushDispatcher) send(ctx context.Context, sub store.PushSubscription, body []byte, opts webpush.Options) {
	err := d.sender.Send(ctx, webpush.Subscription{Endpoint: sub.Endpoint, P256dh: sub.P256dh, Auth: sub.Auth}, body, opts)
	switch {
	case err == nil:
		if terr := d.data.touchSubscription(ctx, sub.ID); terr != nil {
			d.logger.Printf("push: touch %s: %v", sub.ID, terr)
		}
	case errors.Is(err, webpush.ErrGone):
		if derr := d.data.deleteSubscription(ctx, sub.ID); derr != nil {
			d.logger.Printf("push: delete %s: %v", sub.ID, derr)
		}
	default:
		d.logger.Printf("push: send to subscription %s: %v", sub.ID, err)
	}
}

// capRunes returns s cut to at most n runes.
func capRunes(s string, n int) string {
	r := []rune(s)
	if len(r) <= n {
		return s
	}
	return string(r[:n])
}

// storePushData implements pushData with the store and the presence store.
// If pr is nil, no user counts as online.
type storePushData struct {
	st *store.Store
	pr presenceOnline
}

// presenceOnline is the presence query that the dispatcher needs.
type presenceOnline interface {
	OnlineUsers(ctx context.Context, userIDs []uuid.UUID) (map[uuid.UUID]bool, error)
}

func (s storePushData) message(ctx context.Context, ts time.Time, id uuid.UUID) (store.Message, error) {
	return s.st.GetMessage(ctx, ts, id)
}

func (s storePushData) channel(ctx context.Context, id uuid.UUID) (pushChannel, error) {
	ch, err := s.st.GetChannel(ctx, id)
	if err != nil {
		return pushChannel{}, err
	}
	return pushChannel{Name: ch.Name, IsDM: ch.IsDM, Voice: ch.ChannelType == "voice"}, nil
}

func (s storePushData) members(ctx context.Context, channelID uuid.UUID) ([]uuid.UUID, error) {
	return s.st.ListMembersForChannel(ctx, channelID)
}

func (s storePushData) online(ctx context.Context, userIDs []uuid.UUID) (map[uuid.UUID]bool, error) {
	if s.pr == nil {
		return map[uuid.UUID]bool{}, nil
	}
	return s.pr.OnlineUsers(ctx, userIDs)
}

func (s storePushData) handle(ctx context.Context, userID uuid.UUID) (string, error) {
	m, err := s.st.HandlesByID(ctx, []uuid.UUID{userID})
	if err != nil {
		return "", err
	}
	return m[userID], nil
}

func (s storePushData) subscriptions(ctx context.Context, userIDs []uuid.UUID, isDM bool, vapidKey string) ([]store.PushSubscription, error) {
	return s.st.ListPushSubscriptionsForUsers(ctx, userIDs, isDM, vapidKey)
}

func (s storePushData) badges(ctx context.Context, userIDs []uuid.UUID) (map[uuid.UUID]int, error) {
	return s.st.PushBadges(ctx, userIDs)
}

func (s storePushData) deleteSubscription(ctx context.Context, id uuid.UUID) error {
	return s.st.DeletePushSubscription(ctx, id)
}

func (s storePushData) touchSubscription(ctx context.Context, id uuid.UUID) error {
	return s.st.TouchPushSubscription(ctx, id)
}

func (s storePushData) claimReminderWakes(ctx context.Context, now time.Time, limit int) ([]store.DueReminderWake, error) {
	return s.st.ClaimDueReminderWakes(ctx, now, limit)
}
