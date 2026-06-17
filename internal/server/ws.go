package server

import (
	"context"
	"encoding/json"
	"errors"
	"log"
	"net/http"
	"sync"
	"time"

	"github.com/coder/websocket"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"

	"github.com/scuq/chalk/internal/auth"
	"github.com/scuq/chalk/internal/friends"
	"github.com/scuq/chalk/internal/presence"
	"github.com/scuq/chalk/internal/proto"
	"github.com/scuq/chalk/internal/pubsub"
	"github.com/scuq/chalk/internal/store"
)

// WSConfig tunes WebSocket behavior.
type WSConfig struct {
	PingInterval     time.Duration
	PingTimeout      time.Duration
	WriteTimeout     time.Duration
	HandshakeTimeout time.Duration
}

// DefaultWSConfig returns production defaults.
func DefaultWSConfig() WSConfig {
	return WSConfig{
		PingInterval:     15 * time.Second,
		PingTimeout:      30 * time.Second,
		WriteTimeout:     10 * time.Second,
		HandshakeTimeout: 5 * time.Second,
	}
}

// FriendPublisher publishes a Kind="friend" NOTIFY. Implemented by
// server.go to keep this file free of transaction plumbing.
type FriendPublisher func(ctx context.Context, recipient, fromUser uuid.UUID, kind string) error

// WSHandler upgrades HTTP requests to chalk's WebSocket protocol and
// runs per-connection read/write/ping/presence loops.
//
// Phase 06 adds presence and friends dependencies plus two publishers
// (for presence transitions and friend events). Both publishers are
// optional; nil disables the corresponding push path. Tests that don't
// care about cross-instance push can pass nil.
type WSHandler struct {
	hub        *Hub
	store      *store.Store
	cfg        WSConfig
	logger     *log.Logger
	instanceID string

	presence *presence.Store
	friends  *friends.Store

	publishPresenceChange presence.Notifier
	publishFriend         FriendPublisher
	// Phase 9.7a: fanout for prefs_changed pushes to a user's other
	// devices/tabs. Optional; nil disables the push.
	publishPrefsChange PrefsChangePublisher

	// Phase 08: listener is used for dynamic per-channel subscribe/
	// unsubscribe at WS connect/disconnect time. nil disables phase 08
	// channel routing -- the SPA can still talk to the default channel
	// via the fallback path, but won't receive cross-instance pushes
	// for any other channel.
	listener *pubsub.Listener

	// Phase 08b: per-conn subscribed-topics tracking. Keyed by *Conn
	// pointer. Populated by the hello-time loop in ServeHTTP and by
	// handleSubscribeChannel; drained by releaseConnSubs at disconnect.
	// See ws_phase08b.go for the helpers.
	connSubs sync.Map
}

// NewWSHandler constructs a handler. Phase 06 adds the presence/friends
// stores and the two publishers. Phase 08 adds the listener so the WS
// layer can subscribe/unsubscribe per-channel topics.
func NewWSHandler(
	hub *Hub,
	st *store.Store,
	cfg WSConfig,
	instanceID string,
	logger *log.Logger,
	presenceStore *presence.Store,
	friendsStore *friends.Store,
	pubPresence presence.Notifier,
	pubFriend FriendPublisher,
	pubPrefs PrefsChangePublisher,
	listener *pubsub.Listener,
) *WSHandler {
	if logger == nil {
		logger = log.Default()
	}
	return &WSHandler{
		hub:                   hub,
		store:                 st,
		cfg:                   cfg,
		logger:                logger,
		instanceID:            instanceID,
		presence:              presenceStore,
		friends:               friendsStore,
		publishPresenceChange: pubPresence,
		publishFriend:         pubFriend,
		publishPrefsChange:    pubPrefs,
		listener:              listener,
	}
}

// ServeHTTP upgrades and serves one WebSocket connection.
func (h *WSHandler) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	c, err := websocket.Accept(w, r, &websocket.AcceptOptions{
		Subprotocols: []string{proto.Subprotocol},
	})
	if err != nil {
		h.logger.Printf("ws accept: %v", err)
		return
	}
	if c.Subprotocol() != proto.Subprotocol {
		_ = c.Close(websocket.StatusPolicyViolation, "subprotocol required: "+proto.Subprotocol)
		return
	}
	c.SetReadLimit(proto.MaxFrameBytes)

	ctx, cancel := context.WithCancel(r.Context())
	defer cancel()

	helloCtx, helloCancel := context.WithTimeout(ctx, 5*time.Second)
	hello, err := readHello(helloCtx, c)
	helloCancel()
	if err != nil {
		_ = c.Close(websocket.StatusPolicyViolation, "hello required")
		h.logger.Printf("ws hello: %v", err)
		return
	}

	deviceID, err := uuid.Parse(hello.DeviceID)
	if err != nil {
		_ = c.Close(websocket.StatusPolicyViolation, "device_id must be a UUID")
		return
	}

	// Phase 09b sub-step 5: resolve session from cookie. The cookie
	// is sent automatically by the browser in the WS upgrade request.
	// Missing / invalid cookie → close with policy violation; the
	// SPA treats that as a signal to render LoginScreen.
	var sessionUser *auth.SessionUser
	if h.store != nil {
		su, sErr := auth.ResolveSession(ctx, h.store, r)
		if sErr != nil {
			// Distinguish "no cookie" from "expired/invalid" via the
			// close reason so the SPA can show a different message
			// (logged out vs session expired).
			reason := "no session"
			if errors.Is(sErr, auth.ErrInvalidSession) {
				reason = "session expired"
			} else if !errors.Is(sErr, auth.ErrNoSession) {
				h.logger.Printf("ws session resolve: %v", sErr)
				reason = "session error"
			}
			// Phase 9.5 (C2): log the reject so operators can
			// distinguish silent 1008 closes from other failures.
			// Without this, an SPA stuck in 'offline' state with
			// no server-side trace is mysterious to debug.
			h.logger.Printf("ws session reject: %s (device=%s)", reason, deviceID)
			_ = c.Close(websocket.StatusPolicyViolation, reason)
			return
		}
		sessionUser = su
	}

	// Phase 09b sub-step 6: strict gate. Every WS connection is
	// bound to the session-resolved user; there's no legacy fallback
	// anymore. The ensureDeviceForTesting shim that tied unknown
	// devices to alice was removed in this sub-step.
	if h.store != nil && sessionUser != nil {
		if err := ensureDeviceForUser(ctx, h.store, deviceID, sessionUser.UserID); err != nil {
			h.logger.Printf("ensure device: %v", err)
			_ = c.Close(websocket.StatusInternalError, "ensure device failed")
			return
		}
		// Best-effort: bump last_seen_at on the user. We don't fail
		// the connection if this errors.
		_, _ = h.store.Pool.Exec(ctx,
			`UPDATE users SET last_seen_at = now()
			   WHERE id = (SELECT user_id FROM devices WHERE id = $1)
			   AND status = 'active'`,
			deviceID,
		)
		// Phase-06 lifecycle gate: reject the connection if the user
		// is not active.
		var status string
		err := h.store.Pool.QueryRow(ctx,
			`SELECT u.status FROM devices d
			   JOIN users u ON u.id = d.user_id
			  WHERE d.id = $1`,
			deviceID,
		).Scan(&status)
		if err == nil && status != "active" {
			_ = c.Close(websocket.StatusPolicyViolation, "account "+status)
			return
		}
	}

	// Phase 09b sub-step 5: the user is already resolved via the
	// session cookie above; no need for a separate lookupUserForDevice
	// round-trip. If sessionUser is nil (only possible when h.store
	// is nil, i.e. a test that wires no store), fall back to the
	// legacy device lookup so existing test paths keep working.
	var connUserUUID uuid.UUID
	var connUserID string
	if sessionUser != nil {
		connUserUUID = sessionUser.UserID
		connUserID = sessionUser.UserID.String()
	} else if h.store != nil {
		if uid := h.lookupUserForDevice(ctx, deviceID); uid != uuid.Nil {
			connUserUUID = uid
			connUserID = uid.String()
		}
	}

	// Phase 09a: each connection gets a fresh server-generated UUID
	// distinct from the (client-provided) device_id. Two browser tabs
	// from the same device share a device_id but each get their own
	// connID, which step 2 will use as the routing key so the tabs
	// don't evict each other.
	connID := uuid.New().String()

	conn := NewConn(connID, hello.DeviceID, connUserID, func(reason error) {
		msg := "closed"
		if reason != nil {
			msg = reason.Error()
		}
		_ = c.Close(websocket.StatusNormalClosure, msg)
		cancel()
	})
	defer conn.MarkDone()

	h.hub.Register(conn)
	defer h.hub.Unregister(conn)

	// Phase 08: subscribe to per-channel NOTIFY topics for every
	// channel this user is a member of. Each Subscribe is refcounted
	// inside the listener, so multiple connected devices for the same
	// user share a single LISTEN. We track the list of topics we
	// subscribed FROM THIS CONNECTION via h.connSubs so disconnect
	// can unsubscribe the same set (decrementing refcounts).
	//
	// Phase 08b: the connSubs entry is also used by handleSubscribeChannel
	// to append topics added mid-session. The defer below drains
	// whatever's there at close time.
	//
	// If the user lookup failed (connUserUUID == Nil), we skip --
	// phase 08 features require a real user identity. The user can
	// still send to the default channel via the fallback path.
	subsEntry := h.withSubs(conn)
	channelIDs := []string{}
	if connUserUUID != uuid.Nil && h.store != nil && h.listener != nil {
		channels, err := h.store.ListChannelsForUser(ctx, connUserUUID)
		if err != nil {
			h.logger.Printf("list channels on hello: %v", err)
		} else {
			subsEntry.mu.Lock()
			for _, ch := range channels {
				topic := pubsub.ChannelTopic(ch.ID)
				subCtx, subCancel := context.WithTimeout(ctx, 2*time.Second)
				err := h.listener.Subscribe(subCtx, topic)
				subCancel()
				if err != nil {
					h.logger.Printf("subscribe %s: %v", topic, err)
					continue
				}
				subsEntry.topics = append(subsEntry.topics, topic)
				channelIDs = append(channelIDs, ch.ID.String())
			}
			subsEntry.mu.Unlock()
		}
	}
	defer h.releaseConnSubs(conn)

	// Welcome.
	//
	// Phase 08c: look up the caller's handle and include it so the SPA
	// can render "you (alice)" in the status badge instead of just
	// "you". Lookup failure is non-fatal; handle stays empty and the
	// SPA falls back to "you".
	var handle string
	if connUserUUID != uuid.Nil && h.store != nil {
		hLookup, err := h.store.HandlesByID(ctx, []uuid.UUID{connUserUUID})
		if err != nil {
			h.logger.Printf("welcome handle lookup: %v", err)
		} else {
			handle = hLookup[connUserUUID]
		}
	}
	// Phase 09b sub-step 5: populate the extended welcome payload
	// from the resolved session. The pre-09b "handle" field is kept
	// (lowercase username) for transitional SPAs.
	welcomePayload := proto.WelcomePayload{
		UserID:   conn.UserID,
		DeviceID: conn.DeviceID,
		Handle:   handle,
		Channels: channelIDs,
	}
	if sessionUser != nil {
		welcomePayload.Username = sessionUser.Username
		welcomePayload.DisplayName = sessionUser.DisplayName
		welcomePayload.Role = sessionUser.Role
		welcomePayload.SessionExpiresAt = sessionUser.Session.ExpiresAt
		// email_verified is true iff users.email_verified_at is non-null.
		// SessionUser doesn't carry the timestamp directly; we look it up.
		if h.store != nil {
			if u, err := h.store.GetUserByID(ctx, sessionUser.UserID); err == nil {
				welcomePayload.EmailVerified = !u.EmailVerifiedAt.IsZero()
			}
		}
	}
	welcome, _ := proto.NewFrame(proto.TypeWelcome, "", welcomePayload)
	wb, _ := json.Marshal(welcome)
	if err := writeOne(ctx, c, wb, h.cfg.WriteTimeout); err != nil {
		h.logger.Printf("ws welcome write: %v", err)
		return
	}

	// Presence: register the device, start the heartbeat, ensure the
	// transition publishes if state changed.
	deviceType := classifyDeviceType(hello.DeviceType)
	var presenceCleanup func()
	if h.presence != nil {
		userID := h.lookupUserForDevice(ctx, deviceID)
		if userID != uuid.Nil {
			err := h.presence.SetDevicePresence(ctx, presence.DevicePresence{
				DeviceID:   deviceID,
				UserID:     userID,
				InstanceID: h.instanceID,
				DeviceType: deviceType,
				State:      presence.StateOnline,
			})
			if err == nil {
				if h.publishPresenceChange != nil {
					if err := h.publishPresenceChange(ctx, userID); err != nil {
						h.logger.Printf("publish presence on connect: %v", err)
					}
				}
				go h.startPresenceHeartbeat(ctx, deviceID, deviceType)
				presenceCleanup = func() {
					cleanCtx, cancel := context.WithTimeout(
						context.Background(), 2*time.Second)
					defer cancel()
					affectedUser, err := h.presence.ClearDevicePresence(cleanCtx, deviceID)
					if err != nil {
						h.logger.Printf("clear presence on disconnect: %v", err)
						return
					}
					if affectedUser != uuid.Nil && h.publishPresenceChange != nil {
						if err := h.publishPresenceChange(cleanCtx, affectedUser); err != nil {
							h.logger.Printf("publish presence on disconnect: %v", err)
						}
					}
				}
			} else {
				h.logger.Printf("set presence on connect: %v", err)
			}
		}
	}
	defer func() {
		if presenceCleanup != nil {
			presenceCleanup()
		}
	}()

	h.logger.Printf("ws connected: device=%s type=%s", conn.DeviceID, deviceType)
	defer h.logger.Printf("ws disconnected: device=%s", conn.DeviceID)

	doneR := make(chan struct{})
	doneW := make(chan struct{})
	go func() { defer close(doneR); h.readLoop(ctx, c, conn) }()
	go func() { defer close(doneW); h.writeLoop(ctx, c, conn) }()
	go h.pingLoop(ctx, c)

	select {
	case <-doneR:
	case <-doneW:
	case <-ctx.Done():
	}
	conn.Close(nil)
	<-doneR
	<-doneW
}

// readHello reads the first frame and asserts it's a hello.
func readHello(ctx context.Context, c *websocket.Conn) (*proto.HelloPayload, error) {
	_, data, err := c.Read(ctx)
	if err != nil {
		return nil, err
	}
	var f proto.Frame
	if err := json.Unmarshal(data, &f); err != nil {
		return nil, err
	}
	if f.Type != proto.TypeHello {
		return nil, errors.New("first frame must be hello")
	}
	var hp proto.HelloPayload
	if err := f.DecodePayload(&hp); err != nil {
		return nil, err
	}
	if hp.DeviceID == "" {
		return nil, errors.New("hello: device_id required")
	}
	return &hp, nil
}

// readLoop dispatches inbound frames by type. Each handler is
// responsible for sending its own ack/error frame.
func (h *WSHandler) readLoop(ctx context.Context, c *websocket.Conn, conn *Conn) {
	for {
		_, data, err := c.Read(ctx)
		if err != nil {
			return
		}
		var f proto.Frame
		if err := json.Unmarshal(data, &f); err != nil {
			h.sendError(ctx, c, "", proto.ErrCodeBadFrame, "invalid json")
			continue
		}
		switch f.Type {
		case proto.TypeSend:
			h.handleSend(ctx, c, conn, f)

		// Phase 06: presence
		case proto.TypePresenceSubscribe:
			h.handlePresenceSubscribe(ctx, c, conn, f)
		case proto.TypePresenceUnsubscribe:
			h.handlePresenceUnsubscribe(ctx, c, conn, f)
		case proto.TypePresenceUpdate:
			h.handlePresenceUpdate(ctx, c, conn, f)

		// Phase 06: friends
		case proto.TypeFriendRequest:
			h.handleFriendRequest(ctx, c, conn, f)
		case proto.TypeFriendAccept:
			h.handleFriendAccept(ctx, c, conn, f)
		case proto.TypeFriendDecline:
			h.handleFriendDecline(ctx, c, conn, f)
		case proto.TypeFriendRemove:
			h.handleFriendRemove(ctx, c, conn, f)
		case proto.TypeFriendBlock:
			h.handleFriendBlock(ctx, c, conn, f)
		case proto.TypeFriendUnblock:
			h.handleFriendUnblock(ctx, c, conn, f)
		case proto.TypeFriendList:
			h.handleFriendList(ctx, c, conn, f)

		// Phase 08: channels
		case proto.TypeCreateChannel:
			h.handleCreateChannel(ctx, c, conn, f)
		case proto.TypeListChannels:
			h.handleListChannels(ctx, c, conn, f)
		case proto.TypeFetchHistory:
			h.handleFetchHistory(ctx, c, conn, f)

		// Phase 08b: subscribe to a channel mid-session
		case proto.TypeSubscribeChannel:
			h.handleSubscribeChannel(ctx, c, conn, f)

		// Phase 10a: thread fetch
		case proto.TypeFetchThread:
			h.handleFetchThread(ctx, c, conn, f)

		// Phase 9.7a: user preferences
		case proto.TypePrefsGet:
			h.handlePrefsGet(ctx, c, conn, f)
		case proto.TypePrefsSet:
			h.handlePrefsSet(ctx, c, conn, f)

		default:
			h.sendError(ctx, c, f.Ref, proto.ErrCodeUnknownType,
				"unknown frame type: "+f.Type)
		}
	}
}

// handleSend persists the message and emits a NOTIFY.
//
// Phase 08 routing: payload.ChannelID names the destination channel.
//   - Empty/omitted falls back to store.DefaultChannelID (transitional
//     compatibility with phase 07 SPAs that don't yet send channel_id).
//   - Non-empty is verified against channel_members; non-members get
//     errCodeNotAMember.
//   - The NOTIFY goes out on the per-channel topic so only chalkds with
//     subscribers for this channel receive it.
func (h *WSHandler) handleSend(
	ctx context.Context,
	c *websocket.Conn,
	conn *Conn,
	f proto.Frame,
) {
	var p proto.SendPayload
	if err := f.DecodePayload(&p); err != nil {
		h.sendError(ctx, c, f.Ref, proto.ErrCodeBadPayload, err.Error())
		return
	}
	if h.store == nil {
		h.sendError(ctx, c, f.Ref, proto.ErrCodeInternal, "no store configured")
		return
	}
	deviceID, err := uuid.Parse(conn.DeviceID)
	if err != nil {
		h.sendError(ctx, c, f.Ref, proto.ErrCodeBadPayload, "device_id must be a UUID")
		return
	}
	// Phase 09b sub-step 5: ensureDeviceForUser ensures the device
	// row's user_id matches the authenticated user from the WS
	// upgrade. Idempotent (ON CONFLICT DO NOTHING); the row already
	// exists from the hello-time ensure call, this is defensive
	// against rare reconnect / migration paths.
	var sendUserUUID uuid.UUID
	if conn.UserID != "" {
		if u, perr := uuid.Parse(conn.UserID); perr == nil {
			sendUserUUID = u
		}
	}
	if sendUserUUID == uuid.Nil {
		h.sendError(ctx, c, f.Ref, proto.ErrCodeInternal, "no authenticated user on conn")
		return
	}
	if err := ensureDeviceForUser(ctx, h.store, deviceID, sendUserUUID); err != nil {
		h.sendError(ctx, c, f.Ref, proto.ErrCodeInternal, "ensure device: "+err.Error())
		return
	}

	// Resolve channel_id. Empty -> default channel (phase 07 fallback).
	channelID := store.DefaultChannelID
	if p.ChannelID != "" {
		cid, perr := uuid.Parse(p.ChannelID)
		if perr != nil {
			h.sendError(ctx, c, f.Ref, proto.ErrCodeBadPayload, "channel_id must be a UUID")
			return
		}
		channelID = cid

		// Membership check (skipped for default channel -- phase 07 fallback).
		// The sender is a real user lookup; if connUserUUID is Nil
		// (anonymous), reject.
		userID := h.lookupUserForDevice(ctx, deviceID)
		if userID == uuid.Nil {
			h.sendError(ctx, c, f.Ref, proto.ErrCodeNotAMember, "anonymous senders cannot post to channels")
			return
		}
		isMember, mErr := h.store.IsMember(ctx, channelID, userID)
		if mErr != nil {
			h.sendError(ctx, c, f.Ref, proto.ErrCodeInternal, "membership check: "+mErr.Error())
			return
		}
		if !isMember {
			h.sendError(ctx, c, f.Ref, proto.ErrCodeNotAMember, "not a member of channel")
			return
		}
	}

	// Phase 10a: thread reply support.
	//
	// If the client passed parent_id, validate that the parent
	// exists in the same channel, then compute thread_id:
	//   - if the parent already belongs to a thread (parent.thread_id
	//     non-nil), the reply inherits the same thread_id. Replies-
	//     to-replies stay in the same thread.
	//   - if the parent is a top-level message (thread_id is null),
	//     the new thread's id is the parent's own id.
	var parentUUID *uuid.UUID
	var threadUUID *uuid.UUID
	if p.ParentID != "" {
		pid, perr := uuid.Parse(p.ParentID)
		if perr != nil {
			h.sendError(ctx, c, f.Ref, proto.ErrCodeInvalidParent, "parent_id not a UUID")
			return
		}
		// Validate: parent exists in this channel. Cheap PK-lookup.
		var parentChannel uuid.UUID
		var parentThread *uuid.UUID
		qerr := h.store.Pool.QueryRow(ctx,
			`SELECT channel_id, thread_id FROM messages WHERE id = $1`,
			pid,
		).Scan(&parentChannel, &parentThread)
		if qerr != nil {
			h.sendError(ctx, c, f.Ref, proto.ErrCodeInvalidParent, "parent not found")
			return
		}
		if parentChannel != channelID {
			h.sendError(ctx, c, f.Ref, proto.ErrCodeInvalidParent, "parent is in a different channel")
			return
		}
		parentUUID = &pid
		if parentThread != nil {
			threadUUID = parentThread
		} else {
			threadUUID = &pid
		}
	}

	err = pgxBegin(ctx, h.store, func(tx pgx.Tx) error {
		var seq int64
		if err := tx.QueryRow(ctx,
			`UPDATE channel_seq SET next_seq = next_seq + 1
			   WHERE channel_id = $1
			 RETURNING next_seq - 1`,
			channelID,
		).Scan(&seq); err != nil {
			return err
		}
		msgID := uuid.New()
		var ts time.Time
		bodyBytes := []byte(p.Body)
		if err := tx.QueryRow(ctx,
			`INSERT INTO messages
			   (id, channel_id, parent_id, thread_id, sender_device_id, seq, content_type, body)
			 VALUES ($1, $2, $3, $4, $5, $6, 'application', $7)
			 RETURNING ts`,
			msgID, channelID, parentUUID, threadUUID, deviceID, seq, bodyBytes,
		).Scan(&ts); err != nil {
			return err
		}
		ev := pubsub.Event{
			Kind:           "message",
			MessageID:      msgID,
			TS:             ts,
			ChannelID:      channelID,
			SenderDeviceID: deviceID,
			SenderConnID:   conn.ID, // phase 09a step 3
			InstanceID:     h.instanceID,
		}
		// Phase 08 routing: default channel uses chalk_global (phase 07
		// fallback); real channels use their per-channel topic.
		if channelID == store.DefaultChannelID {
			return pubsub.PublishWithTx(ctx, tx, ev)
		}
		return pubsub.PublishMessageWithTx(ctx, tx, ev)
	})
	if err != nil {
		h.sendError(ctx, c, f.Ref, proto.ErrCodeInternal, "send failed")
		h.logger.Printf("send: %v", err)
		return
	}
}

// pgxBegin runs fn in a transaction. Same as phase 05; unchanged.
func pgxBegin(ctx context.Context, st *store.Store, fn func(pgx.Tx) error) (err error) {
	tx, err := st.Pool.BeginTx(ctx, pgx.TxOptions{})
	if err != nil {
		return err
	}
	defer func() {
		if p := recover(); p != nil {
			_ = tx.Rollback(ctx)
			panic(p)
		}
		if err != nil {
			_ = tx.Rollback(ctx)
		}
	}()
	if err = fn(tx); err != nil {
		return err
	}
	return tx.Commit(ctx)
}

// writeLoop drains conn.Send.
func (h *WSHandler) writeLoop(ctx context.Context, c *websocket.Conn, conn *Conn) {
	for {
		select {
		case <-ctx.Done():
			return
		case <-conn.closed:
			return
		case data, ok := <-conn.Send:
			if !ok {
				return
			}
			if err := writeOne(ctx, c, data, h.cfg.WriteTimeout); err != nil {
				h.logger.Printf("ws write: %v", err)
				conn.Close(err)
				return
			}
		}
	}
}

func (h *WSHandler) pingLoop(ctx context.Context, c *websocket.Conn) {
	t := time.NewTicker(h.cfg.PingInterval)
	defer t.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-t.C:
			pingCtx, cancel := context.WithTimeout(ctx, h.cfg.PingTimeout)
			err := c.Ping(pingCtx)
			cancel()
			if err != nil {
				_ = c.Close(websocket.StatusPolicyViolation, "ping timeout")
				return
			}
		}
	}
}

func (h *WSHandler) sendError(ctx context.Context, c *websocket.Conn, ref, code, msg string) {
	frame, _ := proto.NewFrame(proto.TypeError, ref, proto.ErrorPayload{
		Code: code, Message: msg,
	})
	data, _ := json.Marshal(frame)
	if err := writeOne(ctx, c, data, h.cfg.WriteTimeout); err != nil {
		h.logger.Printf("ws send error: %v", err)
	}
}

func writeOne(ctx context.Context, c *websocket.Conn, data []byte, timeout time.Duration) error {
	wctx, cancel := context.WithTimeout(ctx, timeout)
	defer cancel()
	return c.Write(wctx, websocket.MessageText, data)
}

// ensureDeviceForUser upserts a minimal device row tied to userID.
// Phase 09b sub-step 5: replaces ensureDeviceForTesting (which
// hardcoded alice). Idempotent; safe to call multiple times for
// the same (deviceID, userID) pair.
func ensureDeviceForUser(ctx context.Context, st *store.Store, deviceID, userID uuid.UUID) error {
	// Phase 9.6f: rebind on conflict instead of skipping. When two
	// distinct users log in via the same browser, the second login
	// inherited the first's device row under the old DO NOTHING
	// behavior, causing lookupUserForDevice to return the wrong
	// user_id for the second account.
	//
	// SECURITY: device_id is non-secret (lives in localStorage,
	// visible to JS). What gates access is the session cookie on
	// the WS upgrade; by the time we're here, that's already been
	// validated. So rebinding to whoever's currently authenticated
	// is correct. The Phase 9.6f SPA change ALSO clears device_id
	// on logout so this rebind path is rare in practice (it only
	// fires on edge cases like cookie-cleared-but-localStorage-
	// retained).
	tag, err := st.Pool.Exec(ctx,
		`INSERT INTO devices (id, user_id, device_type, device_label)
		 VALUES ($1, $2, 'browser-unknown', 'phase-09b-session')
		 ON CONFLICT (id) DO UPDATE
		   SET user_id   = EXCLUDED.user_id,
		       last_seen = now()
		   WHERE devices.user_id IS DISTINCT FROM EXCLUDED.user_id`,
		deviceID, userID,
	)
	if err == nil && tag.RowsAffected() > 0 {
		// RowsAffected is 1 for both INSERT and the rebinding UPDATE;
		// the WHERE clause on the UPDATE means we only log when
		// something actually changed. We don't have a logger here
		// (this is a free function); the caller logs ensure failures.
		// A more elaborate version could return a sentinel for
		// "rebound" vs "inserted" so the caller can audit-log it.
		_ = tag
	}
	return err
}
