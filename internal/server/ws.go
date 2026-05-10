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

	"github.com/scuq/chalk/internal/proto"
	"github.com/scuq/chalk/internal/pubsub"
	"github.com/scuq/chalk/internal/store"
)

// WSConfig tunes WebSocket behavior. Defaults are chosen for chat workloads.
type WSConfig struct {
	PingInterval     time.Duration
	PingTimeout      time.Duration
	WriteTimeout     time.Duration
	HandshakeTimeout time.Duration
}

// DefaultWSConfig returns the production defaults.
func DefaultWSConfig() WSConfig {
	return WSConfig{
		PingInterval:     15 * time.Second,
		PingTimeout:      30 * time.Second,
		WriteTimeout:     10 * time.Second,
		HandshakeTimeout: 5 * time.Second,
	}
}

// WSHandler upgrades HTTP requests to chalk's WebSocket protocol and runs
// per-connection read/write/ping loops.
type WSHandler struct {
	hub        *Hub
	store      *store.Store
	cfg        WSConfig
	logger     *log.Logger
	instanceID string
}

// NewWSHandler constructs a handler. instanceID is the chalkd process'
// identity; it tags outbound NOTIFY events for visibility/debugging.
func NewWSHandler(hub *Hub, st *store.Store, cfg WSConfig, instanceID string, logger *log.Logger) *WSHandler {
	if logger == nil {
		logger = log.Default()
	}
	return &WSHandler{
		hub:        hub,
		store:      st,
		cfg:        cfg,
		logger:     logger,
		instanceID: instanceID,
	}
}

// ServeHTTP implements http.Handler.
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

	h.logger.Printf("ws connected: device=%s", conn.DeviceID)
	defer h.logger.Printf("ws disconnected: device=%s", conn.DeviceID)

	doneR := make(chan struct{})
	doneW := make(chan struct{})
	go func() {
		defer close(doneR)
		h.readLoop(ctx, c, conn)
	}()
	go func() {
		defer close(doneW)
		h.writeLoop(ctx, c, conn)
	}()
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
		default:
			h.sendError(ctx, c, f.Ref, proto.ErrCodeUnknownType, "unknown frame type: "+f.Type)
		}
	}
}

// handleSend persists the message in a transaction that ends with a NOTIFY.
// Local fan-out happens via the same listener path that remote instances
// use, so the code path is uniform regardless of where receivers are.
//
// Phase 05 trust model:
//   * The "sender device" is whatever the client claimed in its hello
//     frame. Phase 11 will tie this to a passkey-authenticated session.
//   * For phase 05, the sender's device row is auto-created if it doesn't
//     exist, with device_type=browser-unknown. This makes the integration
//     tests work without phase-04 changes; phase 11 replaces this with
//     proper authn.
//   * All messages go to DefaultChannelID (the placeholder channel from
//     migration 0002). Phase 08 introduces channel routing.
func (h *WSHandler) handleSend(ctx context.Context, c *websocket.Conn, conn *Conn, f proto.Frame) {
	var p proto.SendPayload
	if err := f.DecodePayload(&p); err != nil {
		h.sendError(ctx, c, f.Ref, proto.ErrCodeBadPayload, err.Error())
		return
	}

	if h.store == nil {
		// No store wired -- shouldn't happen in real builds, but keep
		// dev/test paths honest.
		h.sendError(ctx, c, f.Ref, proto.ErrCodeInternal, "no store configured")
		return
	}

	deviceID, err := uuid.Parse(conn.DeviceID)
	if err != nil {
		h.sendError(ctx, c, f.Ref, proto.ErrCodeBadPayload, "device_id must be a UUID")
		return
	}

	// Ensure the sender's device row exists. Phase 11 will replace this
	// with a session-based device lookup.
	if err := ensureDeviceForTesting(ctx, h.store, deviceID); err != nil {
		h.sendError(ctx, c, f.Ref, proto.ErrCodeInternal, "ensure device: "+err.Error())
		h.logger.Printf("ensure device: %v", err)
		return
	}

	// Insert message + NOTIFY in a single transaction. We use a custom tx
	// instead of store.InsertMessage because we want the NOTIFY in the
	// same tx; refactoring InsertMessage to return its tx would muddy the
	// store interface. The duplication is small.
	var inserted store.Message
	err = pgxBegin(ctx, h.store, func(tx pgx.Tx) error {
		// Allocate seq.
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
		err := tx.QueryRow(ctx,
			`INSERT INTO messages
			   (id, channel_id, sender_device_id, seq, content_type, ciphertext)
			 VALUES ($1, $2, $3, $4, 'application', $5)
			 RETURNING ts`,
			msgID, store.DefaultChannelID, deviceID, seq, []byte(p.Body),
		).Scan(&ts)
		if err != nil {
			return err
		}
		inserted = store.Message{
			ID:             msgID,
			ChannelID:      store.DefaultChannelID,
			SenderDeviceID: deviceID,
			Seq:            seq,
			TS:             ts,
			ContentType:    "application",
			Ciphertext:     []byte(p.Body),
		}

		// NOTIFY in the same tx; delivered at COMMIT.
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

	_ = inserted // currently unused beyond the insert; phase 06 surfaces the seq back to sender
}

// pgxBegin runs fn inside a transaction. We can't use store.withTx (it's
// unexported); rather than export an internal helper, this small wrapper
// lives here. Keeps the store package's public surface narrow.
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

// ensureDeviceForTesting upserts a minimal device row tied to alice (the
// fixture sender). PHASE 05 ONLY -- phase 11 ties device_id to a session.
//
// We attach to alice arbitrarily; phase 05 doesn't care about user identity
// for the relay test. Real phases use the session's actual user.
func ensureDeviceForTesting(ctx context.Context, st *store.Store, deviceID uuid.UUID) error {
	aliceID := uuid.MustParse("00000000-0000-0000-0000-00000000a11c")
	_, err := st.Pool.Exec(ctx,
		`INSERT INTO devices (id, user_id, device_type, device_label)
		 VALUES ($1, $2, 'browser-unknown', 'phase-05-test')
		 ON CONFLICT (id) DO NOTHING`,
		deviceID, aliceID,
	)
	return err
}

// writeLoop drains conn.Send onto the WebSocket.
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
	frame, _ := proto.NewFrame(proto.TypeError, ref, proto.ErrorPayload{Code: code, Message: msg})
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
