package server

import (
	"context"
	"encoding/json"
	"errors"
	"log"
	"net/http"
	"time"

	"github.com/coder/websocket"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"

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
}

// NewWSHandler constructs a handler. Phase 06 adds the presence/friends
// stores and the two publishers.
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

	// Phase 05 device-ensure shim (until phase 11 wires real auth). We
	// also bump last_seen_at on the user as part of this so the
	// dormancy GC has accurate data.
	if h.store != nil {
		if err := ensureDeviceForTesting(ctx, h.store, deviceID); err != nil {
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

	conn := NewConn(hello.DeviceID, "", func(reason error) {
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

	// Welcome.
	welcome, _ := proto.NewFrame(proto.TypeWelcome, "", proto.WelcomePayload{
		UserID:   conn.UserID,
		DeviceID: conn.DeviceID,
		Channels: []string{},
	})
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

		default:
			h.sendError(ctx, c, f.Ref, proto.ErrCodeUnknownType,
				"unknown frame type: "+f.Type)
		}
	}
}

// handleSend persists the message and emits a NOTIFY, same as phase 05.
// Unchanged from phase 05 except routing through h.publishMessage if
// non-nil (not used in phase 06; left as the hook for future cleanup).
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
	if err := ensureDeviceForTesting(ctx, h.store, deviceID); err != nil {
		h.sendError(ctx, c, f.Ref, proto.ErrCodeInternal, "ensure device: "+err.Error())
		return
	}

	err = pgxBegin(ctx, h.store, func(tx pgx.Tx) error {
		var seq int64
		if err := tx.QueryRow(ctx,
			`UPDATE channel_seq SET next_seq = next_seq + 1
			   WHERE channel_id = $1
			 RETURNING next_seq - 1`,
			store.DefaultChannelID,
		).Scan(&seq); err != nil {
			return err
		}
		msgID := uuid.New()
		var ts time.Time
		if err := tx.QueryRow(ctx,
			`INSERT INTO messages
			   (id, channel_id, sender_device_id, seq, content_type, ciphertext)
			 VALUES ($1, $2, $3, $4, 'application', $5)
			 RETURNING ts`,
			msgID, store.DefaultChannelID, deviceID, seq, []byte(p.Body),
		).Scan(&ts); err != nil {
			return err
		}
		return pubsub.PublishWithTx(ctx, tx, pubsub.Event{
			Kind:           "message",
			MessageID:      msgID,
			TS:             ts,
			ChannelID:      store.DefaultChannelID,
			SenderDeviceID: deviceID,
			InstanceID:     h.instanceID,
		})
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

// ensureDeviceForTesting upserts a minimal device row tied to alice.
// PHASE 05/06 ONLY -- phase 11 replaces this with session-based device
// resolution.
//
// Phase 06 update: requires that alice is active. If she's not, the
// caller (ServeHTTP) has already rejected the connection.
func ensureDeviceForTesting(ctx context.Context, st *store.Store, deviceID uuid.UUID) error {
	aliceID := uuid.MustParse("00000000-0000-0000-0000-00000000a11c")
	_, err := st.Pool.Exec(ctx,
		`INSERT INTO devices (id, user_id, device_type, device_label)
		 VALUES ($1, $2, 'browser-unknown', 'phase-06-test')
		 ON CONFLICT (id) DO NOTHING`,
		deviceID, aliceID,
	)
	return err
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
