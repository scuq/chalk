// Package presence implements per-device presence with multi-device
// aggregation, instance heartbeats, dead-instance cleanup, and stale-
// state demotion.
//
// Design summary:
//
//   * Each WebSocket-connected device has a row in device_presence
//     tied to the chalkd instance that holds the connection.
//   * The chalkd instance heartbeats its own row in `instances` every
//     5 seconds.
//   * A janitor sweep runs every 10 seconds, looking for instances
//     whose last_heartbeat is older than 15 seconds. Those instances
//     are deleted, which cascades to their device_presence rows. The
//     janitor publishes a NOTIFY for each affected user so other
//     instances can push the presence transition to subscribers.
//   * A demotion sweep runs every 5 seconds, looking for online rows
//     whose last_seen is past the device-type-specific TTL. They get
//     demoted to away; rows past 2x TTL get demoted to offline.
//     NOTIFYs are published for transitions.
//   * Aggregation across a user's devices uses precedence
//     online > away > offline.
package presence

import (
	"context"
	"errors"
	"fmt"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
)

// State enumerates presence values stored in device_presence.state.
type State string

const (
	StateOnline  State = "online"
	StateAway    State = "away"
	StateOffline State = "offline"
)

// DeviceType enumerates the values stored in device_presence.device_type.
// Phase 06 distinguishes only these four; future expansion (e.g. "watch",
// "tv") adds new entries here and updates the CHECK constraint in
// migration 0008.
type DeviceType string

const (
	DevicePhone          DeviceType = "phone"
	DeviceTablet         DeviceType = "tablet"
	DeviceDesktop        DeviceType = "desktop"
	DeviceBrowserUnknown DeviceType = "browser-unknown"
)

// TTL returns the heartbeat-staleness threshold for a device type after
// which a still-claimed online state is demoted by the server. Per the
// phase-06 design: phone 90s, tablet 3min, desktop 10min. Unknown browser
// gets the safest (largest) TTL: it might be a desktop.
func (d DeviceType) TTL() time.Duration {
	switch d {
	case DevicePhone:
		return 90 * time.Second
	case DeviceTablet:
		return 3 * time.Minute
	case DeviceDesktop:
		return 10 * time.Minute
	}
	return 10 * time.Minute
}

// HeartbeatInterval is TTL/3, giving 2 misses of headroom before
// demotion.
func (d DeviceType) HeartbeatInterval() time.Duration {
	return d.TTL() / 3
}

// DevicePresence is one row of device_presence.
type DevicePresence struct {
	DeviceID    uuid.UUID
	UserID      uuid.UUID
	InstanceID  string
	DeviceType  DeviceType
	State       State
	LastSeen    time.Time
}

// Store wraps the presence-related queries.
type Store struct {
	Pool *pgxpool.Pool
}

// --- instance management ----------------------------------------------

// RegisterInstance writes the chalkd's own instance row, ensuring it
// exists. Idempotent: a re-registration updates host/version and bumps
// the heartbeat. Called once at chalkd startup.
func (s *Store) RegisterInstance(ctx context.Context, id, host, version string) error {
	_, err := s.Pool.Exec(ctx,
		`INSERT INTO instances (id, last_heartbeat, started_at, host, version)
		 VALUES ($1, now(), now(), $2, $3)
		 ON CONFLICT (id) DO UPDATE
		   SET last_heartbeat = now(),
		       started_at = EXCLUDED.started_at,
		       host = EXCLUDED.host,
		       version = EXCLUDED.version`,
		id, host, version,
	)
	return err
}

// Heartbeat bumps an instance's last_heartbeat to now(). Returns an
// error if the row was already removed (i.e., we were declared dead
// by another instance's janitor); the caller should re-register and
// continue.
func (s *Store) Heartbeat(ctx context.Context, id string) error {
	ct, err := s.Pool.Exec(ctx,
		`UPDATE instances SET last_heartbeat = now() WHERE id = $1`,
		id,
	)
	if err != nil {
		return err
	}
	if ct.RowsAffected() == 0 {
		return fmt.Errorf("instance row missing: %s", id)
	}
	return nil
}

// ClearInstancePresence deletes all device_presence rows belonging to a
// given instance. Used at startup (clear stale rows from unclean prior
// shutdown of the same instance ID) and at clean shutdown.
//
// Returns the list of user_ids whose presence may have transitioned, so
// the caller can publish NOTIFYs. The list may contain duplicates if a
// user has multiple devices on this instance; the caller should de-dup.
func (s *Store) ClearInstancePresence(ctx context.Context, instanceID string) ([]uuid.UUID, error) {
	rows, err := s.Pool.Query(ctx,
		`DELETE FROM device_presence WHERE instance_id = $1
		 RETURNING user_id`,
		instanceID,
	)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var users []uuid.UUID
	for rows.Next() {
		var u uuid.UUID
		if err := rows.Scan(&u); err != nil {
			return nil, err
		}
		users = append(users, u)
	}
	return users, rows.Err()
}

// DeleteDeadInstances removes instance rows whose last_heartbeat is older
// than `staleness` ago. Returns the list of user_ids whose presence may
// have changed because their device's instance was reaped. Caller dedups
// and publishes NOTIFYs.
func (s *Store) DeleteDeadInstances(ctx context.Context, staleness time.Duration) ([]uuid.UUID, error) {
	// Postgres can't easily express "delete instances and return
	// affected device_presence.user_ids" in one statement because the
	// cascade DELETE doesn't expose what was cascaded. Two steps:
	//   1) Collect affected user_ids
	//   2) Delete instances (cascade fires)
	cutoff := time.Now().UTC().Add(-staleness)
	var users []uuid.UUID
	err := s.withTx(ctx, func(tx pgx.Tx) error {
		rows, err := tx.Query(ctx,
			`SELECT dp.user_id FROM device_presence dp
			   JOIN instances i ON dp.instance_id = i.id
			  WHERE i.last_heartbeat < $1`,
			cutoff,
		)
		if err != nil {
			return err
		}
		defer rows.Close()
		for rows.Next() {
			var u uuid.UUID
			if err := rows.Scan(&u); err != nil {
				return err
			}
			users = append(users, u)
		}
		if err := rows.Err(); err != nil {
			return err
		}
		_, err = tx.Exec(ctx,
			`DELETE FROM instances WHERE last_heartbeat < $1`,
			cutoff,
		)
		return err
	})
	return users, err
}

// --- device presence ---------------------------------------------------

// SetDevicePresence inserts or updates a device's presence row. If a row
// already exists for the device_id but on a different instance, it's
// overwritten -- a device can only be "present" on one instance at a
// time, and a reconnect to a different instance reassigns ownership.
func (s *Store) SetDevicePresence(ctx context.Context, dp DevicePresence) error {
	_, err := s.Pool.Exec(ctx,
		`INSERT INTO device_presence
		   (device_id, user_id, instance_id, device_type, state, last_seen)
		 VALUES ($1, $2, $3, $4, $5, now())
		 ON CONFLICT (device_id) DO UPDATE
		   SET user_id     = EXCLUDED.user_id,
		       instance_id = EXCLUDED.instance_id,
		       device_type = EXCLUDED.device_type,
		       state       = EXCLUDED.state,
		       last_seen   = now()`,
		dp.DeviceID, dp.UserID, dp.InstanceID,
		string(dp.DeviceType), string(dp.State),
	)
	return err
}

// BumpLastSeen updates last_seen to now() for a device. If a state
// transition is in flight (a separate caller is downgrading the device
// to away/offline), this can compete; that's acceptable because the
// heartbeat is best-effort.
//
// Returns ErrDeviceNotPresent if the device row doesn't exist (e.g. it
// was cleaned by the janitor or never registered).
func (s *Store) BumpLastSeen(ctx context.Context, deviceID uuid.UUID) error {
	ct, err := s.Pool.Exec(ctx,
		`UPDATE device_presence SET last_seen = now() WHERE device_id = $1`,
		deviceID,
	)
	if err != nil {
		return err
	}
	if ct.RowsAffected() == 0 {
		return ErrDeviceNotPresent
	}
	return nil
}

// SetDeviceState changes a device's state and bumps last_seen. Returns
// the previous state (or empty string if the row didn't exist) so the
// caller can decide whether to publish a NOTIFY for a transition.
//
// A CTE captures the pre-update row before the UPDATE applies; the
// UPDATE then runs and the CTE's SELECT supplies the returned old state.
func (s *Store) SetDeviceState(ctx context.Context, deviceID uuid.UUID, newState State) (State, error) {
	var prev string
	err := s.Pool.QueryRow(ctx,
		`WITH prev AS (
		   SELECT state FROM device_presence WHERE device_id = $1
		 ),
		 upd AS (
		   UPDATE device_presence
		      SET state = $2, last_seen = now()
		    WHERE device_id = $1
		   RETURNING device_id
		 )
		 SELECT prev.state FROM prev`,
		deviceID, string(newState),
	).Scan(&prev)
	if errors.Is(err, pgx.ErrNoRows) {
		return "", ErrDeviceNotPresent
	}
	if err != nil {
		return "", err
	}
	return State(prev), nil
}

// ClearDevicePresence removes a single device's row. Called when a
// WebSocket disconnects cleanly.
func (s *Store) ClearDevicePresence(ctx context.Context, deviceID uuid.UUID) (uuid.UUID, error) {
	var userID uuid.UUID
	err := s.Pool.QueryRow(ctx,
		`DELETE FROM device_presence WHERE device_id = $1 RETURNING user_id`,
		deviceID,
	).Scan(&userID)
	if errors.Is(err, pgx.ErrNoRows) {
		return uuid.Nil, nil
	}
	return userID, err
}

// ErrDeviceNotPresent is returned by operations on a device that has no
// device_presence row. Usually means the row was cleaned by the janitor
// or never created.
var ErrDeviceNotPresent = errors.New("device not present")

// --- aggregation -------------------------------------------------------

// AggregateUserState returns the max-precedence state across all of a
// user's devices, plus the most recent last_seen across those devices.
//
// Precedence: online > away > offline. If the user has no devices at
// all, the returned state is offline and the timestamp is zero.
func (s *Store) AggregateUserState(ctx context.Context, userID uuid.UUID) (State, time.Time, error) {
	rows, err := s.Pool.Query(ctx,
		`SELECT state, last_seen FROM device_presence WHERE user_id = $1`,
		userID,
	)
	if err != nil {
		return "", time.Time{}, err
	}
	defer rows.Close()
	best := StateOffline
	var latest time.Time
	for rows.Next() {
		var st string
		var ls time.Time
		if err := rows.Scan(&st, &ls); err != nil {
			return "", time.Time{}, err
		}
		if statePrecedence(State(st)) > statePrecedence(best) {
			best = State(st)
		}
		if ls.After(latest) {
			latest = ls
		}
	}
	return best, latest, rows.Err()
}

// statePrecedence is exported via comparison helpers if needed; the
// numeric values don't matter outside this package.
func statePrecedence(s State) int {
	switch s {
	case StateOnline:
		return 2
	case StateAway:
		return 1
	}
	return 0
}

// --- demotion sweep ----------------------------------------------------

// DemotionResult describes a state transition observed by the demotion
// sweep. Caller publishes NOTIFYs for each affected user_id.
type DemotionResult struct {
	UserID  uuid.UUID
	OldState State
	NewState State
}

// Demote runs one pass of the staleness sweep. Behavior:
//
//   * Online devices whose last_seen is older than TTL(device_type) get
//     demoted to away. (Client may then update them back to online via
//     a presence_update + heartbeat, which is fine.)
//   * Away devices whose last_seen is older than 2 * TTL(device_type)
//     get demoted to offline.
//
// Returns one DemotionResult per device transition. The caller is
// responsible for aggregating to user-level changes before publishing.
//
// We do this in two distinct UPDATEs (online->away, away->offline) so
// the WHERE clauses remain simple and per-device-type TTL is captured.
func (s *Store) Demote(ctx context.Context) ([]DemotionResult, error) {
	out := []DemotionResult{}
	now := time.Now().UTC()
	for _, dt := range []DeviceType{
		DevicePhone, DeviceTablet, DeviceDesktop, DeviceBrowserUnknown,
	} {
		ttl := dt.TTL()
		// online -> away
		if rs, err := s.demoteBetween(ctx, dt, StateOnline, StateAway, now.Add(-ttl)); err != nil {
			return nil, err
		} else {
			out = append(out, rs...)
		}
		// away -> offline (after 2x TTL)
		if rs, err := s.demoteBetween(ctx, dt, StateAway, StateOffline, now.Add(-2*ttl)); err != nil {
			return nil, err
		} else {
			out = append(out, rs...)
		}
	}
	return out, nil
}

func (s *Store) demoteBetween(
	ctx context.Context,
	dt DeviceType,
	from, to State,
	cutoff time.Time,
) ([]DemotionResult, error) {
	rows, err := s.Pool.Query(ctx,
		`UPDATE device_presence
		    SET state = $1
		  WHERE device_type = $2
		    AND state = $3
		    AND last_seen < $4
		 RETURNING user_id`,
		string(to), string(dt), string(from), cutoff,
	)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []DemotionResult
	for rows.Next() {
		var u uuid.UUID
		if err := rows.Scan(&u); err != nil {
			return nil, err
		}
		out = append(out, DemotionResult{UserID: u, OldState: from, NewState: to})
	}
	return out, rows.Err()
}

// --- subscriptions -----------------------------------------------------

// AddSubscription records that subscriber_device_id wants presence updates
// for target_user_id. Idempotent.
func (s *Store) AddSubscription(ctx context.Context, subscriber, target uuid.UUID) error {
	_, err := s.Pool.Exec(ctx,
		`INSERT INTO presence_subscriptions (subscriber_device_id, target_user_id)
		 VALUES ($1, $2)
		 ON CONFLICT DO NOTHING`,
		subscriber, target,
	)
	return err
}

// RemoveSubscription removes a single subscription. Idempotent.
func (s *Store) RemoveSubscription(ctx context.Context, subscriber, target uuid.UUID) error {
	_, err := s.Pool.Exec(ctx,
		`DELETE FROM presence_subscriptions
		   WHERE subscriber_device_id = $1 AND target_user_id = $2`,
		subscriber, target,
	)
	return err
}

// SubscribersOfUser returns the device_ids of every subscriber to
// target_user_id, scoped to a specific chalkd instance (so each
// instance pushes only to its own connected clients).
func (s *Store) SubscribersOfUser(ctx context.Context, target uuid.UUID, instanceID string) ([]uuid.UUID, error) {
	rows, err := s.Pool.Query(ctx,
		`SELECT ps.subscriber_device_id
		   FROM presence_subscriptions ps
		   JOIN device_presence dp ON dp.device_id = ps.subscriber_device_id
		  WHERE ps.target_user_id = $1
		    AND dp.instance_id = $2`,
		target, instanceID,
	)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []uuid.UUID
	for rows.Next() {
		var d uuid.UUID
		if err := rows.Scan(&d); err != nil {
			return nil, err
		}
		out = append(out, d)
	}
	return out, rows.Err()
}

// --- internals ---------------------------------------------------------

func (s *Store) withTx(ctx context.Context, fn func(pgx.Tx) error) (err error) {
	tx, err := s.Pool.BeginTx(ctx, pgx.TxOptions{})
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
