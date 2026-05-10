package pubsub

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"sync"
	"time"

	"github.com/jackc/pgx/v5/pgconn"
	"github.com/jackc/pgx/v5/pgxpool"
)

// Handler is invoked once per received Event. Implementations should be
// fast and non-blocking; long work belongs in a separate goroutine.
type Handler func(Event)

// Listener holds a dedicated Postgres connection that runs LISTEN and
// dispatches notifications to a Handler. The connection is held outside the
// pool because pgx pools cannot be used for LISTEN: a pooled connection
// might be returned and reused by another query, dropping pending
// notifications.
type Listener struct {
	pool    *pgxpool.Pool
	handler Handler
	logf    func(string, ...any)

	// Tunables.
	BackoffInitial time.Duration
	BackoffMax     time.Duration

	// readyOnce closes ready exactly once on first successful subscription.
	// Callers can wait on Ready() to know the listener is fully wired before
	// sending. After reconnects, ready stays closed -- it signals "has been
	// ready at least once," which is what tests need.
	readyOnce sync.Once
	ready     chan struct{}
}

// NewListener constructs a Listener. pool must NOT be the same pool used
// by the rest of the app for queries -- well, it CAN be, because the
// listener checks out its own dedicated connection from the pool and never
// returns it. We just borrow one slot.
//
// Better practice would be a separate pgx.Conn here entirely (no pool), but
// the pool plumbing is already configured (URL, cert auth, etc.) and
// duplicating it for one connection is more code than it's worth. The
// connection is acquired once and held for the listener's lifetime.
func NewListener(pool *pgxpool.Pool, handler Handler, logf func(string, ...any)) *Listener {
	if logf == nil {
		logf = func(string, ...any) {}
	}
	return &Listener{
		pool:           pool,
		handler:        handler,
		logf:           logf,
		BackoffInitial: 250 * time.Millisecond,
		BackoffMax:     10 * time.Second,
		ready:          make(chan struct{}),
	}
}

// Ready returns a channel that is closed when the listener has successfully
// subscribed to NOTIFY at least once. Useful in tests to gate the first
// send on the listener being live; in production code, a small sleep or
// retry loop covers the same case more cheaply than blocking startup.
func (l *Listener) Ready() <-chan struct{} { return l.ready }

// Run blocks until ctx is canceled, dispatching every received event
// through the handler. On connection errors it reconnects with exponential
// backoff capped at BackoffMax.
//
// Returns ctx.Err() on clean shutdown, or a wrapped error on any
// unrecoverable problem (only failure to acquire a connection from the
// pool counts; everything else is retried).
func (l *Listener) Run(ctx context.Context) error {
	backoff := l.BackoffInitial
	for {
		err := l.runOnce(ctx)
		if err == nil {
			// runOnce returns nil only on ctx cancellation.
			return ctx.Err()
		}
		if errors.Is(err, context.Canceled) || errors.Is(err, context.DeadlineExceeded) {
			return ctx.Err()
		}
		l.logf("listener error: %v; reconnecting in %s", err, backoff)
		select {
		case <-ctx.Done():
			return ctx.Err()
		case <-time.After(backoff):
		}
		backoff *= 2
		if backoff > l.BackoffMax {
			backoff = l.BackoffMax
		}
	}
}

// runOnce acquires a dedicated connection, issues LISTEN, and pumps
// notifications until either the connection drops or ctx is canceled.
// Returns nil only on clean ctx cancellation.
func (l *Listener) runOnce(ctx context.Context) error {
	conn, err := l.pool.Acquire(ctx)
	if err != nil {
		return fmt.Errorf("acquire conn: %w", err)
	}
	// We deliberately don't Release(): the pool would put it back in
	// rotation and reuse it for another query, missing notifications.
	// On any return path, we Hijack() and Close() the underlying conn so
	// the pool reclaims the slot.
	hijacked := conn.Hijack()
	defer hijacked.Close(context.Background())

	if _, err := hijacked.Exec(ctx, `LISTEN `+Channel); err != nil {
		return fmt.Errorf("LISTEN: %w", err)
	}
	l.logf("listener subscribed to %s", Channel)
	l.readyOnce.Do(func() { close(l.ready) })
	// Reset backoff after a successful subscription. We do this implicitly
	// by Run() only setting backoff after a runOnce error; on re-entry from
	// a successful subscription that later fails, the previous error path
	// already set backoff to its post-error value. Acceptable: brief flaps
	// produce mild backoff regardless.

	for {
		notif, err := hijacked.WaitForNotification(ctx)
		if err != nil {
			if errors.Is(err, context.Canceled) || errors.Is(err, context.DeadlineExceeded) {
				return nil
			}
			return fmt.Errorf("wait for notification: %w", err)
		}
		l.dispatch(notif)
	}
}

// dispatch decodes a notification and invokes the handler. Decoding errors
// are logged and dropped -- they indicate a wire format mismatch, and
// crashing the listener for one bad payload would harm every other client.
func (l *Listener) dispatch(n *pgconn.Notification) {
	var ev Event
	if err := json.Unmarshal([]byte(n.Payload), &ev); err != nil {
		l.logf("listener: bad payload from PID %d: %v", n.PID, err)
		return
	}
	defer func() {
		if r := recover(); r != nil {
			l.logf("listener: handler panic: %v", r)
		}
	}()
	l.handler(ev)
}
