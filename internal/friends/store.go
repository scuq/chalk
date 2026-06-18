// Package friends implements the friendship state machine on top of the
// friendships table.
//
// Storage convention from migration 0007:
//   - accepted rows are stored with user_a < user_b lexicographically
//   - pending rows preserve direction: user_a is the requester
//   - blocked rows preserve direction: user_a is the blocker
//
// All operations in this package handle that convention internally;
// callers pass two user_ids in whatever order, and the package re-orders
// or queries both directions as needed.
package friends

import (
	"context"
	"errors"
	"fmt"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
)

// Status is the friendship state. Distinct from User.Status (account
// lifecycle); the two are unrelated dimensions.
type Status string

const (
	StatusPending  Status = "pending"
	StatusAccepted Status = "accepted"
	StatusBlocked  Status = "blocked"
)

// Friendship is a row from the friendships table.
type Friendship struct {
	UserA  uuid.UUID
	UserB  uuid.UUID
	Status Status
}

// Errors returned by package operations.
var (
	ErrSelfFriend       = errors.New("cannot friend yourself")
	ErrUserNotFound     = errors.New("user not found")
	ErrUserUnavailable  = errors.New("user unavailable")
	ErrAlreadyFriends   = errors.New("already friends")
	ErrBlocked          = errors.New("friendship blocked")
	ErrNoPendingRequest = errors.New("no pending request")
	ErrInvalidState     = errors.New("invalid state for operation")
)

// Store wraps a pgxpool with friendship operations.
type Store struct {
	Pool *pgxpool.Pool
}

// orderPair returns the two UUIDs in lexicographic order. Used for
// accepted-friendship lookups where the row is canonicalized.
func orderPair(a, b uuid.UUID) (uuid.UUID, uuid.UUID) {
	if pairLess(a, b) {
		return a, b
	}
	return b, a
}

// pairLess returns whether a sorts before b in the same ordering Postgres
// uses for UUID columns. pgx encodes UUIDs as bytes; PG compares them
// byte-wise. uuid.UUID is [16]byte, so a straight byte comparison matches.
func pairLess(a, b uuid.UUID) bool {
	for i := 0; i < 16; i++ {
		if a[i] != b[i] {
			return a[i] < b[i]
		}
	}
	return false
}

// AssertActive returns ErrUserNotFound or ErrUserUnavailable if the user
// row doesn't exist or isn't in active status. Used before any friendship
// write so we never create a pending row pointing at a deleted user.
func (s *Store) AssertActive(ctx context.Context, id uuid.UUID) error {
	var status string
	err := s.Pool.QueryRow(ctx,
		`SELECT status FROM users WHERE id = $1`, id,
	).Scan(&status)
	if errors.Is(err, pgx.ErrNoRows) {
		return ErrUserNotFound
	}
	if err != nil {
		return fmt.Errorf("user status: %w", err)
	}
	if status != "active" {
		return ErrUserUnavailable
	}
	return nil
}

// Request submits a friend request from -> to. Outcomes:
//   - If no prior friendship exists: creates a pending row, returns
//     ("requested", nil).
//   - If a pending row already exists from -> to: idempotent, returns
//     ("requested", nil).
//   - If a pending row exists from to -> from (i.e., they requested us
//     and we're accepting by sending a request back): promotes to
//     accepted, returns ("auto_accepted", nil).
//   - If already accepted: returns ErrAlreadyFriends.
//   - If blocked (either direction): returns ErrBlocked.
//
// Self-requests return ErrSelfFriend.
func (s *Store) Request(ctx context.Context, from, to uuid.UUID) (string, error) {
	if from == to {
		return "", ErrSelfFriend
	}
	if err := s.AssertActive(ctx, to); err != nil {
		return "", err
	}

	var outcome string
	err := s.withTx(ctx, func(tx pgx.Tx) error {
		// Check any existing relationship. There can be at most one row
		// per pair in any direction, except a (rare but valid) state where
		// both sides have independently blocked each other (two rows).
		// For our purposes here, ANY blocked row in either direction
		// poisons the friend-request path.
		existing, err := lookupAny(ctx, tx, from, to)
		if err != nil {
			return err
		}

		switch {
		case existing == nil:
			// Fresh request.
			_, err := tx.Exec(ctx,
				`INSERT INTO friendships (user_a, user_b, status, requested_at)
				 VALUES ($1, $2, 'pending', now())`,
				from, to,
			)
			outcome = "requested"
			return err

		case existing.Status == StatusBlocked:
			return ErrBlocked

		case existing.Status == StatusAccepted:
			return ErrAlreadyFriends

		case existing.Status == StatusPending && existing.UserA == from:
			// Already requested by us; idempotent.
			outcome = "requested"
			return nil

		case existing.Status == StatusPending && existing.UserA == to:
			// They requested us. Promote to accepted with canonical
			// ordering.
			ua, ub := orderPair(from, to)
			// Delete the old (asymmetric) row and insert the canonical
			// (symmetric) one. Doing both in a tx keeps the invariant.
			if _, err := tx.Exec(ctx,
				`DELETE FROM friendships WHERE user_a = $1 AND user_b = $2`,
				to, from,
			); err != nil {
				return err
			}
			if _, err := tx.Exec(ctx,
				`INSERT INTO friendships (user_a, user_b, status, requested_at, accepted_at)
				 VALUES ($1, $2, 'accepted', now(), now())`,
				ua, ub,
			); err != nil {
				return err
			}
			outcome = "auto_accepted"
			return nil
		}
		return ErrInvalidState
	})
	return outcome, err
}

// Accept promotes a pending request from -> us into an accepted row.
// Returns ErrNoPendingRequest if there's no matching pending row.
func (s *Store) Accept(ctx context.Context, us, from uuid.UUID) error {
	if us == from {
		return ErrSelfFriend
	}
	return s.withTx(ctx, func(tx pgx.Tx) error {
		ct, err := tx.Exec(ctx,
			`DELETE FROM friendships
			   WHERE user_a = $1 AND user_b = $2 AND status = 'pending'`,
			from, us,
		)
		if err != nil {
			return err
		}
		if ct.RowsAffected() == 0 {
			return ErrNoPendingRequest
		}
		ua, ub := orderPair(us, from)
		_, err = tx.Exec(ctx,
			`INSERT INTO friendships (user_a, user_b, status, requested_at, accepted_at)
			 VALUES ($1, $2, 'accepted', now(), now())`,
			ua, ub,
		)
		return err
	})
}

// Decline removes a pending request from -> us. Returns ErrNoPendingRequest
// if there's no matching pending row.
func (s *Store) Decline(ctx context.Context, us, from uuid.UUID) error {
	ct, err := s.Pool.Exec(ctx,
		`DELETE FROM friendships
		   WHERE user_a = $1 AND user_b = $2 AND status = 'pending'`,
		from, us,
	)
	if err != nil {
		return err
	}
	if ct.RowsAffected() == 0 {
		return ErrNoPendingRequest
	}
	return nil
}

// Remove deletes an accepted friendship in either direction. Idempotent:
// returns nil even if no row was deleted (the friendship was already
// gone, e.g. the other side removed first).
func (s *Store) Remove(ctx context.Context, us, them uuid.UUID) error {
	ua, ub := orderPair(us, them)
	_, err := s.Pool.Exec(ctx,
		`DELETE FROM friendships
		   WHERE user_a = $1 AND user_b = $2 AND status = 'accepted'`,
		ua, ub,
	)
	return err
}

// Block records that us has blocked them. Side effects:
//   - Any existing accepted friendship between the pair is removed.
//   - Any existing pending request between the pair (either direction) is
//     removed.
//   - A blocked row is inserted with user_a=us, user_b=them.
//
// Idempotent: re-blocking is a no-op.
func (s *Store) Block(ctx context.Context, us, them uuid.UUID) error {
	if us == them {
		return ErrSelfFriend
	}
	return s.withTx(ctx, func(tx pgx.Tx) error {
		// Drop any accepted (canonical) row.
		ua, ub := orderPair(us, them)
		if _, err := tx.Exec(ctx,
			`DELETE FROM friendships
			   WHERE user_a = $1 AND user_b = $2 AND status = 'accepted'`,
			ua, ub,
		); err != nil {
			return err
		}
		// Drop any pending row in either direction.
		if _, err := tx.Exec(ctx,
			`DELETE FROM friendships
			   WHERE status = 'pending' AND
			         ((user_a = $1 AND user_b = $2) OR
			          (user_a = $2 AND user_b = $1))`,
			us, them,
		); err != nil {
			return err
		}
		// Insert the block row. Idempotent.
		_, err := tx.Exec(ctx,
			`INSERT INTO friendships (user_a, user_b, status, requested_at)
			 VALUES ($1, $2, 'blocked', now())
			 ON CONFLICT (user_a, user_b) DO UPDATE
			   SET status = 'blocked'`,
			us, them,
		)
		return err
	})
}

// Unblock removes a blocked row. Idempotent.
func (s *Store) Unblock(ctx context.Context, us, them uuid.UUID) error {
	_, err := s.Pool.Exec(ctx,
		`DELETE FROM friendships
		   WHERE user_a = $1 AND user_b = $2 AND status = 'blocked'`,
		us, them,
	)
	return err
}

// AreAcceptedFriends returns true iff there's a canonical accepted row
// for the unordered pair (a, b).
func (s *Store) AreAcceptedFriends(ctx context.Context, a, b uuid.UUID) (bool, error) {
	if a == b {
		return false, nil
	}
	ua, ub := orderPair(a, b)
	var exists bool
	err := s.Pool.QueryRow(ctx,
		`SELECT EXISTS(
		   SELECT 1 FROM friendships
		    WHERE user_a = $1 AND user_b = $2 AND status = 'accepted'
		 )`,
		ua, ub,
	).Scan(&exists)
	return exists, err
}

// IsBlockedEitherWay returns true if either party has blocked the other.
// Used to gate friend requests and presence delivery.
func (s *Store) IsBlockedEitherWay(ctx context.Context, a, b uuid.UUID) (bool, error) {
	if a == b {
		return false, nil
	}
	var exists bool
	err := s.Pool.QueryRow(ctx,
		`SELECT EXISTS(
		   SELECT 1 FROM friendships
		    WHERE status = 'blocked' AND
		          ((user_a = $1 AND user_b = $2) OR
		           (user_a = $2 AND user_b = $1))
		 )`,
		a, b,
	).Scan(&exists)
	return exists, err
}

// FriendListEntry is the package-level summary returned by List. The
// server layer maps these to proto.FriendSummary, joining in the user's
// handle and account status.
type FriendListEntry struct {
	OtherUserID uuid.UUID
	Status      Status
	// Direction is meaningful only for pending: "outgoing" if we sent
	// the request, "incoming" if they did. Empty for accepted/blocked.
	Direction string
}

// List returns all friendships involving us, classified by status and
// direction.
func (s *Store) List(ctx context.Context, us uuid.UUID) ([]FriendListEntry, error) {
	rows, err := s.Pool.Query(ctx,
		`SELECT user_a, user_b, status FROM friendships
		   WHERE user_a = $1 OR user_b = $1`,
		us,
	)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	var out []FriendListEntry
	for rows.Next() {
		var ua, ub uuid.UUID
		var status string
		if err := rows.Scan(&ua, &ub, &status); err != nil {
			return nil, err
		}
		e := FriendListEntry{Status: Status(status)}
		switch {
		case ua == us:
			e.OtherUserID = ub
			if status == "pending" {
				e.Direction = "outgoing"
			}
		case ub == us:
			e.OtherUserID = ua
			if status == "pending" {
				e.Direction = "incoming"
			}
		}
		// Blocked rows are only included if WE blocked them (user_a == us).
		// Being blocked BY someone shouldn't surface to us.
		if status == "blocked" && ua != us {
			continue
		}
		out = append(out, e)
	}
	return out, rows.Err()
}

// --- internals ---------------------------------------------------------

// lookupAny returns the friendship row for the unordered pair (a, b),
// regardless of which direction it's stored in. Returns nil if no row
// exists. If multiple rows exist (which can happen for mutual blocks),
// returns one of them; callers needing the full picture should query
// directly.
func lookupAny(ctx context.Context, tx pgx.Tx, a, b uuid.UUID) (*Friendship, error) {
	rows, err := tx.Query(ctx,
		`SELECT user_a, user_b, status FROM friendships
		   WHERE (user_a = $1 AND user_b = $2) OR
		         (user_a = $2 AND user_b = $1)`,
		a, b,
	)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var found *Friendship
	for rows.Next() {
		var f Friendship
		var st string
		if err := rows.Scan(&f.UserA, &f.UserB, &st); err != nil {
			return nil, err
		}
		f.Status = Status(st)
		// Prefer the most "binding" status if multiple rows exist.
		// Precedence: blocked > accepted > pending.
		if found == nil || statusPrecedence(f.Status) > statusPrecedence(found.Status) {
			cp := f
			found = &cp
		}
	}
	return found, rows.Err()
}

func statusPrecedence(s Status) int {
	switch s {
	case StatusBlocked:
		return 3
	case StatusAccepted:
		return 2
	case StatusPending:
		return 1
	}
	return 0
}

// withTx is a local transaction wrapper. Keeps the store package
// self-contained without importing the larger store package.
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
