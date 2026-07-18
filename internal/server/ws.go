package server

import (
	"context"
	"encoding/base64"
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
	"strings"
)

// WSConfig tunes WebSocket behavior.
type WSConfig struct {
	PingInterval     time.Duration
	PingTimeout      time.Duration
	WriteTimeout     time.Duration
	HandshakeTimeout time.Duration
	// att-1: max attachment refs one send frame may link
	// (CHALK_ATTACH_MAX_PER_MESSAGE). 0 falls back to a safe default in the
	// send handler.
	AttachMaxPerMessage int
}

// DefaultWSConfig returns production defaults.
func DefaultWSConfig() WSConfig {
	return WSConfig{
		PingInterval:        15 * time.Second,
		PingTimeout:         30 * time.Second,
		WriteTimeout:        10 * time.Second,
		HandshakeTimeout:    5 * time.Second,
		AttachMaxPerMessage: 10,
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

	// gov-1b-2: per-instance in-flight set of proposals currently being
	// resolved, to collapse concurrent dispatch of the same proposal. Keyed
	// by uuid.UUID. Zero-value ready.
	resolving sync.Map
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
		case proto.TypePublishIdentity:
			h.handlePublishIdentity(ctx, c, conn, f)
		case proto.TypeFetchIdentity:
			h.handleFetchIdentity(ctx, c, conn, f)
		case proto.TypePublishChannelKey:
			h.handlePublishChannelKey(ctx, c, conn, f)
		case proto.TypeFetchChannelKey:
			h.handleFetchChannelKey(ctx, c, conn, f)
		case proto.TypeFetchChannelKeyRecipients:
			h.handleFetchChannelKeyRecipients(ctx, c, conn, f)
		case proto.TypeRotateChannelKey:
			h.handleRotateChannelKey(ctx, c, conn, f)
		case proto.TypeRemoveMember:
			h.handleRemoveMember(ctx, c, conn, f)
		case proto.TypeAddMember:
			h.handleAddMember(ctx, c, conn, f)
		case proto.TypeDeleteMessage:
			h.handleDeleteMessage(ctx, c, conn, f)

		// gov-1b-1: governance mode + proposal lifecycle.
		case proto.TypeGovSetMode:
			h.handleGovSetMode(ctx, c, conn, f)
		case proto.TypeGovPropose:
			h.handlePropose(ctx, c, conn, f)
		case proto.TypeGovVote:
			h.handleVote(ctx, c, conn, f)
		case proto.TypeGovCancel:
			h.handleCancelProposal(ctx, c, conn, f)
		case proto.TypeGovList:
			h.handleListProposals(ctx, c, conn, f)

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
	// Phase 23f (fail-closed): the server refuses to relay or store plaintext.
	// Every message must carry a key_version >= 1 (an encrypted body). This is
	// the protocol-level guarantee that cleartext is never transmitted, even
	// from a buggy or hostile client.
	if p.KeyVersion == nil || *p.KeyVersion < 1 {
		h.sendError(ctx, c, f.Ref, proto.ErrCodeEncryptionRequired,
			"encryption required: message must carry key_version >= 1")
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

		// Phase 25: reject a key_version ABOVE the channel's current version (a
		// client can't send under a version that doesn't exist yet). Current and
		// older versions are accepted: older covers in-flight messages sent just
		// before a rotation was learned, and they remain decryptable under their
		// retained keys.
		curVer, cvErr := h.store.CurrentKeyVersion(ctx, channelID)
		if cvErr != nil {
			h.sendError(ctx, c, f.Ref, proto.ErrCodeInternal, "key version check: "+cvErr.Error())
			return
		}
		if p.KeyVersion != nil && *p.KeyVersion > curVer {
			h.sendError(ctx, c, f.Ref, proto.ErrCodeStaleKeyVersion,
				"key_version is ahead of the channel's current version")
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

	// att-1: resolve + dedup + cap the attachment ids this send links. The
	// per-message cap guards the link UPDATE's ANY($1) array; integrity
	// (complete, same channel, unlinked, owned) is enforced in the tx by
	// LinkAttachmentsToMessage so a bad id rolls the whole send back.
	maxPer := h.cfg.AttachMaxPerMessage
	if maxPer <= 0 {
		maxPer = 10
	}
	var attUUIDs []uuid.UUID
	if len(p.AttachmentIDs) > 0 {
		seen := make(map[uuid.UUID]struct{}, len(p.AttachmentIDs))
		for _, raw := range p.AttachmentIDs {
			aid, perr := uuid.Parse(raw)
			if perr != nil {
				h.sendError(ctx, c, f.Ref, proto.ErrCodeBadPayload, "attachment_id must be a UUID")
				return
			}
			if _, dup := seen[aid]; dup {
				continue
			}
			seen[aid] = struct{}{}
			attUUIDs = append(attUUIDs, aid)
		}
		if len(attUUIDs) > maxPer {
			h.sendError(ctx, c, f.Ref, proto.ErrCodeBadPayload,
				"too many attachments linked to one message")
			return
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
			   (id, channel_id, parent_id, thread_id, sender_device_id, seq, body, key_version)
			 VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
			 RETURNING ts`,
			msgID, channelID, parentUUID, threadUUID, deviceID, seq, bodyBytes, p.KeyVersion,
		).Scan(&ts); err != nil {
			return err
		}
		// att-1: link attachments inside the same tx, so refs commit
		// atomically with the message (or the whole send rolls back).
		if len(attUUIDs) > 0 {
			if err := h.store.LinkAttachmentsToMessage(ctx, tx, channelID, msgID, ts, sendUserUUID, attUUIDs); err != nil {
				return err
			}
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

// ===== merged from ws_phase06.go =====

// This file holds the phase-06 frame handlers: presence and friend
// operations. The main ws.go file (from phase 05, refreshed in this
// phase) routes incoming frame types to these handlers. Kept separate
// from ws.go so the diff against phase 05 is visible and reviewable.

// presenceHeartbeatTicker is set up per-connection. The cadence depends
// on the device_type declared in the hello. Each tick bumps last_seen
// in device_presence so the demotion sweep doesn't downgrade us.
//
// We don't republish state on every heartbeat; only when state changes.
// That keeps NOTIFY traffic proportional to actual user activity.
func (h *WSHandler) startPresenceHeartbeat(
	ctx context.Context,
	deviceID uuid.UUID,
	dt presence.DeviceType,
) {
	if h.presence == nil {
		return
	}
	interval := dt.HeartbeatInterval()
	t := time.NewTicker(interval)
	defer t.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-t.C:
			bumpCtx, cancel := context.WithTimeout(ctx, 2*time.Second)
			err := h.presence.BumpLastSeen(bumpCtx, deviceID)
			cancel()
			if err != nil && !errors.Is(err, presence.ErrDeviceNotPresent) {
				h.logger.Printf("presence heartbeat: %v", err)
			}
			// If the row was missing (janitor reaped us or a state
			// change cleared it), re-establish online. The client
			// expects to still be "present" because the WebSocket
			// itself is still open.
			if errors.Is(err, presence.ErrDeviceNotPresent) {
				reCtx, reCancel := context.WithTimeout(ctx, 2*time.Second)
				_ = h.presence.SetDevicePresence(reCtx, presence.DevicePresence{
					DeviceID:   deviceID,
					UserID:     h.lookupUserForDevice(reCtx, deviceID),
					InstanceID: h.instanceID,
					DeviceType: dt,
					State:      presence.StateOnline,
				})
				reCancel()
			}
		}
	}
}

// lookupUserForDevice returns the user_id for a device. Best-effort;
// returns uuid.Nil if the device isn't in the devices table (which
// shouldn't happen since ensureDeviceForTesting creates one in phase 05).
func (h *WSHandler) lookupUserForDevice(ctx context.Context, deviceID uuid.UUID) uuid.UUID {
	if h.store == nil {
		return uuid.Nil
	}
	var u uuid.UUID
	err := h.store.Pool.QueryRow(ctx,
		`SELECT user_id FROM devices WHERE id = $1`, deviceID,
	).Scan(&u)
	if err != nil {
		return uuid.Nil
	}
	return u
}

// handlePresenceSubscribe records subscriptions for the calling device
// and sends back the per-user accepted/rejected breakdown.
func (h *WSHandler) handlePresenceSubscribe(
	ctx context.Context,
	c *websocket.Conn,
	conn *Conn,
	f proto.Frame,
) {
	if !h.requirePresenceAndFriends(ctx, c, f.Ref) {
		return
	}
	var p proto.PresenceSubscribePayload
	if err := f.DecodePayload(&p); err != nil {
		h.sendError(ctx, c, f.Ref, proto.ErrCodeBadPayload, err.Error())
		return
	}

	myDevice, err := uuid.Parse(conn.DeviceID)
	if err != nil {
		h.sendError(ctx, c, f.Ref, proto.ErrCodeBadPayload, "device_id not a UUID")
		return
	}
	myUser := h.lookupUserForDevice(ctx, myDevice)
	if myUser == uuid.Nil {
		h.sendError(ctx, c, f.Ref, proto.ErrCodeInternal, "unknown user")
		return
	}

	subscribed := []string{}
	rejected := []proto.PresenceRejection{}
	for _, idStr := range p.UserIDs {
		target, err := uuid.Parse(idStr)
		if err != nil {
			rejected = append(rejected, proto.PresenceRejection{
				UserID: idStr, Reason: proto.ErrCodeBadPayload,
			})
			continue
		}
		if target == myUser {
			rejected = append(rejected, proto.PresenceRejection{
				UserID: idStr, Reason: "self",
			})
			continue
		}
		if err := h.friends.AssertActive(ctx, target); err != nil {
			rejected = append(rejected, proto.PresenceRejection{
				UserID: idStr, Reason: proto.ErrCodeUserNotFound,
			})
			continue
		}
		ok, err := h.friends.AreAcceptedFriends(ctx, myUser, target)
		if err != nil {
			rejected = append(rejected, proto.PresenceRejection{
				UserID: idStr, Reason: proto.ErrCodeInternal,
			})
			continue
		}
		if !ok {
			rejected = append(rejected, proto.PresenceRejection{
				UserID: idStr, Reason: proto.ErrCodeNotFriends,
			})
			continue
		}
		if err := h.presence.AddSubscription(ctx, myDevice, target); err != nil {
			rejected = append(rejected, proto.PresenceRejection{
				UserID: idStr, Reason: proto.ErrCodeInternal,
			})
			continue
		}
		subscribed = append(subscribed, idStr)
	}

	ack, _ := proto.NewFrame(proto.TypePresenceSubscribeAck, f.Ref,
		proto.PresenceSubscribeAckPayload{
			Subscribed: subscribed,
			Rejected:   rejected,
		})
	data, _ := json.Marshal(ack)
	_ = writeOne(ctx, c, data, h.cfg.WriteTimeout)

	// For each successful subscription, immediately push the target's
	// current aggregated state so the client doesn't have to wait for
	// the next transition.
	for _, idStr := range subscribed {
		target, _ := uuid.Parse(idStr)
		state, at, err := h.presence.AggregateUserState(ctx, target)
		if err != nil {
			continue
		}
		push, _ := proto.NewFrame(proto.TypePresence, "",
			proto.PresencePayload{
				UserID: idStr,
				State:  string(state),
				At:     at.UnixMilli(),
			})
		pd, _ := json.Marshal(push)
		_ = writeOne(ctx, c, pd, h.cfg.WriteTimeout)
	}
}

// handlePresenceUnsubscribe removes subscriptions.
func (h *WSHandler) handlePresenceUnsubscribe(
	ctx context.Context,
	c *websocket.Conn,
	conn *Conn,
	f proto.Frame,
) {
	if !h.requirePresenceAndFriends(ctx, c, f.Ref) {
		return
	}
	var p proto.PresenceUnsubscribePayload
	if err := f.DecodePayload(&p); err != nil {
		h.sendError(ctx, c, f.Ref, proto.ErrCodeBadPayload, err.Error())
		return
	}
	myDevice, err := uuid.Parse(conn.DeviceID)
	if err != nil {
		h.sendError(ctx, c, f.Ref, proto.ErrCodeBadPayload, "device_id not a UUID")
		return
	}

	unsubscribed := []string{}
	for _, idStr := range p.UserIDs {
		target, err := uuid.Parse(idStr)
		if err != nil {
			continue
		}
		_ = h.presence.RemoveSubscription(ctx, myDevice, target)
		unsubscribed = append(unsubscribed, idStr)
	}

	ack, _ := proto.NewFrame(proto.TypePresenceUnsubscribeAck, f.Ref,
		proto.PresenceUnsubscribeAckPayload{Unsubscribed: unsubscribed})
	data, _ := json.Marshal(ack)
	_ = writeOne(ctx, c, data, h.cfg.WriteTimeout)
}

// handlePresenceUpdate records the client's claimed state. The server
// applies the change to the device's row and may republish if it
// represents a transition; otherwise it's a heartbeat-with-intent.
func (h *WSHandler) handlePresenceUpdate(
	ctx context.Context,
	c *websocket.Conn,
	conn *Conn,
	f proto.Frame,
) {
	if !h.requirePresenceAndFriends(ctx, c, f.Ref) {
		return
	}
	var p proto.PresenceUpdatePayload
	if err := f.DecodePayload(&p); err != nil {
		h.sendError(ctx, c, f.Ref, proto.ErrCodeBadPayload, err.Error())
		return
	}
	// Clients can only claim online or away. offline is server-enforced
	// on disconnect or by the demotion sweep.
	if p.State != string(presence.StateOnline) && p.State != string(presence.StateAway) {
		h.sendError(ctx, c, f.Ref, proto.ErrCodeInvalidState,
			"clients may only claim online or away")
		return
	}
	myDevice, err := uuid.Parse(conn.DeviceID)
	if err != nil {
		h.sendError(ctx, c, f.Ref, proto.ErrCodeBadPayload, "device_id not a UUID")
		return
	}

	prev, err := h.presence.SetDeviceState(ctx, myDevice, presence.State(p.State))
	if err != nil {
		h.sendError(ctx, c, f.Ref, proto.ErrCodeInternal, err.Error())
		return
	}

	ack, _ := proto.NewFrame(proto.TypePresenceUpdateAck, f.Ref,
		proto.PresenceUpdateAckPayload{State: p.State})
	data, _ := json.Marshal(ack)
	_ = writeOne(ctx, c, data, h.cfg.WriteTimeout)

	// Publish NOTIFY only on actual transitions.
	if string(prev) != p.State {
		userID := h.lookupUserForDevice(ctx, myDevice)
		if userID != uuid.Nil && h.publishPresenceChange != nil {
			pubCtx, cancel := context.WithTimeout(ctx, 2*time.Second)
			defer cancel()
			if err := h.publishPresenceChange(pubCtx, userID); err != nil {
				h.logger.Printf("publish presence change: %v", err)
			}
		}
	}
}

// --- friend handlers ---------------------------------------------------

func (h *WSHandler) handleFriendRequest(
	ctx context.Context,
	c *websocket.Conn,
	conn *Conn,
	f proto.Frame,
) {
	if !h.requirePresenceAndFriends(ctx, c, f.Ref) {
		return
	}
	var p proto.FriendRequestPayload
	if err := f.DecodePayload(&p); err != nil {
		h.sendError(ctx, c, f.Ref, proto.ErrCodeBadPayload, err.Error())
		return
	}
	from, to, ok := h.parseUserPair(ctx, c, f.Ref, conn.DeviceID, p.ToUserID)
	if !ok {
		return
	}

	outcome, err := h.friends.Request(ctx, from, to)
	if err != nil {
		h.sendFriendError(ctx, c, f.Ref, err)
		return
	}

	ack, _ := proto.NewFrame(proto.TypeFriendRequestAck, f.Ref,
		proto.FriendRequestAckPayload{
			ToUserID: p.ToUserID,
			Status:   outcome,
		})
	data, _ := json.Marshal(ack)
	_ = writeOne(ctx, c, data, h.cfg.WriteTimeout)

	// Notify the other party so their connected devices learn about
	// the event in real time.
	kind := "request_received"
	if outcome == "auto_accepted" {
		kind = "accepted"
	}
	h.publishFriendEvent(ctx, to, from, kind)

	// If auto-accepted, also notify the requester (us). The wire push
	// is useful for multi-device users: another device of mine should
	// learn this friendship became accepted.
	if outcome == "auto_accepted" {
		h.publishFriendEvent(ctx, from, to, "accepted")
	}
}

func (h *WSHandler) handleFriendAccept(
	ctx context.Context,
	c *websocket.Conn,
	conn *Conn,
	f proto.Frame,
) {
	if !h.requirePresenceAndFriends(ctx, c, f.Ref) {
		return
	}
	var p proto.FriendAcceptPayload
	if err := f.DecodePayload(&p); err != nil {
		h.sendError(ctx, c, f.Ref, proto.ErrCodeBadPayload, err.Error())
		return
	}
	us, from, ok := h.parseUserPair(ctx, c, f.Ref, conn.DeviceID, p.FromUserID)
	if !ok {
		return
	}
	if err := h.friends.Accept(ctx, us, from); err != nil {
		h.sendFriendError(ctx, c, f.Ref, err)
		return
	}
	ack, _ := proto.NewFrame(proto.TypeFriendAcceptAck, f.Ref,
		proto.FriendAcceptAckPayload{FromUserID: p.FromUserID})
	data, _ := json.Marshal(ack)
	_ = writeOne(ctx, c, data, h.cfg.WriteTimeout)

	// Push to the requester so their UI updates immediately.
	h.publishFriendEvent(ctx, from, us, "accepted")
}

func (h *WSHandler) handleFriendDecline(
	ctx context.Context,
	c *websocket.Conn,
	conn *Conn,
	f proto.Frame,
) {
	if !h.requirePresenceAndFriends(ctx, c, f.Ref) {
		return
	}
	var p proto.FriendDeclinePayload
	if err := f.DecodePayload(&p); err != nil {
		h.sendError(ctx, c, f.Ref, proto.ErrCodeBadPayload, err.Error())
		return
	}
	us, from, ok := h.parseUserPair(ctx, c, f.Ref, conn.DeviceID, p.FromUserID)
	if !ok {
		return
	}
	if err := h.friends.Decline(ctx, us, from); err != nil {
		h.sendFriendError(ctx, c, f.Ref, err)
		return
	}
	ack, _ := proto.NewFrame(proto.TypeFriendDeclineAck, f.Ref,
		proto.FriendDeclineAckPayload{FromUserID: p.FromUserID})
	data, _ := json.Marshal(ack)
	_ = writeOne(ctx, c, data, h.cfg.WriteTimeout)
	h.publishFriendEvent(ctx, from, us, "declined")
}

func (h *WSHandler) handleFriendRemove(
	ctx context.Context,
	c *websocket.Conn,
	conn *Conn,
	f proto.Frame,
) {
	if !h.requirePresenceAndFriends(ctx, c, f.Ref) {
		return
	}
	var p proto.FriendRemovePayload
	if err := f.DecodePayload(&p); err != nil {
		h.sendError(ctx, c, f.Ref, proto.ErrCodeBadPayload, err.Error())
		return
	}
	us, them, ok := h.parseUserPair(ctx, c, f.Ref, conn.DeviceID, p.UserID)
	if !ok {
		return
	}
	if err := h.friends.Remove(ctx, us, them); err != nil {
		h.sendError(ctx, c, f.Ref, proto.ErrCodeInternal, err.Error())
		return
	}
	ack, _ := proto.NewFrame(proto.TypeFriendRemoveAck, f.Ref,
		proto.FriendRemoveAckPayload{UserID: p.UserID})
	data, _ := json.Marshal(ack)
	_ = writeOne(ctx, c, data, h.cfg.WriteTimeout)
	h.publishFriendEvent(ctx, them, us, "removed")
}

func (h *WSHandler) handleFriendBlock(
	ctx context.Context,
	c *websocket.Conn,
	conn *Conn,
	f proto.Frame,
) {
	if !h.requirePresenceAndFriends(ctx, c, f.Ref) {
		return
	}
	var p proto.FriendBlockPayload
	if err := f.DecodePayload(&p); err != nil {
		h.sendError(ctx, c, f.Ref, proto.ErrCodeBadPayload, err.Error())
		return
	}
	us, them, ok := h.parseUserPair(ctx, c, f.Ref, conn.DeviceID, p.UserID)
	if !ok {
		return
	}
	if err := h.friends.Block(ctx, us, them); err != nil {
		h.sendError(ctx, c, f.Ref, proto.ErrCodeInternal, err.Error())
		return
	}
	ack, _ := proto.NewFrame(proto.TypeFriendBlockAck, f.Ref,
		proto.FriendBlockAckPayload{UserID: p.UserID})
	data, _ := json.Marshal(ack)
	_ = writeOne(ctx, c, data, h.cfg.WriteTimeout)
	// Per design: blocked party is NOT notified.
}

func (h *WSHandler) handleFriendUnblock(
	ctx context.Context,
	c *websocket.Conn,
	conn *Conn,
	f proto.Frame,
) {
	if !h.requirePresenceAndFriends(ctx, c, f.Ref) {
		return
	}
	var p proto.FriendUnblockPayload
	if err := f.DecodePayload(&p); err != nil {
		h.sendError(ctx, c, f.Ref, proto.ErrCodeBadPayload, err.Error())
		return
	}
	us, them, ok := h.parseUserPair(ctx, c, f.Ref, conn.DeviceID, p.UserID)
	if !ok {
		return
	}
	if err := h.friends.Unblock(ctx, us, them); err != nil {
		h.sendError(ctx, c, f.Ref, proto.ErrCodeInternal, err.Error())
		return
	}
	ack, _ := proto.NewFrame(proto.TypeFriendUnblockAck, f.Ref,
		proto.FriendUnblockAckPayload{UserID: p.UserID})
	data, _ := json.Marshal(ack)
	_ = writeOne(ctx, c, data, h.cfg.WriteTimeout)
}

func (h *WSHandler) handleFriendList(
	ctx context.Context,
	c *websocket.Conn,
	conn *Conn,
	f proto.Frame,
) {
	if !h.requirePresenceAndFriends(ctx, c, f.Ref) {
		return
	}
	myDevice, err := uuid.Parse(conn.DeviceID)
	if err != nil {
		h.sendError(ctx, c, f.Ref, proto.ErrCodeBadPayload, "device_id not a UUID")
		return
	}
	myUser := h.lookupUserForDevice(ctx, myDevice)
	if myUser == uuid.Nil {
		h.sendError(ctx, c, f.Ref, proto.ErrCodeInternal, "unknown user")
		return
	}

	entries, err := h.friends.List(ctx, myUser)
	if err != nil {
		h.sendError(ctx, c, f.Ref, proto.ErrCodeInternal, err.Error())
		return
	}

	// Hydrate handles + account statuses in one query.
	summaries, err := h.hydrateSummaries(ctx, entries)
	if err != nil {
		h.sendError(ctx, c, f.Ref, proto.ErrCodeInternal, err.Error())
		return
	}

	out := proto.FriendListAckPayload{}
	for _, e := range entries {
		s := summaries[e.OtherUserID]
		switch {
		case e.Status == friends.StatusPending && e.Direction == "outgoing":
			out.PendingOutgoing = append(out.PendingOutgoing, s)
		case e.Status == friends.StatusPending && e.Direction == "incoming":
			out.PendingIncoming = append(out.PendingIncoming, s)
		case e.Status == friends.StatusAccepted:
			out.Accepted = append(out.Accepted, s)
		case e.Status == friends.StatusBlocked:
			out.Blocked = append(out.Blocked, s)
		}
	}

	ack, _ := proto.NewFrame(proto.TypeFriendListAck, f.Ref, out)
	data, _ := json.Marshal(ack)
	_ = writeOne(ctx, c, data, h.cfg.WriteTimeout)
}

// hydrateSummaries fetches handle + status for the OtherUserID of every
// entry in one query, then returns a map. Phase 06 sees small friend
// lists (typical user has tens, not thousands), so the IN-list approach
// is fine.
func (h *WSHandler) hydrateSummaries(
	ctx context.Context,
	entries []friends.FriendListEntry,
) (map[uuid.UUID]proto.FriendSummary, error) {
	if len(entries) == 0 {
		return map[uuid.UUID]proto.FriendSummary{}, nil
	}
	ids := make([]uuid.UUID, 0, len(entries))
	seen := make(map[uuid.UUID]struct{}, len(entries))
	for _, e := range entries {
		if _, ok := seen[e.OtherUserID]; ok {
			continue
		}
		seen[e.OtherUserID] = struct{}{}
		ids = append(ids, e.OtherUserID)
	}

	rows, err := h.store.Pool.Query(ctx,
		`SELECT id, handle, status FROM users WHERE id = ANY($1)`,
		ids,
	)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	out := make(map[uuid.UUID]proto.FriendSummary, len(ids))
	for rows.Next() {
		var id uuid.UUID
		var handle, status string
		if err := rows.Scan(&id, &handle, &status); err != nil {
			return nil, err
		}
		out[id] = proto.FriendSummary{
			UserID:        id.String(),
			Handle:        handle,
			AccountStatus: status,
		}
	}
	return out, rows.Err()
}

// --- helpers ----------------------------------------------------------

// parseUserPair resolves both the caller's user_id (from their device_id)
// and a target user_id from the request. Sends an appropriate error frame
// and returns ok=false on failure.
func (h *WSHandler) parseUserPair(
	ctx context.Context,
	c *websocket.Conn,
	ref, deviceIDStr, targetUserIDStr string,
) (us, target uuid.UUID, ok bool) {
	deviceID, err := uuid.Parse(deviceIDStr)
	if err != nil {
		h.sendError(ctx, c, ref, proto.ErrCodeBadPayload, "device_id not a UUID")
		return uuid.Nil, uuid.Nil, false
	}
	us = h.lookupUserForDevice(ctx, deviceID)
	if us == uuid.Nil {
		h.sendError(ctx, c, ref, proto.ErrCodeInternal, "unknown user")
		return uuid.Nil, uuid.Nil, false
	}
	target, err = uuid.Parse(targetUserIDStr)
	if err != nil {
		h.sendError(ctx, c, ref, proto.ErrCodeBadPayload, "user_id not a UUID")
		return uuid.Nil, uuid.Nil, false
	}
	if target == us {
		h.sendError(ctx, c, ref, proto.ErrCodeCannotSelfFriend,
			"cannot operate on self")
		return uuid.Nil, uuid.Nil, false
	}
	return us, target, true
}

// sendFriendError maps friends-package errors to wire error codes.
func (h *WSHandler) sendFriendError(
	ctx context.Context,
	c *websocket.Conn,
	ref string,
	err error,
) {
	code := proto.ErrCodeInternal
	switch {
	case errors.Is(err, friends.ErrSelfFriend):
		code = proto.ErrCodeCannotSelfFriend
	case errors.Is(err, friends.ErrUserNotFound),
		errors.Is(err, friends.ErrUserUnavailable):
		code = proto.ErrCodeUserNotFound
	case errors.Is(err, friends.ErrAlreadyFriends):
		code = proto.ErrCodeAlreadyFriends
	case errors.Is(err, friends.ErrBlocked):
		code = proto.ErrCodeFriendshipBlocked
	case errors.Is(err, friends.ErrNoPendingRequest):
		code = proto.ErrCodeNoPendingRequest
	}
	h.sendError(ctx, c, ref, code, err.Error())
}

// publishFriendEvent NOTIFYs interested parties about an asynchronous
// friendship state change. recipient is the user_id whose devices
// should receive the push; fromUser is the other party.
func (h *WSHandler) publishFriendEvent(
	ctx context.Context,
	recipient, fromUser uuid.UUID,
	kind string,
) {
	if h.publishFriend == nil {
		return
	}
	pubCtx, cancel := context.WithTimeout(ctx, 2*time.Second)
	defer cancel()
	if err := h.publishFriend(pubCtx, recipient, fromUser, kind); err != nil {
		h.logger.Printf("publish friend event: %v", err)
	}
}

// requirePresenceAndFriends returns false (and emits an error frame) if
// the handler was constructed without the presence/friends dependencies.
// Defensive: prevents nil dereferences in tests that wire only part of
// the stack.
func (h *WSHandler) requirePresenceAndFriends(
	ctx context.Context,
	c *websocket.Conn,
	ref string,
) bool {
	if h.presence == nil || h.friends == nil {
		h.sendError(ctx, c, ref, proto.ErrCodeInternal,
			"presence/friends not configured on this server")
		return false
	}
	return true
}

// classifyDeviceType maps the client-claimed device_type string to a
// validated presence.DeviceType, defaulting to browser-unknown for any
// unrecognized value (including empty).
func classifyDeviceType(s string) presence.DeviceType {
	switch s {
	case string(presence.DevicePhone):
		return presence.DevicePhone
	case string(presence.DeviceTablet):
		return presence.DeviceTablet
	case string(presence.DeviceDesktop):
		return presence.DeviceDesktop
	}
	return presence.DeviceBrowserUnknown
}

// ===== merged from ws_phase08.go =====

// channelSummaryFromStore builds a proto.ChannelSummary from a
// store.ChannelWithMembers. Centralized so the two call sites
// (create_channel ack and list_channels ack) format identically.
//
// Phase 08c: handles is a map of user_id -> handle. When non-nil and a
// member's handle is found, we include it in the Members slice for the
// SPA to render @<handle> instead of a UUID prefix. We still populate
// the deprecated MemberIDs []string for backward compatibility with
// older clients and the phase 08a integration tests.
func channelSummaryFromStore(c store.ChannelWithMembers, handles map[uuid.UUID]string) proto.ChannelSummary {
	createdBy := ""
	if c.CreatedBy != nil {
		createdBy = c.CreatedBy.String()
	}
	memberIDs := make([]string, 0, len(c.MemberIDs))
	members := make([]proto.ChannelMember, 0, len(c.MemberIDs))
	for _, m := range c.MemberIDs {
		memberIDs = append(memberIDs, m.String())
		members = append(members, proto.ChannelMember{
			UserID: m.String(),
			Handle: handles[m], // empty string if unknown, fine
		})
	}
	return proto.ChannelSummary{
		ID:                c.ID.String(),
		Name:              c.Name,
		IsDM:              c.IsDM,
		CreatedBy:         createdBy,
		CreatedAt:         c.CreatedAt.UnixMilli(),
		MemberIDs:         memberIDs,
		Members:           members,
		CurrentKeyVersion: c.CurrentKeyVersion,
		RotationPending:   c.RotationPending,
		GovernanceMode:    c.GovernanceMode,
		ChannelType:       c.ChannelType,
	}
}

// handleCreateChannel inserts a channel + members and acks with the
// full summary. The caller becomes 'owner'; all other members must be
// accepted friends of the caller (phase 06 friends table).
//
// On success, also pushes a channel_event{kind="added"} to each new
// member's locally-connected devices via a Kind="channel" pubsub event.
// Cross-instance push happens automatically through the listener.
func (h *WSHandler) handleCreateChannel(
	ctx context.Context,
	c *websocket.Conn,
	conn *Conn,
	f proto.Frame,
) {
	var p proto.CreateChannelPayload
	if err := f.DecodePayload(&p); err != nil {
		h.sendError(ctx, c, f.Ref, proto.ErrCodeBadPayload, err.Error())
		return
	}
	if strings.TrimSpace(p.Name) == "" || len(p.Name) > 80 {
		h.sendError(ctx, c, f.Ref, proto.ErrCodeInvalidChannel,
			"name must be 1-80 chars after trim")
		return
	}
	if h.store == nil {
		h.sendError(ctx, c, f.Ref, proto.ErrCodeInternal, "no store configured")
		return
	}

	deviceID, err := uuid.Parse(conn.DeviceID)
	if err != nil {
		h.sendError(ctx, c, f.Ref, proto.ErrCodeBadPayload, "device_id invalid")
		return
	}
	callerID := h.lookupUserForDevice(ctx, deviceID)
	if callerID == uuid.Nil {
		h.sendError(ctx, c, f.Ref, proto.ErrCodeNotAMember,
			"anonymous senders cannot create channels")
		return
	}

	// Parse + de-dup member IDs.
	memberSet := make(map[uuid.UUID]struct{}, len(p.MemberIDs)+1)
	for _, m := range p.MemberIDs {
		mu, perr := uuid.Parse(m)
		if perr != nil {
			h.sendError(ctx, c, f.Ref, proto.ErrCodeBadPayload,
				"member_id not a uuid: "+m)
			return
		}
		if mu == callerID {
			continue // caller added automatically
		}
		memberSet[mu] = struct{}{}
	}

	// Friends check: every other member must be an accepted friend
	// of the caller.
	if h.friends == nil {
		h.sendError(ctx, c, f.Ref, proto.ErrCodeInternal, "friends store unavailable")
		return
	}
	for m := range memberSet {
		ok, err := h.friends.AreAcceptedFriends(ctx, callerID, m)
		if err != nil {
			h.sendError(ctx, c, f.Ref, proto.ErrCodeInternal,
				"friend check: "+err.Error())
			return
		}
		if !ok {
			h.sendError(ctx, c, f.Ref, proto.ErrCodeNotFriends,
				"must be friends with "+m.String())
			return
		}
	}

	// DM constraint preflight: exactly 1 other member (so 2 total
	// with caller). Server returns a friendly error rather than letting
	// the trigger fire with a generic message.
	if p.IsDM && len(memberSet) != 1 {
		h.sendError(ctx, c, f.Ref, proto.ErrCodeDMCardinality,
			"DM channels need exactly 1 other member")
		return
	}

	// 30-1: channel_type preflight (empty => text; the store normalizes and
	// re-fences, this just gives a friendly error before the tx).
	switch p.ChannelType {
	case "", "text":
	case "voice":
		if p.IsDM {
			h.sendError(ctx, c, f.Ref, proto.ErrCodeInvalidChannel,
				"a DM cannot be a voice channel")
			return
		}
	default:
		h.sendError(ctx, c, f.Ref, proto.ErrCodeInvalidChannel,
			"channel_type must be 'text' or 'voice'")
		return
	}

	// Build the member list and create.
	others := make([]uuid.UUID, 0, len(memberSet))
	for m := range memberSet {
		others = append(others, m)
	}
	created, err := h.store.CreateChannel(ctx, store.CreateChannelInput{
		Name:        strings.TrimSpace(p.Name),
		IsDM:        p.IsDM,
		CreatedBy:   callerID,
		MemberIDs:   others,
		ChannelType: p.ChannelType,
	})
	if err != nil {
		if errors.Is(err, store.ErrDMCardinality) {
			h.sendError(ctx, c, f.Ref, proto.ErrCodeDMCardinality, err.Error())
			return
		}
		h.sendError(ctx, c, f.Ref, proto.ErrCodeInternal, "create channel: "+err.Error())
		return
	}

	// Phase 08c: fetch handles for all members before building the
	// summary. Failure here is non-fatal -- we'd just send a summary
	// with empty handles, and the SPA falls back to UUID prefixes.
	handles, hErr := h.store.HandlesByID(ctx, created.MemberIDs)
	if hErr != nil {
		h.logger.Printf("handles lookup (create_channel): %v", hErr)
		handles = nil // channelSummaryFromStore tolerates nil
	}

	summary := channelSummaryFromStore(created, handles)

	// Ack the caller.
	ack, _ := proto.NewFrame(proto.TypeCreateChannelAck, f.Ref,
		proto.CreateChannelAckPayload{Channel: summary})
	if err := writeFrame(ctx, c, ack, h.cfg.WriteTimeout); err != nil {
		h.logger.Printf("create_channel_ack write: %v", err)
		// Don't return -- the channel exists; we still need to push events
		// to other members so they can see it on their side.
	}

	// Push channel_event{kind="added"} to every member's devices,
	// including the caller's other devices. We publish per-member via
	// chalk_global with a new Kind="channel" event; server.go's
	// handlePubsubEvent dispatches by Kind and pushes channel_event.
	//
	// Why chalk_global and not the per-channel topic: members haven't
	// subscribed to this channel's topic yet (we just created it).
	// chalk_global is always subscribed, so it's the safe path.
	for _, m := range created.MemberIDs {
		if err := h.publishChannelEvent(ctx, m, created.ID, "added", summary); err != nil {
			h.logger.Printf("publish channel_event added to %s: %v", m, err)
		}
	}
}

// handleListChannels returns every channel the caller is a member of.
func (h *WSHandler) handleListChannels(
	ctx context.Context,
	c *websocket.Conn,
	conn *Conn,
	f proto.Frame,
) {
	if h.store == nil {
		h.sendError(ctx, c, f.Ref, proto.ErrCodeInternal, "no store configured")
		return
	}
	deviceID, err := uuid.Parse(conn.DeviceID)
	if err != nil {
		h.sendError(ctx, c, f.Ref, proto.ErrCodeBadPayload, "device_id invalid")
		return
	}
	callerID := h.lookupUserForDevice(ctx, deviceID)
	if callerID == uuid.Nil {
		// Anonymous callers get an empty list -- not an error.
		ack, _ := proto.NewFrame(proto.TypeListChannelsAck, f.Ref,
			proto.ListChannelsAckPayload{Channels: []proto.ChannelSummary{}})
		_ = writeFrame(ctx, c, ack, h.cfg.WriteTimeout)
		return
	}
	channels, err := h.store.ListChannelsForUser(ctx, callerID)
	if err != nil {
		h.sendError(ctx, c, f.Ref, proto.ErrCodeInternal, "list: "+err.Error())
		return
	}
	summaries := make([]proto.ChannelSummary, 0, len(channels))

	// Phase 08c: union all member UUIDs across the channel list and
	// fetch their handles in one query. Cheaper than one query per
	// channel, and the union is bounded by (channels * members_per_dm)
	// which stays small.
	idSet := make(map[uuid.UUID]struct{})
	for _, ch := range channels {
		for _, m := range ch.MemberIDs {
			idSet[m] = struct{}{}
		}
	}
	uniqIDs := make([]uuid.UUID, 0, len(idSet))
	for id := range idSet {
		uniqIDs = append(uniqIDs, id)
	}
	handles, hErr := h.store.HandlesByID(ctx, uniqIDs)
	if hErr != nil {
		h.logger.Printf("handles lookup (list_channels): %v", hErr)
		handles = nil
	}

	for _, ch := range channels {
		summaries = append(summaries, channelSummaryFromStore(ch, handles))
	}
	ack, _ := proto.NewFrame(proto.TypeListChannelsAck, f.Ref,
		proto.ListChannelsAckPayload{Channels: summaries})
	if err := writeFrame(ctx, c, ack, h.cfg.WriteTimeout); err != nil {
		h.logger.Printf("list_channels_ack write: %v", err)
	}
}

// handleFetchHistory returns up to limit messages with seq < before_seq
// in descending seq order. Membership is enforced.
func (h *WSHandler) handleFetchHistory(
	ctx context.Context,
	c *websocket.Conn,
	conn *Conn,
	f proto.Frame,
) {
	var p proto.FetchHistoryPayload
	if err := f.DecodePayload(&p); err != nil {
		h.sendError(ctx, c, f.Ref, proto.ErrCodeBadPayload, err.Error())
		return
	}
	if h.store == nil {
		h.sendError(ctx, c, f.Ref, proto.ErrCodeInternal, "no store configured")
		return
	}
	channelID, err := uuid.Parse(p.ChannelID)
	if err != nil {
		h.sendError(ctx, c, f.Ref, proto.ErrCodeBadPayload, "channel_id must be a UUID")
		return
	}
	deviceID, err := uuid.Parse(conn.DeviceID)
	if err != nil {
		h.sendError(ctx, c, f.Ref, proto.ErrCodeBadPayload, "device_id invalid")
		return
	}
	callerID := h.lookupUserForDevice(ctx, deviceID)
	if callerID == uuid.Nil {
		h.sendError(ctx, c, f.Ref, proto.ErrCodeNotAMember,
			"anonymous senders cannot fetch history")
		return
	}

	// The default channel is special-cased: it's not in
	// channel_members but is "always open" for the phase 07 transition.
	// Every other channel requires membership.
	if channelID != store.DefaultChannelID {
		isMember, mErr := h.store.IsMember(ctx, channelID, callerID)
		if mErr != nil {
			h.sendError(ctx, c, f.Ref, proto.ErrCodeInternal, "membership: "+mErr.Error())
			return
		}
		if !isMember {
			h.sendError(ctx, c, f.Ref, proto.ErrCodeNotAMember, "not a member")
			return
		}
	}

	msgs, err := h.store.ListMessagesByChannel(ctx, channelID, p.BeforeSeq, p.Limit)
	if err != nil {
		h.sendError(ctx, c, f.Ref, proto.ErrCodeInternal, "fetch: "+err.Error())
		return
	}

	out := make([]proto.MessagePayload, 0, len(msgs))
	for _, m := range msgs {
		senderStr := ""
		if m.SenderDeviceID != uuid.Nil {
			senderStr = m.SenderDeviceID.String()
		}
		// Phase 9.6i:
		senderUserStr := ""
		if m.SenderUserID != uuid.Nil {
			senderUserStr = m.SenderUserID.String()
		}
		// Phase 10a:
		parentStr := ""
		if m.ParentID != nil {
			parentStr = m.ParentID.String()
		}
		threadStr := ""
		if m.ThreadID != nil {
			threadStr = m.ThreadID.String()
		}
		// Phase 10e: resolve the preview sender (may be nil if the
		// thread has no replies; LastReplyBody is the empty string in
		// that case, which the client treats as "no preview").
		lastReplySender := ""
		if m.LastReplySenderUserID != nil {
			lastReplySender = m.LastReplySenderUserID.String()
		}
		bodyStr := string(m.Body)
		out = append(out, proto.MessagePayload{
			ID:                    m.ID.String(),
			ChannelID:             m.ChannelID.String(),
			Seq:                   m.Seq,
			Sender:                senderStr,
			SenderUserID:          senderUserStr,
			TS:                    m.TS.UnixMilli(),
			Body:                  bodyStr,
			ParentID:              parentStr,
			ThreadID:              threadStr,
			ReplyCount:            m.ReplyCount,
			LastReplySeq:          m.LastReplySeq,
			LastReplySenderUserID: lastReplySender,
			LastReplyBody:         string(m.LastReplyBody),
			LastReplyKeyVersion:   m.LastReplyKeyVersion,
			KeyVersion:            m.KeyVersion,
		})
	}

	ack, _ := proto.NewFrame(proto.TypeFetchHistoryAck, f.Ref,
		proto.FetchHistoryAckPayload{
			ChannelID: p.ChannelID,
			BeforeSeq: p.BeforeSeq,
			Messages:  out,
		})
	if err := writeFrame(ctx, c, ack, h.cfg.WriteTimeout); err != nil {
		h.logger.Printf("fetch_history_ack write: %v", err)
	}
}

// publishChannelEvent emits a Kind="channel" event on chalk_global so
// every chalkd's listener can route it to locally-connected devices of
// the named member. Implementation in server.go calls back here.
//
// Defined as a method-shaped hook so tests can stub via WSHandler
// composition; production wiring is set up in server.go.
func (h *WSHandler) publishChannelEvent(
	ctx context.Context,
	recipient uuid.UUID,
	channelID uuid.UUID,
	kind string,
	summary proto.ChannelSummary,
) error {
	if h.store == nil {
		return errors.New("no store")
	}
	// Encode the summary into the Event's Payload-equivalent. The
	// Event envelope is minimal; we need to carry the full summary so
	// receivers don't have to query. Encode as JSON into a sub-field.
	// pubsub.Event today has no generic payload; we shoehorn via a
	// new field added in channel_event.go below.
	return pgxBegin(ctx, h.store, func(tx pgx.Tx) error {
		ev := pubsub.Event{
			Kind:       "channel",
			UserID:     recipient,
			ChannelID:  channelID,
			InstanceID: h.instanceID,
			FriendKind: kind, // overload: reuse string field for kind discriminator
		}
		// We also need to ship the summary itself. Stuff it in a JSON
		// blob carried via the "fk" field is wrong shape; we use a
		// new field on Event added by channel_event_payload.go.
		// (See server.go::handleChannelEvent for how this is unwrapped.)
		buf, err := json.Marshal(summary)
		if err != nil {
			return err
		}
		ev.ChannelEventPayload = buf
		return pubsub.PublishWithTx(ctx, tx, ev)
	})
}

// writeFrame is a convenience wrapper around writeOne for the JSON-
// marshal case. Used by the phase 08 handlers; phase 06 handlers
// inline this pattern.
func writeFrame(ctx context.Context, c *websocket.Conn, f proto.Frame, timeout time.Duration) error {
	b, err := json.Marshal(f)
	if err != nil {
		return err
	}
	return writeOne(ctx, c, b, timeout)
}

// Phase 10a: handleFetchThread returns up to `limit` messages of a
// given thread, ordered newest-first by seq. Membership is checked
// the same way as fetch_history (via channel membership). The
// thread head itself isn't returned by this query (its row has
// thread_id=NULL); callers wanting head+replies should also have
// the head in their channel-feed cache, or fetch it via the channel
// history pagination.
func (h *WSHandler) handleFetchThread(
	ctx context.Context,
	c *websocket.Conn,
	conn *Conn,
	f proto.Frame,
) {
	var p proto.FetchThreadPayload
	if err := f.DecodePayload(&p); err != nil {
		h.sendError(ctx, c, f.Ref, proto.ErrCodeBadPayload, err.Error())
		return
	}
	if h.store == nil {
		h.sendError(ctx, c, f.Ref, proto.ErrCodeInternal, "no store configured")
		return
	}
	channelID, err := uuid.Parse(p.ChannelID)
	if err != nil {
		h.sendError(ctx, c, f.Ref, proto.ErrCodeBadPayload, "channel_id must be a UUID")
		return
	}
	threadID, err := uuid.Parse(p.ThreadID)
	if err != nil {
		h.sendError(ctx, c, f.Ref, proto.ErrCodeBadPayload, "thread_id must be a UUID")
		return
	}
	deviceID, err := uuid.Parse(conn.DeviceID)
	if err != nil {
		h.sendError(ctx, c, f.Ref, proto.ErrCodeBadPayload, "device_id invalid")
		return
	}
	callerID := h.lookupUserForDevice(ctx, deviceID)
	if callerID == uuid.Nil {
		h.sendError(ctx, c, f.Ref, proto.ErrCodeNotAMember,
			"anonymous senders cannot fetch threads")
		return
	}
	if channelID != store.DefaultChannelID {
		isMember, mErr := h.store.IsMember(ctx, channelID, callerID)
		if mErr != nil {
			h.sendError(ctx, c, f.Ref, proto.ErrCodeInternal, "membership: "+mErr.Error())
			return
		}
		if !isMember {
			h.sendError(ctx, c, f.Ref, proto.ErrCodeNotAMember, "not a member")
			return
		}
	}
	msgs, err := h.store.ListMessagesByThread(ctx, channelID, threadID, p.BeforeSeq, p.Limit)
	if err != nil {
		h.sendError(ctx, c, f.Ref, proto.ErrCodeInternal, "fetch thread: "+err.Error())
		return
	}
	out := make([]proto.MessagePayload, 0, len(msgs))
	for _, m := range msgs {
		senderStr := ""
		if m.SenderDeviceID != uuid.Nil {
			senderStr = m.SenderDeviceID.String()
		}
		senderUserStr := ""
		if m.SenderUserID != uuid.Nil {
			senderUserStr = m.SenderUserID.String()
		}
		parentStr := ""
		if m.ParentID != nil {
			parentStr = m.ParentID.String()
		}
		threadStr := ""
		if m.ThreadID != nil {
			threadStr = m.ThreadID.String()
		}
		tBody := string(m.Body)
		out = append(out, proto.MessagePayload{
			ID:           m.ID.String(),
			ChannelID:    m.ChannelID.String(),
			Seq:          m.Seq,
			Sender:       senderStr,
			SenderUserID: senderUserStr,
			TS:           m.TS.UnixMilli(),
			Body:         tBody,
			KeyVersion:   m.KeyVersion,
			ParentID:     parentStr,
			ThreadID:     threadStr,
		})
	}
	ack, _ := proto.NewFrame(proto.TypeFetchThreadAck, f.Ref, proto.FetchThreadAckPayload{
		ChannelID: p.ChannelID,
		ThreadID:  p.ThreadID,
		Messages:  out,
	})
	if err := writeFrame(ctx, c, ack, h.cfg.WriteTimeout); err != nil {
		h.logger.Printf("fetch_thread write: %v", err)
	}
}

// ===== merged from ws_phase08b.go =====

// Phase 08b: subscribe_channel handler.
//
// Per-connection topic tracking lives in a sidecar map on WSHandler
// rather than on the Conn struct (no need to touch hub.go). Keyed by
// the *Conn pointer, value is a per-conn slice protected by its own
// mutex. The hello-time loop in ws.go bootstraps this entry; this
// handler appends to it; the disconnect defer in ws.go drains it.
//
// We use the *Conn pointer as the key because (a) it's unique per
// connection (DeviceID can be reused across reconnects), (b) it
// doesn't escape the WSHandler so there's no reference cycle, and
// (c) cleanup on disconnect is one Delete call.

// connSubs is the per-WSHandler tracking map. Keyed by *Conn, value
// is a *connSubEntry holding the lock + slice. Read in ws.go's hello
// path and disconnect defer; written here.
//
// We use sync.Map because the access pattern is "one writer per key
// (the read goroutine of that conn), many keys, no overlap." The
// stdlib map + mutex pattern works too but sync.Map fits the shape.
type connSubEntry struct {
	mu     sync.Mutex
	topics []string
}

// withSubs returns (or lazily creates) the connSubEntry for conn.
// Called from both ws.go's hello path and this file's handler.
func (h *WSHandler) withSubs(conn *Conn) *connSubEntry {
	if v, ok := h.connSubs.Load(conn); ok {
		return v.(*connSubEntry)
	}
	entry := &connSubEntry{}
	actual, _ := h.connSubs.LoadOrStore(conn, entry)
	return actual.(*connSubEntry)
}

// releaseConnSubs is called on disconnect by ws.go. It unsubscribes
// every topic the conn had registered and removes the entry from the
// tracking map. Safe to call multiple times (the slice is drained).
func (h *WSHandler) releaseConnSubs(conn *Conn) {
	v, ok := h.connSubs.LoadAndDelete(conn)
	if !ok {
		return
	}
	entry := v.(*connSubEntry)
	entry.mu.Lock()
	topics := entry.topics
	entry.topics = nil
	entry.mu.Unlock()
	if h.listener == nil {
		return
	}
	for _, t := range topics {
		h.listener.Unsubscribe(t)
	}
}

// handleSubscribeChannel verifies the caller's membership in
// payload.ChannelID, asks the listener to LISTEN on the per-channel
// topic if not already, and acks.
//
// The Subscribe call is refcounted inside the listener, so multiple
// devices for the same user (and across reconnects of the same device)
// share a single LISTEN. The unique work per-conn is the bookkeeping
// in connSubs so that disconnect releases the refcount it added.
func (h *WSHandler) handleSubscribeChannel(
	ctx context.Context,
	c *websocket.Conn,
	conn *Conn,
	f proto.Frame,
) {
	var p proto.SubscribeChannelPayload
	if err := f.DecodePayload(&p); err != nil {
		h.sendError(ctx, c, f.Ref, proto.ErrCodeBadPayload, err.Error())
		return
	}
	channelID, err := uuid.Parse(p.ChannelID)
	if err != nil {
		h.sendError(ctx, c, f.Ref, proto.ErrCodeBadPayload, "channel_id must be a UUID")
		return
	}
	if h.store == nil {
		h.sendError(ctx, c, f.Ref, proto.ErrCodeInternal, "no store configured")
		return
	}
	if h.listener == nil {
		// Without a listener we can't subscribe. Tell the client; it
		// should fall back to reconnect-after-channel-event.
		h.sendError(ctx, c, f.Ref, proto.ErrCodeInternal, "no listener configured")
		return
	}

	deviceID, err := uuid.Parse(conn.DeviceID)
	if err != nil {
		h.sendError(ctx, c, f.Ref, proto.ErrCodeBadPayload, "device_id invalid")
		return
	}
	callerID := h.lookupUserForDevice(ctx, deviceID)
	if callerID == uuid.Nil {
		h.sendError(ctx, c, f.Ref, proto.ErrCodeNotAMember,
			"anonymous senders cannot subscribe")
		return
	}
	isMember, mErr := h.store.IsMember(ctx, channelID, callerID)
	if mErr != nil {
		h.sendError(ctx, c, f.Ref, proto.ErrCodeInternal, "membership: "+mErr.Error())
		return
	}
	if !isMember {
		h.sendError(ctx, c, f.Ref, proto.ErrCodeNotAMember, "not a member")
		return
	}

	topic := pubsub.ChannelTopic(channelID)

	// Subscribe. The listener refcount makes repeat calls cheap; if
	// this conn already subscribed earlier (e.g. via hello-time loop
	// or a previous subscribe_channel call) it's still cheap. The
	// guard below makes sure we don't double-track in connSubs.
	subCtx, cancel := context.WithTimeout(ctx, 2*time.Second)
	defer cancel()
	if err := h.listener.Subscribe(subCtx, topic); err != nil {
		h.sendError(ctx, c, f.Ref, proto.ErrCodeInternal, "subscribe: "+err.Error())
		return
	}

	// Record on the conn's slice so disconnect releases the refcount.
	// Guard against duplicates: a defensive client may resubscribe;
	// the listener handles it but we shouldn't unsubscribe twice
	// at disconnect (which would push refcount negative -- caught by
	// the listener, but cleaner to avoid).
	entry := h.withSubs(conn)
	entry.mu.Lock()
	already := false
	for _, t := range entry.topics {
		if t == topic {
			already = true
			break
		}
	}
	if !already {
		entry.topics = append(entry.topics, topic)
	}
	entry.mu.Unlock()
	if already {
		// We Subscribed redundantly above (the listener refcount went
		// up by 1 too many). Compensate.
		h.listener.Unsubscribe(topic)
	}

	ack, _ := proto.NewFrame(proto.TypeSubscribeChannelAck, f.Ref,
		proto.SubscribeChannelAckPayload{ChannelID: p.ChannelID})
	if err := writeFrame(ctx, c, ack, h.cfg.WriteTimeout); err != nil {
		h.logger.Printf("subscribe_channel_ack write: %v", err)
	}
}

// ===== merged from ws_phase09g.go =====

// Phase 9.7 -- user preferences WS handlers.
//
// Frames:
//   prefs_get      -> prefs_get_ack { prefs }
//   prefs_set      -> prefs_set_ack { prefs }  (and prefs_changed push to other devices)
//
// Push:
//   prefs_changed  { prefs }   to all of the same user's other conns
//
// Validation:
//   The server keeps prefs as opaque JSONB but caps payload size to
//   8 KiB after marshal. Individual key validation lives in the SPA
//   (which knows the typed shape); the server only enforces "valid
//   JSON object" and "not too big".

const prefsMaxBytes = 8 * 1024

func (h *WSHandler) handlePrefsGet(
	ctx context.Context,
	c *websocket.Conn,
	conn *Conn,
	f proto.Frame,
) {
	if h.store == nil {
		h.sendError(ctx, c, f.Ref, proto.ErrCodeInternal, "no store configured")
		return
	}
	deviceID, err := uuid.Parse(conn.DeviceID)
	if err != nil {
		h.sendError(ctx, c, f.Ref, proto.ErrCodeBadPayload, "device_id not a UUID")
		return
	}
	userID := h.lookupUserForDevice(ctx, deviceID)
	if userID == uuid.Nil {
		h.sendError(ctx, c, f.Ref, proto.ErrCodeInternal, "unknown user")
		return
	}
	prefs, err := h.store.GetPreferences(ctx, userID)
	if err != nil {
		h.sendError(ctx, c, f.Ref, proto.ErrCodeInternal, "fetch prefs: "+err.Error())
		return
	}
	ack, _ := proto.NewFrame(proto.TypePrefsGetAck, f.Ref, proto.PrefsAckPayload{
		Prefs: prefs,
	})
	data, _ := json.Marshal(ack)
	_ = writeOne(ctx, c, data, h.cfg.WriteTimeout)
}

func (h *WSHandler) handlePrefsSet(
	ctx context.Context,
	c *websocket.Conn,
	conn *Conn,
	f proto.Frame,
) {
	if h.store == nil {
		h.sendError(ctx, c, f.Ref, proto.ErrCodeInternal, "no store configured")
		return
	}
	var p proto.PrefsSetPayload
	if err := f.DecodePayload(&p); err != nil {
		h.sendError(ctx, c, f.Ref, proto.ErrCodeBadPayload, err.Error())
		return
	}
	if p.Patch == nil {
		h.sendError(ctx, c, f.Ref, proto.ErrCodeBadPayload, "patch must be an object")
		return
	}
	// Size guard. Marshal first; if it's too big, reject before
	// touching the DB.
	patchJSON, err := json.Marshal(p.Patch)
	if err != nil {
		h.sendError(ctx, c, f.Ref, proto.ErrCodeBadPayload, "patch must be JSON object")
		return
	}
	if len(patchJSON) > prefsMaxBytes {
		h.sendError(ctx, c, f.Ref, proto.ErrCodeBadPayload, "patch too large")
		return
	}
	deviceID, err := uuid.Parse(conn.DeviceID)
	if err != nil {
		h.sendError(ctx, c, f.Ref, proto.ErrCodeBadPayload, "device_id not a UUID")
		return
	}
	userID := h.lookupUserForDevice(ctx, deviceID)
	if userID == uuid.Nil {
		h.sendError(ctx, c, f.Ref, proto.ErrCodeInternal, "unknown user")
		return
	}
	merged, err := h.store.UpsertPreferences(ctx, userID, p.Patch)
	if err != nil {
		h.sendError(ctx, c, f.Ref, proto.ErrCodeInternal, "save prefs: "+err.Error())
		return
	}
	// Ack to the caller with the merged result.
	ack, _ := proto.NewFrame(proto.TypePrefsSetAck, f.Ref, proto.PrefsAckPayload{
		Prefs: merged,
	})
	data, _ := json.Marshal(ack)
	_ = writeOne(ctx, c, data, h.cfg.WriteTimeout)

	// Fan out to this user's OTHER conns (other tabs / devices) so
	// they update their local cache. The publisher hook is the same
	// shape as the friend/presence ones.
	if h.publishPrefsChange != nil {
		if perr := h.publishPrefsChange(ctx, userID, conn.ID); perr != nil {
			h.logger.Printf("publish prefs change: %v", perr)
		}
	}
}

// PrefsChangePublisher is the hook called from handlePrefsSet to
// emit a per-user pubsub event. The Server wires this up in main.
type PrefsChangePublisher func(ctx context.Context, userID uuid.UUID, originConnID string) error

// handlePrefsEvent (on the Server side) re-fetches the prefs and
// fans out a prefs_changed frame to the user's local conns,
// skipping the originating conn so it doesn't get its own echo.
//
// Lives on the Server side because it needs s.hub access; the
// dispatcher is in server.go's handlePubsubEvent. This file just
// notes the contract.

// ---- phase 22: identity-key handlers -----------------------------------

// handlePublishIdentity stores the caller's own identity public keys.
// The server validates lengths but does NOT verify the self-signature;
// trust is established client-side on fetch.
func (h *WSHandler) handlePublishIdentity(
	ctx context.Context,
	c *websocket.Conn,
	conn *Conn,
	f proto.Frame,
) {
	if h.store == nil {
		h.sendError(ctx, c, f.Ref, proto.ErrCodeInternal, "no store configured")
		return
	}
	var p proto.PublishIdentityPayload
	if err := f.DecodePayload(&p); err != nil {
		h.sendError(ctx, c, f.Ref, proto.ErrCodeBadPayload, err.Error())
		return
	}
	x, err := base64.StdEncoding.DecodeString(p.X25519Pub)
	if err != nil || len(x) != 32 {
		h.sendError(ctx, c, f.Ref, proto.ErrCodeBadPayload, "x25519_pub must be base64 of 32 bytes")
		return
	}
	ed, err := base64.StdEncoding.DecodeString(p.Ed25519Pub)
	if err != nil || len(ed) != 32 {
		h.sendError(ctx, c, f.Ref, proto.ErrCodeBadPayload, "ed25519_pub must be base64 of 32 bytes")
		return
	}
	sig, err := base64.StdEncoding.DecodeString(p.SelfSig)
	if err != nil || len(sig) != 64 {
		h.sendError(ctx, c, f.Ref, proto.ErrCodeBadPayload, "self_sig must be base64 of 64 bytes")
		return
	}
	deviceID, err := uuid.Parse(conn.DeviceID)
	if err != nil {
		h.sendError(ctx, c, f.Ref, proto.ErrCodeBadPayload, "device_id not a UUID")
		return
	}
	userID := h.lookupUserForDevice(ctx, deviceID)
	if userID == uuid.Nil {
		h.sendError(ctx, c, f.Ref, proto.ErrCodeInternal, "unknown user")
		return
	}
	gen := p.Generation
	if gen < 1 {
		gen = 1
	}
	if err := h.store.PutIdentityKey(ctx, store.IdentityKey{
		UserID:     userID,
		Generation: gen,
		X25519Pub:  x,
		Ed25519Pub: ed,
		SelfSig:    sig,
	}); err != nil {
		h.sendError(ctx, c, f.Ref, proto.ErrCodeInternal, "store identity: "+err.Error())
		return
	}
	ack, _ := proto.NewFrame(proto.TypePublishIdentityAck, f.Ref, proto.PublishIdentityAckPayload{
		Generation: gen,
	})
	data, _ := json.Marshal(ack)
	_ = writeOne(ctx, c, data, h.cfg.WriteTimeout)
}

// handleFetchIdentity returns a user's current active identity. Found is
// false (with empty keys) when none is published. The requesting client
// verifies the self-signature before trusting the X25519 key.
func (h *WSHandler) handleFetchIdentity(
	ctx context.Context,
	c *websocket.Conn,
	conn *Conn,
	f proto.Frame,
) {
	if h.store == nil {
		h.sendError(ctx, c, f.Ref, proto.ErrCodeInternal, "no store configured")
		return
	}
	var p proto.FetchIdentityPayload
	if err := f.DecodePayload(&p); err != nil {
		h.sendError(ctx, c, f.Ref, proto.ErrCodeBadPayload, err.Error())
		return
	}
	targetID, err := uuid.Parse(p.UserID)
	if err != nil {
		h.sendError(ctx, c, f.Ref, proto.ErrCodeBadPayload, "user_id not a UUID")
		return
	}
	k, err := h.store.GetActiveIdentityKey(ctx, targetID)
	if errors.Is(err, store.ErrNotFound) {
		ack, _ := proto.NewFrame(proto.TypeFetchIdentityAck, f.Ref, proto.FetchIdentityAckPayload{
			Found:  false,
			UserID: p.UserID,
		})
		data, _ := json.Marshal(ack)
		_ = writeOne(ctx, c, data, h.cfg.WriteTimeout)
		return
	}
	if err != nil {
		h.sendError(ctx, c, f.Ref, proto.ErrCodeInternal, "fetch identity: "+err.Error())
		return
	}
	ack, _ := proto.NewFrame(proto.TypeFetchIdentityAck, f.Ref, proto.FetchIdentityAckPayload{
		Found:      true,
		UserID:     p.UserID,
		Generation: k.Generation,
		X25519Pub:  base64.StdEncoding.EncodeToString(k.X25519Pub),
		Ed25519Pub: base64.StdEncoding.EncodeToString(k.Ed25519Pub),
		SelfSig:    base64.StdEncoding.EncodeToString(k.SelfSig),
	})
	data, _ := json.Marshal(ack)
	_ = writeOne(ctx, c, data, h.cfg.WriteTimeout)
}

// handlePublishChannelKey stores one member's wrapped space key for a
// channel + key_version. Authz: the caller must be a member of the channel,
// and so must the recipient. The server never sees the plaintext key -- it
// stores the opaque suite-tagged wrap blob (online-member auto-rewrap).
func (h *WSHandler) handlePublishChannelKey(
	ctx context.Context,
	c *websocket.Conn,
	conn *Conn,
	f proto.Frame,
) {
	if h.store == nil {
		h.sendError(ctx, c, f.Ref, proto.ErrCodeInternal, "no store configured")
		return
	}
	var p proto.PublishChannelKeyPayload
	if err := f.DecodePayload(&p); err != nil {
		h.sendError(ctx, c, f.Ref, proto.ErrCodeBadPayload, err.Error())
		return
	}
	channelID, err := uuid.Parse(p.ChannelID)
	if err != nil {
		h.sendError(ctx, c, f.Ref, proto.ErrCodeBadPayload, "channel_id not a UUID")
		return
	}
	recipientID, err := uuid.Parse(p.RecipientID)
	if err != nil {
		h.sendError(ctx, c, f.Ref, proto.ErrCodeBadPayload, "recipient_id not a UUID")
		return
	}
	if p.WrapSuite < 1 {
		h.sendError(ctx, c, f.Ref, proto.ErrCodeBadPayload, "wrap_suite must be >= 1")
		return
	}
	blob, err := base64.StdEncoding.DecodeString(p.Blob)
	if err != nil || len(blob) == 0 {
		h.sendError(ctx, c, f.Ref, proto.ErrCodeBadPayload, "blob must be non-empty base64")
		return
	}
	deviceID, err := uuid.Parse(conn.DeviceID)
	if err != nil {
		h.sendError(ctx, c, f.Ref, proto.ErrCodeBadPayload, "device_id not a UUID")
		return
	}
	callerID := h.lookupUserForDevice(ctx, deviceID)
	if callerID == uuid.Nil {
		h.sendError(ctx, c, f.Ref, proto.ErrCodeInternal, "unknown user")
		return
	}
	// The caller must be a member of the channel to deposit keys into it.
	callerIsMember, err := h.store.IsMember(ctx, channelID, callerID)
	if err != nil {
		h.sendError(ctx, c, f.Ref, proto.ErrCodeInternal, "membership check: "+err.Error())
		return
	}
	if !callerIsMember {
		h.sendError(ctx, c, f.Ref, proto.ErrCodeNotAMember, "not a member of this channel")
		return
	}
	// Only wrap keys to actual members of the channel.
	recipientIsMember, err := h.store.IsMember(ctx, channelID, recipientID)
	if err != nil {
		h.sendError(ctx, c, f.Ref, proto.ErrCodeInternal, "recipient membership check: "+err.Error())
		return
	}
	if !recipientIsMember {
		h.sendError(ctx, c, f.Ref, proto.ErrCodeNotAMember, "recipient is not a member of this channel")
		return
	}
	ver := p.KeyVersion
	if ver < 1 {
		ver = 1
	}
	if err := h.store.PutChannelKey(ctx, store.ChannelKey{
		ChannelID:   channelID,
		KeyVersion:  ver,
		RecipientID: recipientID,
		WrapSuite:   p.WrapSuite,
		Blob:        blob,
	}); err != nil {
		h.sendError(ctx, c, f.Ref, proto.ErrCodeInternal, "store channel key: "+err.Error())
		return
	}
	ack, _ := proto.NewFrame(proto.TypePublishChannelKeyAck, f.Ref, proto.PublishChannelKeyAckPayload{
		ChannelID:   p.ChannelID,
		KeyVersion:  ver,
		RecipientID: p.RecipientID,
	})
	data, _ := json.Marshal(ack)
	_ = writeOne(ctx, c, data, h.cfg.WriteTimeout)
}

// handleFetchChannelKey returns the CALLER's own wrapped space key for a
// channel + key_version. The recipient is always the authenticated caller --
// there is no way to fetch another member's wrap. Found is false when no
// wrap exists yet (the caller waits for an online member to wrap it).
func (h *WSHandler) handleFetchChannelKey(
	ctx context.Context,
	c *websocket.Conn,
	conn *Conn,
	f proto.Frame,
) {
	if h.store == nil {
		h.sendError(ctx, c, f.Ref, proto.ErrCodeInternal, "no store configured")
		return
	}
	var p proto.FetchChannelKeyPayload
	if err := f.DecodePayload(&p); err != nil {
		h.sendError(ctx, c, f.Ref, proto.ErrCodeBadPayload, err.Error())
		return
	}
	channelID, err := uuid.Parse(p.ChannelID)
	if err != nil {
		h.sendError(ctx, c, f.Ref, proto.ErrCodeBadPayload, "channel_id not a UUID")
		return
	}
	deviceID, err := uuid.Parse(conn.DeviceID)
	if err != nil {
		h.sendError(ctx, c, f.Ref, proto.ErrCodeBadPayload, "device_id not a UUID")
		return
	}
	callerID := h.lookupUserForDevice(ctx, deviceID)
	if callerID == uuid.Nil {
		h.sendError(ctx, c, f.Ref, proto.ErrCodeInternal, "unknown user")
		return
	}
	isMember, err := h.store.IsMember(ctx, channelID, callerID)
	if err != nil {
		h.sendError(ctx, c, f.Ref, proto.ErrCodeInternal, "membership check: "+err.Error())
		return
	}
	if !isMember {
		h.sendError(ctx, c, f.Ref, proto.ErrCodeNotAMember, "not a member of this channel")
		return
	}
	ver := p.KeyVersion
	if ver < 1 {
		ver = 1
	}
	k, err := h.store.GetChannelKey(ctx, channelID, ver, callerID)
	if errors.Is(err, store.ErrNotFound) {
		ack, _ := proto.NewFrame(proto.TypeFetchChannelKeyAck, f.Ref, proto.FetchChannelKeyAckPayload{
			Found:     false,
			ChannelID: p.ChannelID,
		})
		data, _ := json.Marshal(ack)
		_ = writeOne(ctx, c, data, h.cfg.WriteTimeout)
		return
	}
	if err != nil {
		h.sendError(ctx, c, f.Ref, proto.ErrCodeInternal, "fetch channel key: "+err.Error())
		return
	}
	ack, _ := proto.NewFrame(proto.TypeFetchChannelKeyAck, f.Ref, proto.FetchChannelKeyAckPayload{
		Found:      true,
		ChannelID:  p.ChannelID,
		KeyVersion: k.KeyVersion,
		WrapSuite:  k.WrapSuite,
		Blob:       base64.StdEncoding.EncodeToString(k.Blob),
	})
	data, _ := json.Marshal(ack)
	_ = writeOne(ctx, c, data, h.cfg.WriteTimeout)
}

// handleFetchChannelKeyRecipients lists which members already hold a wrapped
// key for (channel, key_version). The caller must be a member. The client
// diffs this against the channel member list to find who still needs the key
// and wraps it for them. The server reports only WHO has a key, never keys.
func (h *WSHandler) handleFetchChannelKeyRecipients(
	ctx context.Context,
	c *websocket.Conn,
	conn *Conn,
	f proto.Frame,
) {
	if h.store == nil {
		h.sendError(ctx, c, f.Ref, proto.ErrCodeInternal, "no store configured")
		return
	}
	var p proto.FetchChannelKeyRecipientsPayload
	if err := f.DecodePayload(&p); err != nil {
		h.sendError(ctx, c, f.Ref, proto.ErrCodeBadPayload, err.Error())
		return
	}
	channelID, err := uuid.Parse(p.ChannelID)
	if err != nil {
		h.sendError(ctx, c, f.Ref, proto.ErrCodeBadPayload, "channel_id not a UUID")
		return
	}
	deviceID, err := uuid.Parse(conn.DeviceID)
	if err != nil {
		h.sendError(ctx, c, f.Ref, proto.ErrCodeBadPayload, "device_id not a UUID")
		return
	}
	callerID := h.lookupUserForDevice(ctx, deviceID)
	if callerID == uuid.Nil {
		h.sendError(ctx, c, f.Ref, proto.ErrCodeInternal, "unknown user")
		return
	}
	isMember, err := h.store.IsMember(ctx, channelID, callerID)
	if err != nil {
		h.sendError(ctx, c, f.Ref, proto.ErrCodeInternal, "membership check: "+err.Error())
		return
	}
	if !isMember {
		h.sendError(ctx, c, f.Ref, proto.ErrCodeNotAMember, "not a member of this channel")
		return
	}
	ver := p.KeyVersion
	if ver < 1 {
		ver = 1
	}
	ids, err := h.store.ListChannelKeyRecipients(ctx, channelID, ver)
	if err != nil {
		h.sendError(ctx, c, f.Ref, proto.ErrCodeInternal, "list recipients: "+err.Error())
		return
	}
	recips := make([]string, 0, len(ids))
	for _, id := range ids {
		recips = append(recips, id.String())
	}
	ack, _ := proto.NewFrame(proto.TypeFetchChannelKeyRecipientsAck, f.Ref, proto.FetchChannelKeyRecipientsAckPayload{
		ChannelID:  p.ChannelID,
		KeyVersion: ver,
		Recipients: recips,
	})
	data, _ := json.Marshal(ack)
	_ = writeOne(ctx, c, data, h.cfg.WriteTimeout)
}

// handleRotateChannelKey advances a channel's current_key_version by exactly +1
// (phase 25, manual creator-only rotation). The caller must be the channel
// creator; the new-version wraps must ALREADY be uploaded via
// publish_channel_key (the client does this before sending this frame). The
// version bump is atomic + monotonic in the store (single UPDATE), so
// concurrent rotations can't skip or race. On success, new sends should carry
// the new version; older versions remain accepted (the send gate only rejects
// versions ABOVE current) so in-flight messages and history still work.
func (h *WSHandler) handleRotateChannelKey(
	ctx context.Context,
	c *websocket.Conn,
	conn *Conn,
	f proto.Frame,
) {
	if h.store == nil {
		h.sendError(ctx, c, f.Ref, proto.ErrCodeInternal, "no store configured")
		return
	}
	var p proto.RotateChannelKeyPayload
	if err := f.DecodePayload(&p); err != nil {
		h.sendError(ctx, c, f.Ref, proto.ErrCodeBadPayload, err.Error())
		return
	}
	channelID, err := uuid.Parse(p.ChannelID)
	if err != nil {
		h.sendError(ctx, c, f.Ref, proto.ErrCodeBadPayload, "channel_id not a UUID")
		return
	}
	if p.NewVersion < 2 {
		h.sendError(ctx, c, f.Ref, proto.ErrCodeBadPayload, "new_version must be >= 2")
		return
	}
	deviceID, err := uuid.Parse(conn.DeviceID)
	if err != nil {
		h.sendError(ctx, c, f.Ref, proto.ErrCodeBadPayload, "device_id not a UUID")
		return
	}
	callerID := h.lookupUserForDevice(ctx, deviceID)
	if callerID == uuid.Nil {
		h.sendError(ctx, c, f.Ref, proto.ErrCodeInternal, "unknown user")
		return
	}

	// Atomic + monotonic + creator-only: a single UPDATE that only advances
	// from NewVersion-1 to NewVersion when created_by == caller.
	ok, err := h.store.AdvanceChannelKeyVersion(ctx, channelID, callerID, p.NewVersion)
	if err != nil {
		h.sendError(ctx, c, f.Ref, proto.ErrCodeInternal, "rotate: "+err.Error())
		return
	}
	if !ok {
		// Disambiguate the failure for a useful error.
		ch, gerr := h.store.GetChannel(ctx, channelID)
		if gerr != nil {
			h.sendError(ctx, c, f.Ref, proto.ErrCodeChannelNotFound, "channel not found")
			return
		}
		if ch.CreatedBy == nil || *ch.CreatedBy != callerID {
			h.sendError(ctx, c, f.Ref, proto.ErrCodeNotChannelCreator,
				"only the channel creator can rotate the key")
			return
		}
		h.sendError(ctx, c, f.Ref, proto.ErrCodeStaleKeyVersion,
			"new_version must be exactly current+1 (current advanced under you; refetch and retry)")
		return
	}

	ack, _ := proto.NewFrame(proto.TypeRotateChannelKeyAck, f.Ref, proto.RotateChannelKeyAckPayload{
		ChannelID:         p.ChannelID,
		CurrentKeyVersion: p.NewVersion,
	})
	data, _ := json.Marshal(ack)
	_ = writeOne(ctx, c, data, h.cfg.WriteTimeout)

	// Phase 25-2: push channel_event{kind="key_rotated"} to every member so
	// non-rotator clients learn the new current_key_version promptly (the
	// summary carries it) and re-sync their key, instead of lagging until the
	// next list_channels. Best-effort: a failed push only delays a client until
	// its next refetch; it never breaks correctness (the gate accepts older
	// versions). Reuses the create-channel push path.
	ch, gerr := h.store.GetChannel(ctx, channelID)
	if gerr == nil {
		memberIDs, merr := h.store.ListMembersForChannel(ctx, channelID)
		if merr == nil {
			summary := channelSummaryFromStore(
				store.ChannelWithMembers{Channel: ch, MemberIDs: memberIDs},
				nil, // handles tolerated nil
			)
			for _, m := range memberIDs {
				if perr := h.publishChannelEvent(ctx, m, channelID, "key_rotated", summary); perr != nil {
					h.logger.Printf("publish channel_event key_rotated to %s: %v", m, perr)
				}
			}
		}
	}
}

// handleRemoveMember removes a member from a channel and flags the channel for
// rotation (member removal + rotate-on-removal).
//
// Authz:
//   - the channel OWNER may remove any non-owner member;
//   - a non-owner may remove ONLY themselves (leave);
//   - DMs reject removal; the owner cannot be removed.
//
// On success: RemoveMember sets channels.rotation_pending. We then push
// channel_event{kind="member_removed"} to the remaining members (the client
// drops the user from the roster), and channel_event{kind="rotate_needed"} to
// the OWNER so their client rotates the key (excluding the removed member). If
// the owner is offline, rotation_pending stays set and the owner's client
// rotates on next connect/open -- the pending state is durable + visible.
func (h *WSHandler) handleRemoveMember(
	ctx context.Context,
	c *websocket.Conn,
	conn *Conn,
	f proto.Frame,
) {
	if h.store == nil {
		h.sendError(ctx, c, f.Ref, proto.ErrCodeInternal, "no store configured")
		return
	}
	var p proto.RemoveMemberPayload
	if err := f.DecodePayload(&p); err != nil {
		h.sendError(ctx, c, f.Ref, proto.ErrCodeBadPayload, err.Error())
		return
	}
	channelID, err := uuid.Parse(p.ChannelID)
	if err != nil {
		h.sendError(ctx, c, f.Ref, proto.ErrCodeBadPayload, "channel_id not a UUID")
		return
	}
	targetID, err := uuid.Parse(p.TargetID)
	if err != nil {
		h.sendError(ctx, c, f.Ref, proto.ErrCodeBadPayload, "target_id not a UUID")
		return
	}
	deviceID, err := uuid.Parse(conn.DeviceID)
	if err != nil {
		h.sendError(ctx, c, f.Ref, proto.ErrCodeBadPayload, "device_id not a UUID")
		return
	}
	callerID := h.lookupUserForDevice(ctx, deviceID)
	if callerID == uuid.Nil {
		h.sendError(ctx, c, f.Ref, proto.ErrCodeInternal, "unknown user")
		return
	}

	callerRole, rErr := h.store.GetMemberRole(ctx, channelID, callerID)
	if rErr != nil {
		if errors.Is(rErr, store.ErrNotAMember) {
			h.sendError(ctx, c, f.Ref, proto.ErrCodeNotAMember, "not a member of channel")
			return
		}
		h.sendError(ctx, c, f.Ref, proto.ErrCodeInternal, "role check: "+rErr.Error())
		return
	}
	if callerRole != "owner" && callerID != targetID {
		h.sendError(ctx, c, f.Ref, proto.ErrCodeRemoveForbidden,
			"only the owner can remove other members; you may remove only yourself")
		return
	}

	// gov-1b-2: in democratic mode, removing ANOTHER member is a privileged
	// action that must go through a proposal. Self-leave (caller == target) is
	// always allowed. A failed governance read falls through to the existing
	// dictator-style behavior.
	if callerID != targetID {
		if gov, gErr := h.store.GetChannelGovernance(ctx, channelID); gErr == nil &&
			gov.Mode == store.GovernanceModeDemocratic {
			h.sendError(ctx, c, f.Ref, proto.ErrCodeUnilateralForbidden,
				"channel is in democratic mode; removing another member requires a proposal")
			return
		}
	}

	if err := h.store.RemoveMember(ctx, channelID, targetID); err != nil {
		switch {
		case errors.Is(err, store.ErrDMNoRemoval):
			h.sendError(ctx, c, f.Ref, proto.ErrCodeDMNoRemoval, "cannot remove members from a DM")
		case errors.Is(err, store.ErrCannotRemoveOwner):
			h.sendError(ctx, c, f.Ref, proto.ErrCodeCannotRemoveOwner, "the channel owner cannot be removed")
		case errors.Is(err, store.ErrNotAMember):
			h.sendError(ctx, c, f.Ref, proto.ErrCodeNotAMember, "target is not a member")
		case errors.Is(err, store.ErrChannelNotFound):
			h.sendError(ctx, c, f.Ref, proto.ErrCodeChannelNotFound, "channel not found")
		default:
			h.sendError(ctx, c, f.Ref, proto.ErrCodeInternal, "remove member: "+err.Error())
		}
		return
	}

	ack, _ := proto.NewFrame(proto.TypeRemoveMemberAck, f.Ref, proto.RemoveMemberAckPayload{
		ChannelID: p.ChannelID,
		TargetID:  p.TargetID,
	})
	data, _ := json.Marshal(ack)
	_ = writeOne(ctx, c, data, h.cfg.WriteTimeout)

	ch, gerr := h.store.GetChannel(ctx, channelID)
	if gerr != nil {
		return
	}
	remaining, merr := h.store.ListMembersForChannel(ctx, channelID)
	if merr != nil {
		return
	}
	summary := channelSummaryFromStore(
		store.ChannelWithMembers{Channel: ch, MemberIDs: remaining},
		nil,
	)

	if perr := h.publishChannelEvent(ctx, targetID, channelID, "member_removed", summary); perr != nil {
		h.logger.Printf("publish member_removed to %s: %v", targetID, perr)
	}
	for _, m := range remaining {
		if perr := h.publishChannelEvent(ctx, m, channelID, "member_removed", summary); perr != nil {
			h.logger.Printf("publish member_removed to %s: %v", m, perr)
		}
	}

	if ch.CreatedBy != nil {
		if perr := h.publishChannelEvent(ctx, *ch.CreatedBy, channelID, "rotate_needed", summary); perr != nil {
			h.logger.Printf("publish rotate_needed to owner %s: %v", *ch.CreatedBy, perr)
		}
	}
}

// handleAddMember adds a member to a channel (add-member). Any existing member
// may add (invite); the target must be a real user. DMs reject adds. The new
// member does NOT get a key version bump -- a key holder wraps the CURRENT key
// for them (client reshareKey), so they read from join-time forward.
//
// On success: push channel_event{kind="member_added"} to every member,
// INCLUDING the new one (so their client learns about the channel) and the
// existing members (so their rosters update and a key holder reshares the key).
func (h *WSHandler) handleAddMember(
	ctx context.Context,
	c *websocket.Conn,
	conn *Conn,
	f proto.Frame,
) {
	if h.store == nil {
		h.sendError(ctx, c, f.Ref, proto.ErrCodeInternal, "no store configured")
		return
	}
	var p proto.AddMemberPayload
	if err := f.DecodePayload(&p); err != nil {
		h.sendError(ctx, c, f.Ref, proto.ErrCodeBadPayload, err.Error())
		return
	}
	channelID, err := uuid.Parse(p.ChannelID)
	if err != nil {
		h.sendError(ctx, c, f.Ref, proto.ErrCodeBadPayload, "channel_id not a UUID")
		return
	}
	targetID, err := uuid.Parse(p.TargetID)
	if err != nil {
		h.sendError(ctx, c, f.Ref, proto.ErrCodeBadPayload, "target_id not a UUID")
		return
	}
	deviceID, err := uuid.Parse(conn.DeviceID)
	if err != nil {
		h.sendError(ctx, c, f.Ref, proto.ErrCodeBadPayload, "device_id not a UUID")
		return
	}
	callerID := h.lookupUserForDevice(ctx, deviceID)
	if callerID == uuid.Nil {
		h.sendError(ctx, c, f.Ref, proto.ErrCodeInternal, "unknown user")
		return
	}

	isMember, mErr := h.store.IsMember(ctx, channelID, callerID)
	if mErr != nil {
		h.sendError(ctx, c, f.Ref, proto.ErrCodeInternal, "membership check: "+mErr.Error())
		return
	}
	if !isMember {
		h.sendError(ctx, c, f.Ref, proto.ErrCodeNotAMember, "not a member of channel")
		return
	}

	// gov-1b-2: in democratic mode, adding a member must go through a proposal.
	if gov, gErr := h.store.GetChannelGovernance(ctx, channelID); gErr == nil &&
		gov.Mode == store.GovernanceModeDemocratic {
		h.sendError(ctx, c, f.Ref, proto.ErrCodeUnilateralForbidden,
			"channel is in democratic mode; adding a member requires a proposal")
		return
	}

	if _, uErr := h.store.GetUserByID(ctx, targetID); uErr != nil {
		if errors.Is(uErr, store.ErrNotFound) {
			h.sendError(ctx, c, f.Ref, proto.ErrCodeBadPayload, "target user not found")
			return
		}
		h.sendError(ctx, c, f.Ref, proto.ErrCodeInternal, "user lookup: "+uErr.Error())
		return
	}

	if err := h.store.AddMember(ctx, channelID, targetID); err != nil {
		switch {
		case errors.Is(err, store.ErrDMNoAdd):
			h.sendError(ctx, c, f.Ref, proto.ErrCodeDMNoAdd, "cannot add members to a DM")
		case errors.Is(err, store.ErrAlreadyMember):
			h.sendError(ctx, c, f.Ref, proto.ErrCodeAlreadyMember, "user is already a member")
		case errors.Is(err, store.ErrChannelNotFound):
			h.sendError(ctx, c, f.Ref, proto.ErrCodeChannelNotFound, "channel not found")
		default:
			h.sendError(ctx, c, f.Ref, proto.ErrCodeInternal, "add member: "+err.Error())
		}
		return
	}

	ack, _ := proto.NewFrame(proto.TypeAddMemberAck, f.Ref, proto.AddMemberAckPayload{
		ChannelID: p.ChannelID,
		TargetID:  p.TargetID,
	})
	data, _ := json.Marshal(ack)
	_ = writeOne(ctx, c, data, h.cfg.WriteTimeout)

	ch, gerr := h.store.GetChannel(ctx, channelID)
	if gerr != nil {
		return
	}
	members, lErr := h.store.ListMembersForChannel(ctx, channelID)
	if lErr != nil {
		return
	}
	summary := channelSummaryFromStore(
		store.ChannelWithMembers{Channel: ch, MemberIDs: members},
		nil,
	)

	for _, m := range members {
		if perr := h.publishChannelEvent(ctx, m, channelID, "member_added", summary); perr != nil {
			h.logger.Printf("publish member_added to %s: %v", m, perr)
		}
	}
}

// handleDeleteMessage soft-deletes a message (governance prerequisite).
//
// Authz: dictator-style -- ONLY the channel owner may delete. This is the
// faithful "owner acts unilaterally" semantic; the democratic delete_message
// proposal type wraps this same store primitive later. A non-owner (even the
// message's own author) gets delete_forbidden in v1.
//
// On success: store.DeleteMessage scrubs the body server-side and stamps the
// tombstone (deleted_at, deleted_by), then we push message_deleted on the
// per-channel topic so every connected member tombstones the row locally. The
// push gates on the DELETION time (handled listener-side via now()), not the
// message's original ts, so members who connected long after the message was
// sent still receive the tombstone.
//
// Idempotent: re-deleting an already-tombstoned message acks without a second
// push (store returns ErrAlreadyDeleted).
func (h *WSHandler) handleDeleteMessage(
	ctx context.Context,
	c *websocket.Conn,
	conn *Conn,
	f proto.Frame,
) {
	if h.store == nil {
		h.sendError(ctx, c, f.Ref, proto.ErrCodeInternal, "no store configured")
		return
	}
	var p proto.DeleteMessagePayload
	if err := f.DecodePayload(&p); err != nil {
		h.sendError(ctx, c, f.Ref, proto.ErrCodeBadPayload, err.Error())
		return
	}
	channelID, err := uuid.Parse(p.ChannelID)
	if err != nil {
		h.sendError(ctx, c, f.Ref, proto.ErrCodeBadPayload, "channel_id not a UUID")
		return
	}
	messageID, err := uuid.Parse(p.MessageID)
	if err != nil {
		h.sendError(ctx, c, f.Ref, proto.ErrCodeBadPayload, "message_id not a UUID")
		return
	}
	deviceID, err := uuid.Parse(conn.DeviceID)
	if err != nil {
		h.sendError(ctx, c, f.Ref, proto.ErrCodeBadPayload, "device_id not a UUID")
		return
	}
	callerID := h.lookupUserForDevice(ctx, deviceID)
	if callerID == uuid.Nil {
		h.sendError(ctx, c, f.Ref, proto.ErrCodeInternal, "unknown user")
		return
	}

	// Owner-only authz (dictator-style). GetMemberRole also enforces
	// membership: a non-member is ErrNotAMember, not "forbidden".
	role, rErr := h.store.GetMemberRole(ctx, channelID, callerID)
	if rErr != nil {
		if errors.Is(rErr, store.ErrNotAMember) {
			h.sendError(ctx, c, f.Ref, proto.ErrCodeNotAMember, "not a member of channel")
			return
		}
		h.sendError(ctx, c, f.Ref, proto.ErrCodeInternal, "role check: "+rErr.Error())
		return
	}
	if role != "owner" {
		h.sendError(ctx, c, f.Ref, proto.ErrCodeDeleteForbidden,
			"only the channel owner may delete messages")
		return
	}

	// gov-1b-2: in democratic mode, deleting a message must go through a
	// proposal.
	if gov, gErr := h.store.GetChannelGovernance(ctx, channelID); gErr == nil &&
		gov.Mode == store.GovernanceModeDemocratic {
		h.sendError(ctx, c, f.Ref, proto.ErrCodeUnilateralForbidden,
			"channel is in democratic mode; deleting a message requires a proposal")
		return
	}

	tsTime := time.UnixMilli(p.TS)
	del, dErr := h.store.DeleteMessage(ctx, tsTime, messageID, channelID, callerID)
	if dErr != nil {
		switch {
		case errors.Is(dErr, store.ErrAlreadyDeleted):
			// Idempotent: already a tombstone. Ack success, skip the push.
			ack, _ := proto.NewFrame(proto.TypeDeleteMessageAck, f.Ref, proto.DeleteMessageAckPayload{
				ChannelID: p.ChannelID,
				MessageID: p.MessageID,
			})
			data, _ := json.Marshal(ack)
			_ = writeOne(ctx, c, data, h.cfg.WriteTimeout)
			return
		case errors.Is(dErr, store.ErrMessageNotFound):
			h.sendError(ctx, c, f.Ref, proto.ErrCodeMessageNotFound, "message not found")
			return
		default:
			h.sendError(ctx, c, f.Ref, proto.ErrCodeInternal, "delete message: "+dErr.Error())
			return
		}
	}

	ack, _ := proto.NewFrame(proto.TypeDeleteMessageAck, f.Ref, proto.DeleteMessageAckPayload{
		ChannelID: p.ChannelID,
		MessageID: p.MessageID,
	})
	data, _ := json.Marshal(ack)
	_ = writeOne(ctx, c, data, h.cfg.WriteTimeout)

	// Publish the per-channel message_deleted push. The scrub is already
	// committed (DeleteMessage ran its own tx), so the listener's GetMessage
	// will see the tombstone. del.TS carries the FULL-precision ts the
	// listener needs to re-fetch the row. SenderConnID is empty: we do NOT
	// suppress the echo, so the deleter's own client also tombstones and
	// every member converges on the same state.
	if perr := pgxBegin(ctx, h.store, func(tx pgx.Tx) error {
		ev := pubsub.Event{
			Kind:       "message_deleted",
			MessageID:  messageID,
			TS:         del.TS,
			ChannelID:  channelID,
			InstanceID: h.instanceID,
		}
		return pubsub.PublishMessageWithTx(ctx, tx, ev)
	}); perr != nil {
		h.logger.Printf("publish message_deleted %s: %v", messageID, perr)
	}
}
