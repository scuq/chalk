// Instance-wide settings an administrator changes at run time (129-2).
//
// A key/value table (migration 0062) rather than one column per switch, so
// the next administrator toggle needs a handler and no schema change. The
// store knows nothing about keys or defaults: an absent row is reported as
// absent, and the handler that owns the key fills in its default.

package store

import (
	"context"
	"encoding/json"
	"errors"

	"github.com/jackc/pgx/v5"
)

// GetInstanceSetting returns the stored JSON value for key and whether a row
// exists. An absent row is (nil, false, nil), not an error.
func (s *Store) GetInstanceSetting(ctx context.Context, key string) (json.RawMessage, bool, error) {
	var raw []byte
	err := s.Pool.QueryRow(ctx,
		`SELECT value FROM instance_settings WHERE key = $1`, key,
	).Scan(&raw)
	if err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return nil, false, nil
		}
		return nil, false, err
	}
	return json.RawMessage(raw), true, nil
}

// SetInstanceSetting stores value under key, replacing any previous value.
func (s *Store) SetInstanceSetting(ctx context.Context, key string, value json.RawMessage) error {
	_, err := s.Pool.Exec(ctx,
		`INSERT INTO instance_settings (key, value, updated_at)
		   VALUES ($1, $2::jsonb, now())
		   ON CONFLICT (key) DO UPDATE
		     SET value      = EXCLUDED.value,
		         updated_at = now()`,
		key, []byte(value),
	)
	return err
}
