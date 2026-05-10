package server

import (
	"context"
	"encoding/json"
	"fmt"
	"log"
	"net"
	"net/http"
	"sync"
	"time"

	"github.com/scuq/chalk/internal/proto"
	"github.com/scuq/chalk/internal/pubsub"
	"github.com/scuq/chalk/internal/store"
)

// Options bundles dependencies and tunables for NewServer.
type Options struct {
	Listen     string
	Store      *store.Store
	Hub        *Hub
	WSConfig   WSConfig
	InstanceID string
	Logger     *log.Logger
}

// Server wraps an http.Server, its bound listener, the local hub, and the
// pubsub listener that bridges to other chalkd instances.
type Server struct {
	http       *http.Server
	listener   net.Listener
	hub        *Hub
	store      *store.Store
	logger     *log.Logger
	instanceID string

	pubsub *pubsub.Listener

	served    chan struct{}
	serveOnce sync.Once
}

// NewServer constructs and binds (but does not yet serve) a Server.
func NewServer(opts Options) (*Server, error) {
	if opts.Hub == nil {
		opts.Hub = NewHub()
	}
	if opts.Logger == nil {
		opts.Logger = log.Default()
	}
	if opts.Listen == "" {
		opts.Listen = ":0"
	}
	if opts.InstanceID == "" {
		opts.InstanceID = "default"
	}

	ln, err := net.Listen("tcp", opts.Listen)
	if err != nil {
		return nil, fmt.Errorf("listen %s: %w", opts.Listen, err)
	}

	s := &Server{
		hub:        opts.Hub,
		store:      opts.Store,
		listener:   ln,
		logger:     opts.Logger,
		instanceID: opts.InstanceID,
		served:     make(chan struct{}),
	}

	if opts.Store != nil {
		s.pubsub = pubsub.NewListener(opts.Store.Pool, s.handlePubsubEvent, opts.Logger.Printf)
	}

	mux := http.NewServeMux()
	mux.HandleFunc("GET /healthz", s.healthz)
	mux.Handle("GET /ws", NewWSHandler(s.hub, s.store, opts.WSConfig, s.instanceID, s.logger))

	s.http = &http.Server{
		Handler:           mux,
		ReadHeaderTimeout: 5 * time.Second,
	}
	return s, nil
}

// Addr returns the listener's bound address.
func (s *Server) Addr() net.Addr {
	return s.listener.Addr()
}

// PubsubReady returns a channel closed when the cross-instance listener
// has subscribed to NOTIFY at least once. Returns an already-closed channel
// if the server has no store (no pubsub).
//
// Useful in tests to avoid races between sending and the listener being
// live. Production code rarely needs to wait on this.
func (s *Server) PubsubReady() <-chan struct{} {
	if s.pubsub == nil {
		ch := make(chan struct{})
		close(ch)
		return ch
	}
	return s.pubsub.Ready()
}

// Serve runs the HTTP server, the pubsub listener, and the partition
// maintenance loop until ctx is canceled. Returns http.ErrServerClosed on
// clean shutdown.
func (s *Server) Serve(ctx context.Context) error {
	s.logger.Printf("listening on %s (instance=%s)", s.listener.Addr(), s.instanceID)

	bgCtx, cancelBG := context.WithCancel(ctx)

	// Pubsub listener (cross-instance fan-out).
	var pubsubDone chan struct{}
	if s.pubsub != nil {
		pubsubDone = make(chan struct{})
		go func() {
			defer close(pubsubDone)
			if err := s.pubsub.Run(bgCtx); err != nil && err != context.Canceled {
				s.logger.Printf("pubsub listener exited: %v", err)
			}
		}()
	}

	// Partition maintenance loop. Once a day is plenty.
	var partsDone chan struct{}
	if s.store != nil {
		partsDone = make(chan struct{})
		go func() {
			defer close(partsDone)
			s.store.PartitionMaintenanceLoop(bgCtx, 24*time.Hour, s.logger.Printf)
		}()
	}

	// HTTP shutdown watcher.
	shutDone := make(chan struct{})
	go func() {
		<-ctx.Done()
		ctxShutdown, cancel := context.WithTimeout(context.Background(), 20*time.Second)
		defer cancel()
		s.hub.CloseAll(ctxShutdown, nil)
		_ = s.http.Shutdown(ctxShutdown)
		cancelBG()
		close(shutDone)
	}()

	err := s.http.Serve(s.listener)
	<-shutDone
	if pubsubDone != nil {
		<-pubsubDone
	}
	if partsDone != nil {
		<-partsDone
	}
	s.serveOnce.Do(func() { close(s.served) })
	return err
}

// healthz probes the database. Returns 200 only when both the HTTP server
// is up and Postgres is reachable.
func (s *Server) healthz(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Content-Type", "text/plain; charset=utf-8")
	w.Header().Set("Cache-Control", "no-store")
	if s.store != nil {
		ctx, cancel := context.WithTimeout(r.Context(), 2*time.Second)
		defer cancel()
		if err := s.store.Pool.Ping(ctx); err != nil {
			w.WriteHeader(http.StatusServiceUnavailable)
			_, _ = w.Write([]byte("db unreachable\n"))
			return
		}
	}
	w.WriteHeader(http.StatusOK)
	_, _ = w.Write([]byte("ok\n"))
}

// handlePubsubEvent is invoked by the pubsub listener for every event
// observed on the chalk_global channel (whether published locally or by
// another chalkd instance). For "message" events we fetch the row from the
// store and broadcast it to every locally-connected client except the
// originating sender.
//
// We use BroadcastFresh, not Broadcast, so connections registered AFTER
// the message's timestamp don't receive it via the live feed. This guards
// against a real race: listener processing can be slow (cold prepared
// statements, pool contention), during which time new connections can
// join the hub. Those new connections should not retroactively receive
// historical messages -- they should fetch history explicitly. Without
// this filter, the symptom is fresh tabs receiving messages from before
// they were opened.
//
// Self-events (published by this instance) are processed identically; the
// sender device_id is excluded either way.
//
// Errors are logged. Dropping a notification is preferable to crashing
// the listener: the message is still in PG, and a reconnecting client
// can fetch_history (phase 08) to recover.
func (s *Server) handlePubsubEvent(ev pubsub.Event) {
	if ev.Kind != "message" {
		return
	}
	if s.store == nil {
		return
	}
	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
	defer cancel()

	msg, err := s.store.GetMessage(ctx, ev.TS, ev.MessageID)
	if err != nil {
		s.logger.Printf("pubsub fetch %s: %v", ev.MessageID, err)
		return
	}

	frame, err := proto.NewFrame(proto.TypeMessage, "", proto.MessagePayload{
		ID:     msg.ID.String(),
		Sender: msg.SenderDeviceID.String(),
		TS:     msg.TS.UnixMilli(),
		Body:   string(msg.Ciphertext),
	})
	if err != nil {
		s.logger.Printf("pubsub frame: %v", err)
		return
	}
	wire, err := json.Marshal(frame)
	if err != nil {
		s.logger.Printf("pubsub marshal: %v", err)
		return
	}

	s.hub.BroadcastFresh(ev.SenderDeviceID.String(), wire, msg.TS)
}
