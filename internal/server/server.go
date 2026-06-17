package server

import (
	"context"
	"encoding/json"
	"fmt"
	"io/fs"
	"log"
	"net"
	"net/http"
	"os"
	"sync"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"

	"github.com/scuq/chalk/internal/auth"
	"github.com/scuq/chalk/internal/friends"
	"github.com/scuq/chalk/internal/presence"
	"github.com/scuq/chalk/internal/proto"
	"github.com/scuq/chalk/internal/pubsub"
	"github.com/scuq/chalk/internal/store"
)

// Options bundles dependencies and tunables.
type Options struct {
	Listen     string
	Store      *store.Store
	Hub        *Hub
	WSConfig   WSConfig
	InstanceID string
	Logger     *log.Logger

	// Phase 06 dependencies. If nil, the server starts but the
	// corresponding features are disabled. Production callers always
	// pass both.
	Presence *presence.Store
	Friends  *friends.Store

	// PresenceLoopConfig overrides DefaultLoopConfig if non-nil; tests
	// shrink these for faster sweeps.
	PresenceLoopConfig *presence.LoopConfig

	// Phase 07: SPA hosting. If WebFS is non-nil, the server mounts
	// the SPA at "/" by serving WebFS rooted at WebDir (typically
	// "web", with dist/ inside). If WebFS is nil, "/" is unhandled
	// (404). Tests for the WS layer pass nil; the chalkd entry point
	// passes the embedded chalk.Web from the module root.
	WebFS  fs.FS
	WebDir string

	// Phase 09b sub-step 3: registration HTTP routes.
	//
	// If non-nil, the server mounts /api/auth/register/begin,
	// /api/auth/register/finish, and /api/auth/config. The caller is
	// responsible for constructing the auth.Service, the ceremony
	// cache, and starting the cache's janitor goroutine (typically
	// the chalkd entry point binds the cache to its lifecycle ctx).
	//
	// If nil, no auth routes are mounted; the existing WS handler
	// still runs with its pre-09b ensureDeviceForTesting path. Sub-
	// step 09b-5 cuts the WS over to session-based auth.
	Auth *auth.HTTPDeps
}

// Server wraps the http.Server, hub, pubsub listener, presence/friends
// background goroutines, and lifecycle plumbing.
type Server struct {
	http       *http.Server
	listener   net.Listener
	hub        *Hub
	store      *store.Store
	logger     *log.Logger
	instanceID string

	pubsub *pubsub.Listener

	presence *presence.Store
	friends  *friends.Store
	loopCfg  presence.LoopConfig

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
	loopCfg := presence.DefaultLoopConfig()
	if opts.PresenceLoopConfig != nil {
		loopCfg = *opts.PresenceLoopConfig
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
		presence:   opts.Presence,
		friends:    opts.Friends,
		loopCfg:    loopCfg,
		served:     make(chan struct{}),
	}

	if opts.Store != nil {
		s.pubsub = pubsub.NewListener(opts.Store.Pool, s.handlePubsubEvent, opts.Logger.Printf)
	}

	var pubPresence presence.Notifier
	var pubFriend FriendPublisher
	if opts.Presence != nil && opts.Store != nil {
		pubPresence = presence.PublishPresenceChange(opts.Store.Pool, s.instanceID)
		pubFriend = s.publishFriendEvent
	}

	mux := http.NewServeMux()
	mux.HandleFunc("GET /healthz", s.healthz)
	mux.Handle("GET /ws", NewWSHandler(
		s.hub, s.store, opts.WSConfig, s.instanceID, s.logger,
		opts.Presence, opts.Friends,
		pubPresence, pubFriend,
		s.publishPrefsChangeFn, // Phase 9.7a
		s.pubsub,               // phase 08: listener for per-channel subscribe
	))

	// Phase 09b sub-step 3: registration endpoints. Mounted before
	// the SPA's "/" catch-all (http.ServeMux's longest-prefix-wins
	// routing puts /api/auth/* ahead of /, but being explicit makes
	// future reordering safer).
	if opts.Auth != nil {
		if err := opts.Auth.MountRegistration(mux); err != nil {
			return nil, fmt.Errorf("mount auth: %w", err)
		}
		// Phase 09d-1: admin moderation + unauthenticated admin
		// bootstrap endpoints. Mounted unconditionally when Auth is
		// set; RequireAdmin protects moderation, the bootstrap
		// token protects the bootstrap endpoints.
		if err := opts.Auth.MountAdmin(mux); err != nil {
			return nil, fmt.Errorf("mount admin: %w", err)
		}
		if err := opts.Auth.MountAdminBootstrap(mux); err != nil {
			return nil, fmt.Errorf("mount admin bootstrap: %w", err)
		}
		// Phase 9.6a: exact-username lookup for the friend-add UI.
		if err := opts.Auth.MountUserLookup(mux); err != nil {
			return nil, fmt.Errorf("mount user lookup: %w", err)
		}
	}

	// Phase 07: mount the SPA at "/". A WebFS provided via Options is
	// mounted; if it's nil (some tests pass nil because they don't care
	// about HTML), "/" stays unhandled and returns 404. The dist/
	// subdirectory inside webFS is the esbuild output the SPA handler
	// serves at the URL root.
	if opts.WebFS != nil {
		webDir := opts.WebDir
		if webDir == "" {
			webDir = "web"
		}
		spaH, err := spaHandler(opts.WebFS, webDir+"/dist")
		if err != nil {
			return nil, fmt.Errorf("spa handler: %w", err)
		}
		mux.Handle("GET /", spaH)
	}

	s.http = &http.Server{
		Handler:           mux,
		ReadHeaderTimeout: 5 * time.Second,
	}
	return s, nil
}

// Addr returns the bound address.
func (s *Server) Addr() net.Addr { return s.listener.Addr() }

// PubsubReady returns a channel closed when the cross-instance listener
// has subscribed to NOTIFY at least once.
func (s *Server) PubsubReady() <-chan struct{} {
	if s.pubsub == nil {
		ch := make(chan struct{})
		close(ch)
		return ch
	}
	return s.pubsub.Ready()
}

// Serve runs all background goroutines + HTTP. Returns http.ErrServerClosed
// on clean shutdown.
func (s *Server) Serve(ctx context.Context) error {
	s.logger.Printf("listening on %s (instance=%s)", s.listener.Addr(), s.instanceID)

	bgCtx, cancelBG := context.WithCancel(ctx)
	var wg sync.WaitGroup

	// Pubsub listener.
	if s.pubsub != nil {
		wg.Add(1)
		go func() {
			defer wg.Done()
			if err := s.pubsub.Run(bgCtx); err != nil && err != context.Canceled {
				s.logger.Printf("pubsub listener exited: %v", err)
			}
		}()
	}

	// Partition maintenance.
	if s.store != nil {
		wg.Add(1)
		go func() {
			defer wg.Done()
			s.store.PartitionMaintenanceLoop(bgCtx, 24*time.Hour, s.logger.Printf)
		}()
	}

	// Phase 06 background loops.
	if s.presence != nil && s.store != nil {
		// Register self in instances table; clear any stale presence
		// belonging to our instance_id (from a prior unclean shutdown).
		regCtx, cancel := context.WithTimeout(ctx, 5*time.Second)
		host, _ := os.Hostname()
		if err := s.presence.RegisterInstance(regCtx, s.instanceID, host, "phase06"); err != nil {
			cancel()
			cancelBG()
			return fmt.Errorf("register instance: %w", err)
		}
		users, err := s.presence.ClearInstancePresence(regCtx, s.instanceID)
		cancel()
		if err != nil {
			cancelBG()
			return fmt.Errorf("clear stale presence: %w", err)
		}
		if len(users) > 0 {
			s.logger.Printf("cleared %d stale presence rows on startup", len(users))
			// Publish transitions for users whose stale rows we cleared.
			notifier := presence.PublishPresenceChange(s.store.Pool, s.instanceID)
			for _, u := range users {
				if err := notifier(bgCtx, u); err != nil {
					s.logger.Printf("publish stale-clear: %v", err)
				}
			}
		}

		notifier := presence.PublishPresenceChange(s.store.Pool, s.instanceID)
		wg.Add(3)
		go func() {
			defer wg.Done()
			presence.HeartbeatLoop(bgCtx, s.presence, s.instanceID, host, "phase06",
				s.loopCfg, s.logger)
		}()
		go func() {
			defer wg.Done()
			presence.JanitorLoop(bgCtx, s.presence, s.loopCfg, notifier, s.logger)
		}()
		go func() {
			defer wg.Done()
			presence.DemotionLoop(bgCtx, s.presence, s.loopCfg, notifier, s.logger)
		}()
	}

	// HTTP shutdown watcher.
	shutDone := make(chan struct{})
	go func() {
		<-ctx.Done()
		ctxShutdown, cancel := context.WithTimeout(context.Background(), 20*time.Second)
		defer cancel()
		// Clean shutdown: clear our own presence rows so other
		// instances see our devices go offline immediately rather
		// than waiting for the janitor.
		if s.presence != nil {
			if users, err := s.presence.ClearInstancePresence(ctxShutdown, s.instanceID); err == nil {
				notifier := presence.PublishPresenceChange(s.store.Pool, s.instanceID)
				for _, u := range users {
					_ = notifier(ctxShutdown, u)
				}
				// Remove our instance row too.
				_, _ = s.store.Pool.Exec(ctxShutdown,
					`DELETE FROM instances WHERE id = $1`, s.instanceID)
			}
		}
		s.hub.CloseAll(ctxShutdown, nil)
		_ = s.http.Shutdown(ctxShutdown)
		cancelBG()
		close(shutDone)
	}()

	err := s.http.Serve(s.listener)
	<-shutDone
	wg.Wait()
	s.serveOnce.Do(func() { close(s.served) })
	return err
}

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

// handlePubsubEvent dispatches by Kind. Phase 05 had only "message";
// phase 06 added "presence" and "friend"; phase 08 adds "channel".
func (s *Server) handlePubsubEvent(ev pubsub.Event) {
	switch ev.Kind {
	case "message":
		s.handleMessageEvent(ev)
	case "presence":
		s.handlePresenceEvent(ev)
	case "friend":
		s.handleFriendEvent(ev)
	case "channel":
		s.handleChannelEvent(ev)
	case "prefs":
		// Phase 9.7a:
		s.handlePrefsEvent(ev)
	}
}

// handleMessageEvent: fetch the row, build the frame, fan out
// (skip sender's conn + skip conns registered after msg.TS).
//
// Phase 08: MessagePayload now carries ChannelID and Seq so clients
// can route the incoming message to the correct channel pane. Phase
// 08 also routes recipients by channel membership: only members of
// the message's channel receive the frame.
//
// Phase 09a step 3: echo-suppression now uses the sender's connID
// (Event.SenderConnID) instead of deviceID, so multiple tabs of the
// same browser correctly receive each other's sends.
func (s *Server) handleMessageEvent(ev pubsub.Event) {
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

	senderStr := ""
	if msg.SenderDeviceID != uuid.Nil {
		senderStr = msg.SenderDeviceID.String()
	}
	// Phase 9.6i: populate sender_user_id from the store-supplied
	// SenderUserID (resolved via JOIN on devices in GetMessage).
	senderUserStr := ""
	if msg.SenderUserID != uuid.Nil {
		senderUserStr = msg.SenderUserID.String()
	}
	// Phase 10a: threading metadata. GetMessage already returns
	// parent_id + thread_id; reply_count for the push path is left
	// at 0 (this is the row that's being pushed, not the head). For
	// reply pushes, the receiver re-renders the thread panel which
	// will derive its own counts.
	parentStr := ""
	if msg.ParentID != nil {
		parentStr = msg.ParentID.String()
	}
	threadStr := ""
	if msg.ThreadID != nil {
		threadStr = msg.ThreadID.String()
	}
	pushBody := string(msg.Ciphertext)
	frame, err := proto.NewFrame(proto.TypeMessage, "", proto.MessagePayload{
		ID:           msg.ID.String(),
		ChannelID:    msg.ChannelID.String(),
		Seq:          msg.Seq,
		Sender:       senderStr,
		SenderUserID: senderUserStr,
		TS:           msg.TS.UnixMilli(),
		Body:         pushBody,
		ParentID:     parentStr,
		ThreadID:     threadStr,
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

	// Phase 08: membership filter. The default channel is special-
	// cased: broadcast to everyone (phase 07 fallback). Real channels
	// only fan out to members.
	//
	// Phase 09a step 3: echo-suppression keys on the sender's connID
	// (Event.SenderConnID) rather than deviceID. This is what lets
	// step 4 remove the duplicate-tab eviction: two tabs from the
	// same browser share a deviceID but have distinct connIDs, so
	// each tab can correctly receive others' sends without seeing
	// their own.
	if msg.ChannelID == store.DefaultChannelID {
		s.hub.FanOutFresh(ev.SenderConnID, wire, msg.TS)
		return
	}
	s.broadcastToChannelMembers(ctx, msg.ChannelID, ev.SenderConnID, wire, msg.TS)
}

// broadcastToChannelMembers sends wire to every locally-connected
// device whose UserID is in the channel's member set, skipping the
// sender connection. Stale (registered after msg.TS) connections
// are skipped via FanOutFresh-equivalent logic.
//
// Phase 09a step 3: senderConnID replaces senderDevice. Suppression
// is per-conn now, not per-device, so multiple tabs of the same
// browser still receive each others' sends (once step 4 removes the
// same-deviceID eviction; until then it's a no-op difference because
// only one conn per deviceID exists at a time).
//
// Fan-out is per-user via the Hub's byUser index, eliminating the
// previous O(total_conns * members) scan.
func (s *Server) broadcastToChannelMembers(
	ctx context.Context,
	channelID uuid.UUID,
	senderConnID string,
	wire []byte,
	ts time.Time,
) {
	if s.store == nil {
		return
	}
	// Members of the channel.
	rows, err := s.store.Pool.Query(ctx,
		`SELECT user_id FROM channel_members WHERE channel_id = $1`,
		channelID,
	)
	if err != nil {
		s.logger.Printf("broadcast members query: %v", err)
		return
	}
	defer rows.Close()
	members := make([]uuid.UUID, 0, 8)
	for rows.Next() {
		var u uuid.UUID
		if err := rows.Scan(&u); err != nil {
			s.logger.Printf("broadcast scan: %v", err)
			return
		}
		members = append(members, u)
	}

	for _, m := range members {
		s.hub.FanOutToUserFresh(m.String(), senderConnID, wire, ts)
	}
}

// handleChannelEvent: push a channel_event frame to every locally-
// connected device whose user_id is ev.UserID. The event was published
// on chalk_global by handleCreateChannel (or future add_member,
// remove_member, etc.) on whichever chalkd instance handled the
// originating frame.
func (s *Server) handleChannelEvent(ev pubsub.Event) {
	if ev.UserID == uuid.Nil {
		return
	}
	var summary proto.ChannelSummary
	if len(ev.ChannelEventPayload) > 0 {
		if err := json.Unmarshal(ev.ChannelEventPayload, &summary); err != nil {
			s.logger.Printf("channel event decode: %v", err)
			return
		}
	}
	frame, err := proto.NewFrame(proto.TypeChannelEvent, "", proto.ChannelEventPayload{
		Kind:    ev.FriendKind, // overloaded: added/removed
		Channel: summary,
	})
	if err != nil {
		s.logger.Printf("channel event frame: %v", err)
		return
	}
	wire, err := json.Marshal(frame)
	if err != nil {
		s.logger.Printf("channel event marshal: %v", err)
		return
	}

	// Phase 09a step 3: per-user fan-out via the byUser index
	// instead of scanning every conn. No echo-suppression here:
	// channel events go to ALL of the recipient's conns (including
	// the one that may have triggered the channel change), because
	// the originating frame's ack is sent separately and clients
	// dedupe by event identity.
	s.hub.FanOutToUser(ev.UserID.String(), "", wire)
}

// handlePresenceEvent: re-aggregate the user's state, find local
// subscribers, push a presence frame to each.
//
// Re-checking friendship on every push (rather than at subscribe time
// only) means an un-friend during an active subscription is honored
// immediately: the next presence change won't reach the now-ex-friend.
func (s *Server) handlePresenceEvent(ev pubsub.Event) {
	if s.presence == nil || s.friends == nil {
		return
	}
	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
	defer cancel()

	state, at, err := s.presence.AggregateUserState(ctx, ev.UserID)
	if err != nil {
		s.logger.Printf("presence aggregate %s: %v", ev.UserID, err)
		return
	}

	subscriberDevices, err := s.presence.SubscribersOfUser(ctx, ev.UserID, s.instanceID)
	if err != nil {
		s.logger.Printf("presence subscribers %s: %v", ev.UserID, err)
		return
	}
	if len(subscriberDevices) == 0 {
		return
	}

	frame, err := proto.NewFrame(proto.TypePresence, "", proto.PresencePayload{
		UserID: ev.UserID.String(),
		State:  string(state),
		At:     at.UnixMilli(),
	})
	if err != nil {
		return
	}
	wire, _ := json.Marshal(frame)

	// Phase 09a step 4: dedupe subscriber devices to distinct
	// user_ids, friendship-check once per user, FanOutToUser per
	// user. This both (a) supports multi-tab correctly (every tab
	// of a subscribing user receives the update, not just the one
	// returned by the legacy per-device Hub.Get) and (b) eliminates
	// N device->user lookups when one user has multiple devices
	// subscribed.
	subUserIDs := make(map[uuid.UUID]struct{}, len(subscriberDevices))
	for _, subDev := range subscriberDevices {
		var subUser uuid.UUID
		if err := s.store.Pool.QueryRow(ctx,
			`SELECT user_id FROM devices WHERE id = $1`, subDev,
		).Scan(&subUser); err != nil {
			continue
		}
		subUserIDs[subUser] = struct{}{}
	}

	for subUser := range subUserIDs {
		// Re-check friendship -- subscriber might have un-friended us
		// since they subscribed.
		ok, err := s.friends.AreAcceptedFriends(ctx, subUser, ev.UserID)
		if err != nil || !ok {
			continue
		}
		s.hub.FanOutToUser(subUser.String(), "", wire)
	}
}

// handleFriendEvent: push a friend_event frame to every connected
// conn of the recipient user.
//
// Look up the requester's handle to include in the push so the client
// doesn't have to do another round trip to render the notification.
//
// Phase 09a step 4: fans out via Hub.FanOutToUser, which iterates the
// byUser index. The DB query for device_presence that the old version
// did is gone: byUser already knows which conns are live on this
// instance, with no DB roundtrip needed. If the recipient has no
// conns on this instance, FanOutToUser is a no-op.
func (s *Server) handleFriendEvent(ev pubsub.Event) {
	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
	defer cancel()

	// Skip the work entirely if the recipient has no local conns.
	// This is cheap to check and avoids a database lookup for users
	// who aren't connected here.
	if len(s.hub.ConnsForUser(ev.UserID.String())) == 0 {
		return
	}

	var handle string
	if err := s.store.Pool.QueryRow(ctx,
		`SELECT handle FROM users WHERE id = $1`, ev.FromUserID,
	).Scan(&handle); err != nil {
		// User might have been deleted between request and push;
		// still send the event with an empty handle.
		handle = ""
	}

	frame, _ := proto.NewFrame(proto.TypeFriendEvent, "", proto.FriendEventPayload{
		Kind:       ev.FriendKind,
		FromUserID: ev.FromUserID.String(),
		Handle:     handle,
	})
	wire, _ := json.Marshal(frame)

	s.hub.FanOutToUser(ev.UserID.String(), "", wire)
}

// publishFriendEvent is the implementation of FriendPublisher. Opens a
// fresh tx and emits a Kind="friend" NOTIFY.
func (s *Server) publishFriendEvent(ctx context.Context, recipient, fromUser uuid.UUID, kind string) error {
	if s.store == nil {
		return nil
	}
	tx, err := s.store.Pool.BeginTx(ctx, pgx.TxOptions{})
	if err != nil {
		return err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	if err := pubsub.PublishWithTx(ctx, tx, pubsub.Event{
		Kind:       "friend",
		UserID:     recipient,
		FromUserID: fromUser,
		FriendKind: kind,
		InstanceID: s.instanceID,
	}); err != nil {
		return err
	}
	return tx.Commit(ctx)
}

// publishPrefsChangeFn (Phase 9.7a) emits a Kind="prefs" NOTIFY that
// fans out to the same user's local conns on every chalkd instance.
// The originating conn ID is carried so receivers can skip self-echo.
func (s *Server) publishPrefsChangeFn(ctx context.Context, userID uuid.UUID, originConnID string) error {
	if s.store == nil {
		return nil
	}
	tx, err := s.store.Pool.BeginTx(ctx, pgx.TxOptions{})
	if err != nil {
		return err
	}
	defer tx.Rollback(ctx)
	if err := pubsub.PublishWithTx(ctx, tx, pubsub.Event{
		Kind:         "prefs",
		UserID:       userID,
		SenderConnID: originConnID,
		InstanceID:   s.instanceID,
	}); err != nil {
		return err
	}
	return tx.Commit(ctx)
}

// handlePrefsEvent (Phase 9.7a) re-fetches the user's prefs and
// pushes prefs_changed to their local conns, skipping the originator.
func (s *Server) handlePrefsEvent(ev pubsub.Event) {
	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
	defer cancel()

	// Skip if no local conns for this user.
	if len(s.hub.ConnsForUser(ev.UserID.String())) == 0 {
		return
	}

	prefs, err := s.store.GetPreferences(ctx, ev.UserID)
	if err != nil {
		s.logger.Printf("prefs event fetch: %v", err)
		return
	}
	frame, _ := proto.NewFrame(proto.TypePrefsChanged, "", proto.PrefsAckPayload{
		Prefs: prefs,
	})
	wire, _ := json.Marshal(frame)

	// FanOutToUser with skip-conn-ID so the device that triggered the
	// change doesn't receive its own echo (it already got prefs_set_ack).
	s.hub.FanOutToUser(ev.UserID.String(), ev.SenderConnID, wire)
}
