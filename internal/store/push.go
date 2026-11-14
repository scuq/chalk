package store

// 65-1: Web Push subscriptions. A subscription belongs to one login session
// and disappears with it (migration 0063).

import (
	"context"
	"errors"
	"fmt"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
)

// MaxPushSubscriptionsPerUser is the number of subscriptions one user keeps.
// A new subscription past the cap evicts the oldest.
const MaxPushSubscriptionsPerUser = 8

// PushScope says which messages push to a subscription.
type PushScope string

const (
	// PushScopeDMs pushes direct messages only.
	PushScopeDMs PushScope = "dms"
	// PushScopeAll pushes messages from every channel.
	PushScopeAll PushScope = "all"
)

// Valid reports whether sc is a scope the table accepts.
func (sc PushScope) Valid() bool {
	return sc == PushScopeDMs || sc == PushScopeAll
}

// A PushSubscription is one browser's Web Push registration. It does not
// carry the session token it is bound to.
type PushSubscription struct {
	ID         uuid.UUID
	UserID     uuid.UUID
	Endpoint   string
	P256dh     []byte // 65 bytes, uncompressed P-256 point
	Auth       []byte // 16 bytes
	Scope      PushScope
	Generic    bool
	VAPIDKey   string // 65-4: the VAPID public key the browser subscribed with
	CreatedAt  time.Time
	LastUsedAt time.Time
}

// pushCols is the column list of every PushSubscription read. Its count,
// the struct's field count and scanPush's argument count must match.
const pushCols = `p.id, p.user_id, p.endpoint, p.p256dh, p.auth, p.scope, p.generic, p.vapid_key, p.created_at, p.last_used_at`

// scanPush reads one pushCols row into a PushSubscription.
func scanPush(row pgx.Row) (PushSubscription, error) {
	var p PushSubscription
	err := row.Scan(
		&p.ID, &p.UserID, &p.Endpoint, &p.P256dh, &p.Auth, &p.Scope, &p.Generic, &p.VAPIDKey, &p.CreatedAt, &p.LastUsedAt,
	)
	return p, err
}

// sessionLiveSQL returns the validity test of GetSession for a sessions row
// aliased s. The argument param is the SQL placeholder that holds
// SessionMaxLifetime in microseconds.
func sessionLiveSQL(param string) string {
	return `s.expires_at > now() AND s.created_at > now() - make_interval(secs := ` + param + `::double precision / 1e6)`
}

// sessionMaxMicros returns SessionMaxLifetime in microseconds.
func sessionMaxMicros() int64 {
	return int64(SessionMaxLifetime / time.Microsecond)
}

// UpsertPushSubscription stores the subscription of the session behind
// sessionToken and returns it. The user comes from the session row, so a
// subscription cannot name a user other than the session's.
//
// It replaces the session's earlier subscription and any row that holds the
// same endpoint. If the user then has more than
// MaxPushSubscriptionsPerUser rows, it deletes the oldest by created_at.
//
// vapidKey is the VAPID public key the browser subscribed with.
//
// It returns ErrNotFound if the token names no live session of a
// non-guest user.
func (s *Store) UpsertPushSubscription(
	ctx context.Context,
	sessionToken []byte,
	endpoint string,
	p256dh, auth []byte,
	scope PushScope,
	vapidKey string,
) (PushSubscription, error) {
	if !scope.Valid() {
		return PushSubscription{}, fmt.Errorf("upsert push subscription: scope %q", scope)
	}
	var out PushSubscription
	err := s.withTx(ctx, func(tx pgx.Tx) error {
		// The user row lock orders concurrent upserts of one user, so the
		// cap below counts a settled set.
		var userID uuid.UUID
		err := tx.QueryRow(ctx,
			`SELECT u.id
			   FROM sessions s
			   JOIN users u ON u.id = s.user_id
			  WHERE s.token = $1
			    AND u.guest_channel_id IS NULL
			    AND `+sessionLiveSQL("$2")+`
			    FOR UPDATE OF u`,
			sessionToken, sessionMaxMicros(),
		).Scan(&userID)
		if err != nil {
			return translateErr(err)
		}
		if _, err := tx.Exec(ctx,
			`DELETE FROM push_subscriptions WHERE session_token = $1 OR endpoint = $2`,
			sessionToken, endpoint,
		); err != nil {
			return err
		}
		out, err = scanPush(tx.QueryRow(ctx,
			`INSERT INTO push_subscriptions AS p (user_id, session_token, endpoint, p256dh, auth, scope, vapid_key)
			 VALUES ($1, $2, $3, $4, $5, $6, $7)
			 RETURNING `+pushCols,
			userID, sessionToken, endpoint, p256dh, auth, string(scope), vapidKey,
		))
		if err != nil {
			return err
		}
		_, err = tx.Exec(ctx,
			`DELETE FROM push_subscriptions
			  WHERE user_id = $1
			    AND id NOT IN (
			      SELECT id FROM push_subscriptions
			       WHERE user_id = $1
			       ORDER BY created_at DESC, id
			       LIMIT $2)`,
			userID, MaxPushSubscriptionsPerUser,
		)
		return err
	})
	if err != nil {
		if errors.Is(err, ErrNotFound) {
			return PushSubscription{}, ErrNotFound
		}
		return PushSubscription{}, fmt.Errorf("upsert push subscription: %w", err)
	}
	return out, nil
}

// GetPushSubscriptionForSession returns the subscription of the session
// behind sessionToken, or ErrNotFound.
func (s *Store) GetPushSubscriptionForSession(ctx context.Context, sessionToken []byte) (PushSubscription, error) {
	p, err := scanPush(s.Pool.QueryRow(ctx,
		`SELECT `+pushCols+` FROM push_subscriptions p WHERE p.session_token = $1`,
		sessionToken,
	))
	if err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return PushSubscription{}, ErrNotFound
		}
		return PushSubscription{}, fmt.Errorf("get push subscription: %w", err)
	}
	return p, nil
}

// DeletePushSubscriptionForSession removes the subscription of the session
// behind sessionToken. A session with no subscription is not an error.
func (s *Store) DeletePushSubscriptionForSession(ctx context.Context, sessionToken []byte) error {
	if _, err := s.Pool.Exec(ctx,
		`DELETE FROM push_subscriptions WHERE session_token = $1`, sessionToken,
	); err != nil {
		return fmt.Errorf("delete push subscription: %w", err)
	}
	return nil
}

// DeletePushSubscription removes one subscription by id.
func (s *Store) DeletePushSubscription(ctx context.Context, id uuid.UUID) error {
	if _, err := s.Pool.Exec(ctx,
		`DELETE FROM push_subscriptions WHERE id = $1`, id,
	); err != nil {
		return fmt.Errorf("delete push subscription: %w", err)
	}
	return nil
}

// TouchPushSubscription sets last_used_at of one subscription to now.
func (s *Store) TouchPushSubscription(ctx context.Context, id uuid.UUID) error {
	if _, err := s.Pool.Exec(ctx,
		`UPDATE push_subscriptions SET last_used_at = now() WHERE id = $1`, id,
	); err != nil {
		return fmt.Errorf("touch push subscription: %w", err)
	}
	return nil
}

// ListPushSubscriptionsForUsers returns the subscriptions of userIDs that a
// message can push to. With isDM true, every scope qualifies. With isDM
// false, only subscriptions of scope "all" qualify.
//
// A subscription whose session expired does not qualify, even if
// [Store.DeleteExpiredSessions] has not yet deleted the session row. A
// subscription made with a VAPID key other than vapidKey does not qualify
// either, because the push service refuses it.
func (s *Store) ListPushSubscriptionsForUsers(
	ctx context.Context,
	userIDs []uuid.UUID,
	isDM bool,
	vapidKey string,
) ([]PushSubscription, error) {
	if len(userIDs) == 0 {
		return nil, nil
	}
	rows, err := s.Pool.Query(ctx,
		`SELECT `+pushCols+`
		   FROM push_subscriptions p
		   JOIN sessions s ON s.token = p.session_token
		  WHERE p.user_id = ANY($1)
		    AND ($2 OR p.scope = 'all')
		    AND `+sessionLiveSQL("$3")+`
		    AND p.vapid_key = $4
		  ORDER BY p.user_id, p.created_at, p.id`,
		userIDs, isDM, sessionMaxMicros(), vapidKey,
	)
	if err != nil {
		return nil, fmt.Errorf("list push subscriptions: %w", err)
	}
	defer rows.Close()
	var out []PushSubscription
	for rows.Next() {
		p, err := scanPush(rows)
		if err != nil {
			return nil, fmt.Errorf("list push subscriptions: %w", err)
		}
		out = append(out, p)
	}
	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("list push subscriptions: %w", err)
	}
	return out, nil
}
