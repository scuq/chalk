package store

// 87-7: reminder wake records (migration 0065).

import (
	"context"
	"errors"
	"fmt"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
)

// MaxReminderWakesPerUser is the largest wake set of one user. It equals
// REMINDER_MAX of the client.
const MaxReminderWakesPerUser = 25

// A ReminderWake is the due time of one pending reminder. ReminderID is a
// random ID from the client. It names no message and no channel.
type ReminderWake struct {
	ReminderID uuid.UUID
	DueAt      time.Time
}

// ReplaceReminderWakes replaces the wake set of userID with wakes and returns
// the number of stored records.
//
// If the user has no push subscription, it deletes the set and returns 0.
// Any subscription row of the user counts. It does not check that the
// session of the row is live.
// The set also goes away when the last subscription of the user is deleted.
// A set of more than MaxReminderWakesPerUser records is an error. A
// reminder ID that occurs twice is stored once.
//
// It returns ErrNotFound if userID names no user.
func (s *Store) ReplaceReminderWakes(ctx context.Context, userID uuid.UUID, wakes []ReminderWake) (int, error) {
	if len(wakes) > MaxReminderWakesPerUser {
		return 0, fmt.Errorf("replace reminder wakes: %d records", len(wakes))
	}
	ids := make([]uuid.UUID, len(wakes))
	dues := make([]time.Time, len(wakes))
	for i, w := range wakes {
		ids[i] = w.ReminderID
		dues[i] = w.DueAt
	}
	stored := 0
	err := s.withTx(ctx, func(tx pgx.Tx) error {
		// The user row lock orders concurrent replaces of one user.
		var id uuid.UUID
		if err := tx.QueryRow(ctx,
			`SELECT id FROM users WHERE id = $1 FOR UPDATE`, userID,
		).Scan(&id); err != nil {
			return translateErr(err)
		}
		// The share lock holds the subscriptions until the commit. A delete
		// of the last one waits, and its trigger then sees the new set.
		rows, err := tx.Query(ctx,
			`SELECT id FROM push_subscriptions WHERE user_id = $1 FOR SHARE`, userID)
		if err != nil {
			return err
		}
		subs := 0
		for rows.Next() {
			subs++
		}
		rows.Close()
		if err := rows.Err(); err != nil {
			return err
		}
		if _, err := tx.Exec(ctx,
			`DELETE FROM reminder_wakes WHERE user_id = $1`, userID); err != nil {
			return err
		}
		if subs == 0 || len(wakes) == 0 {
			return nil
		}
		tag, err := tx.Exec(ctx,
			`INSERT INTO reminder_wakes (user_id, reminder_id, due_at)
			 SELECT $1, w.reminder_id, w.due_at
			   FROM unnest($2::uuid[], $3::timestamptz[]) AS w(reminder_id, due_at)
			 ON CONFLICT DO NOTHING`,
			userID, ids, dues)
		if err != nil {
			return err
		}
		stored = int(tag.RowsAffected())
		return nil
	})
	if err != nil {
		if errors.Is(err, ErrNotFound) {
			return 0, ErrNotFound
		}
		return 0, fmt.Errorf("replace reminder wakes: %w", err)
	}
	return stored, nil
}

// ListReminderWakes returns the wake set of userID, earliest due time first.
func (s *Store) ListReminderWakes(ctx context.Context, userID uuid.UUID) ([]ReminderWake, error) {
	rows, err := s.Pool.Query(ctx,
		`SELECT reminder_id, due_at FROM reminder_wakes
		  WHERE user_id = $1 ORDER BY due_at, reminder_id`, userID)
	if err != nil {
		return nil, fmt.Errorf("list reminder wakes: %w", err)
	}
	defer rows.Close()
	var out []ReminderWake
	for rows.Next() {
		var w ReminderWake
		if err := rows.Scan(&w.ReminderID, &w.DueAt); err != nil {
			return nil, fmt.Errorf("list reminder wakes: %w", err)
		}
		out = append(out, w)
	}
	return out, rows.Err()
}

// A DueReminderWake is one wake record that ClaimDueReminderWakes took.
type DueReminderWake struct {
	UserID     uuid.UUID
	ReminderID uuid.UUID
}

// ClaimDueReminderWakes deletes up to limit wake records with a due time at
// or before now, earliest first, and returns them. A record is returned to
// one caller only, so two chalkd instances on one database do not both send
// its push.
//
// It deletes the due records of a blocked or soft-deleted user and does not
// return them.
func (s *Store) ClaimDueReminderWakes(ctx context.Context, now time.Time, limit int) ([]DueReminderWake, error) {
	rows, err := s.Pool.Query(ctx,
		`WITH due AS (
		   DELETE FROM reminder_wakes
		    WHERE (user_id, reminder_id) IN (
		      SELECT user_id, reminder_id FROM reminder_wakes
		       WHERE due_at <= $1
		       ORDER BY due_at
		       LIMIT $2
		       FOR UPDATE SKIP LOCKED)
		   RETURNING user_id, reminder_id, due_at)
		 SELECT due.user_id, due.reminder_id
		   FROM due
		   JOIN users u ON u.id = due.user_id
		  WHERE u.blocked_at IS NULL AND u.deleted_at IS NULL
		  ORDER BY due.due_at, due.reminder_id`,
		now, limit)
	if err != nil {
		return nil, fmt.Errorf("claim reminder wakes: %w", err)
	}
	defer rows.Close()
	var out []DueReminderWake
	for rows.Next() {
		var w DueReminderWake
		if err := rows.Scan(&w.UserID, &w.ReminderID); err != nil {
			return nil, fmt.Errorf("claim reminder wakes: %w", err)
		}
		out = append(out, w)
	}
	return out, rows.Err()
}
