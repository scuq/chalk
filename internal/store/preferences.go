// Per-user JSONB preferences storage (Phase 9.7).
//
// First consumer: theme picker. Structured to absorb future prefs
// (notification settings, default channel sort, MLS toggles in
// phase 10) without schema changes.
//
// Concurrency: a single UPSERT with JSONB `||` merge gives row-level
// atomicity. Last-write-wins per-key within concurrent ops; different
// keys merge cleanly.

package store

import (
	"context"
	"encoding/json"
	"errors"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
)

// GetPreferences returns the raw JSONB body for a user. Returns an
// empty map (not nil) when the row doesn't exist yet.
func (s *Store) GetPreferences(ctx context.Context, userID uuid.UUID) (map[string]any, error) {
	var raw []byte
	err := s.Pool.QueryRow(ctx,
		`SELECT prefs FROM user_preferences WHERE user_id = $1`, userID,
	).Scan(&raw)
	if err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return map[string]any{}, nil
		}
		return nil, err
	}
	var out map[string]any
	if err := json.Unmarshal(raw, &out); err != nil {
		return nil, err
	}
	if out == nil {
		out = map[string]any{}
	}
	return out, nil
}

// UpsertPreferences merges the supplied patch into the user's stored
// prefs via JSONB `||`. Keys in the patch overwrite; keys absent are
// preserved. Returns the merged result so callers can echo it.
//
// `||` is shallow: a nested object on the right replaces the same key
// on the left wholesale. Prefs are flat by convention to sidestep this.
func (s *Store) UpsertPreferences(
	ctx context.Context,
	userID uuid.UUID,
	patch map[string]any,
) (map[string]any, error) {
	patchJSON, err := json.Marshal(patch)
	if err != nil {
		return nil, err
	}
	var rawResult []byte
	err = s.Pool.QueryRow(ctx,
		`INSERT INTO user_preferences (user_id, prefs, updated_at)
		   VALUES ($1, $2::jsonb, now())
		   ON CONFLICT (user_id) DO UPDATE
		     SET prefs      = user_preferences.prefs || EXCLUDED.prefs,
		         updated_at = now()
		   RETURNING prefs`,
		userID, patchJSON,
	).Scan(&rawResult)
	if err != nil {
		return nil, err
	}
	var merged map[string]any
	if err := json.Unmarshal(rawResult, &merged); err != nil {
		return nil, err
	}
	if merged == nil {
		merged = map[string]any{}
	}
	return merged, nil
}

// GetPreferencesUpdatedAt returns the last-modified timestamp. Useful
// for cache invalidation later. Returns zero time if no row.
func (s *Store) GetPreferencesUpdatedAt(
	ctx context.Context,
	userID uuid.UUID,
) (time.Time, error) {
	var t time.Time
	err := s.Pool.QueryRow(ctx,
		`SELECT updated_at FROM user_preferences WHERE user_id = $1`, userID,
	).Scan(&t)
	if err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return time.Time{}, nil
		}
		return time.Time{}, err
	}
	return t, nil
}
