package presence

import (
	"context"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"

	"github.com/scuq/chalk/internal/pubsub"
)

// LoopConfig tunes the background goroutines. Defaults are chosen for
// production; tests typically shrink them.
type LoopConfig struct {
	// HeartbeatInterval is how often each chalkd instance bumps its
	// own instances.last_heartbeat. Defaults to 5s.
	HeartbeatInterval time.Duration
	// JanitorInterval is how often the dead-instance sweep runs.
	// Defaults to 10s.
	JanitorInterval time.Duration
	// InstanceStaleness is the threshold past which an instance is
	// declared dead. Should be at least 2 * HeartbeatInterval to absorb
	// transient slowness. Defaults to 15s.
	InstanceStaleness time.Duration
	// DemotionInterval is how often the state-demotion sweep runs.
	// Defaults to 5s.
	DemotionInterval time.Duration
}

// DefaultLoopConfig returns production defaults.
func DefaultLoopConfig() LoopConfig {
	return LoopConfig{
		HeartbeatInterval: 5 * time.Second,
		JanitorInterval:   10 * time.Second,
		InstanceStaleness: 15 * time.Second,
		DemotionInterval:  5 * time.Second,
	}
}

// Logger is the minimal subset of log.Logger we need; lets callers pass
// any logger that supports Printf.
type Logger interface {
	Printf(format string, v ...any)
}

// noopLogger is used if the caller doesn't pass one.
type noopLogger struct{}

func (noopLogger) Printf(string, ...any) {}

// PresenceChange describes a per-user aggregated state change.
// Loops publish these via the supplied Notifier so other instances can
// push updates to subscribed clients.
type PresenceChange struct {
	UserID uuid.UUID
}

// Notifier is the function the loops call to broadcast a per-user
// presence change. The server layer implements this by emitting a
// pubsub.Event with Kind="presence" inside a fresh transaction.
type Notifier func(ctx context.Context, userID uuid.UUID) error

// HeartbeatLoop runs Heartbeat on a ticker until ctx is canceled.
// Errors are logged but don't break the loop. If the instance row
// goes missing (we were declared dead and reaped), we re-register
// rather than giving up: the alternative is to crash, which loses
// all currently-connected clients.
func HeartbeatLoop(
	ctx context.Context,
	st *Store,
	instanceID, host, version string,
	cfg LoopConfig,
	logger Logger,
) {
	if logger == nil {
		logger = noopLogger{}
	}
	if cfg.HeartbeatInterval <= 0 {
		cfg.HeartbeatInterval = 5 * time.Second
	}
	t := time.NewTicker(cfg.HeartbeatInterval)
	defer t.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-t.C:
			if err := st.Heartbeat(ctx, instanceID); err != nil {
				logger.Printf("heartbeat: %v; re-registering", err)
				if err := st.RegisterInstance(ctx, instanceID, host, version); err != nil {
					logger.Printf("re-register: %v", err)
				}
			}
		}
	}
}

// JanitorLoop sweeps dead instances on a ticker. For each affected user,
// the supplied notifier is invoked to publish a presence transition.
//
// The janitor races with normal instance heartbeats: it deletes instances
// older than InstanceStaleness. If two janitor instances race to delete
// the same row, the second sees zero rows affected and continues; if a
// healthy instance's heartbeat lands a microsecond after our SELECT but
// before our DELETE, we'd incorrectly delete a live instance. The
// cascade DELETE causes its devices to appear offline; the instance's
// next Heartbeat() detects the missing row and re-registers, but the
// clients have meanwhile flickered. To avoid that, the staleness window
// of 15s is comfortably larger than the 5s heartbeat cadence.
func JanitorLoop(
	ctx context.Context,
	st *Store,
	cfg LoopConfig,
	notify Notifier,
	logger Logger,
) {
	if logger == nil {
		logger = noopLogger{}
	}
	if cfg.JanitorInterval <= 0 {
		cfg.JanitorInterval = 10 * time.Second
	}
	if cfg.InstanceStaleness <= 0 {
		cfg.InstanceStaleness = 15 * time.Second
	}
	t := time.NewTicker(cfg.JanitorInterval)
	defer t.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-t.C:
			users, err := st.DeleteDeadInstances(ctx, cfg.InstanceStaleness)
			if err != nil {
				logger.Printf("janitor sweep: %v", err)
				continue
			}
			if len(users) == 0 {
				continue
			}
			for _, u := range dedupUsers(users) {
				if err := notify(ctx, u); err != nil {
					logger.Printf("janitor notify %s: %v", u, err)
				}
			}
		}
	}
}

// DemotionLoop runs the staleness-based demotion sweep on a ticker.
// Per-user notifications are emitted for any user whose aggregated state
// might have changed.
func DemotionLoop(
	ctx context.Context,
	st *Store,
	cfg LoopConfig,
	notify Notifier,
	logger Logger,
) {
	if logger == nil {
		logger = noopLogger{}
	}
	if cfg.DemotionInterval <= 0 {
		cfg.DemotionInterval = 5 * time.Second
	}
	t := time.NewTicker(cfg.DemotionInterval)
	defer t.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-t.C:
			results, err := st.Demote(ctx)
			if err != nil {
				logger.Printf("demotion sweep: %v", err)
				continue
			}
			if len(results) == 0 {
				continue
			}
			users := make([]uuid.UUID, 0, len(results))
			for _, r := range results {
				users = append(users, r.UserID)
			}
			for _, u := range dedupUsers(users) {
				if err := notify(ctx, u); err != nil {
					logger.Printf("demotion notify %s: %v", u, err)
				}
			}
		}
	}
}

// PublishPresenceChange is the production Notifier. It opens a fresh
// transaction and emits a Kind="presence" NOTIFY carrying the user_id
// whose aggregated state may have changed.
//
// Listeners across all instances receive the NOTIFY and route it to a
// handlePresenceEvent function in the server layer, which fetches the
// new aggregated state and pushes updates to any locally-connected
// subscribers.
//
// The pool argument is a minimal interface so this file doesn't depend
// on pgxpool directly; in practice, callers pass their *pgxpool.Pool.
func PublishPresenceChange(pool interface {
	BeginTx(ctx context.Context, opts pgx.TxOptions) (pgx.Tx, error)
}, instanceID string) Notifier {
	return func(ctx context.Context, userID uuid.UUID) error {
		tx, err := pool.BeginTx(ctx, pgx.TxOptions{})
		if err != nil {
			return err
		}
		defer func() { _ = tx.Rollback(ctx) }()
		if err := pubsub.PublishWithTx(ctx, tx, pubsub.Event{
			Kind:       "presence",
			UserID:     userID,
			InstanceID: instanceID,
		}); err != nil {
			return err
		}
		return tx.Commit(ctx)
	}
}

// dedupUsers returns a slice with duplicate UUIDs removed, preserving
// first-occurrence order.
func dedupUsers(in []uuid.UUID) []uuid.UUID {
	seen := make(map[uuid.UUID]struct{}, len(in))
	out := make([]uuid.UUID, 0, len(in))
	for _, u := range in {
		if _, ok := seen[u]; ok {
			continue
		}
		seen[u] = struct{}{}
		out = append(out, u)
	}
	return out
}
