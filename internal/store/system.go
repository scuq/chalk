package store

import (
	"context"
	"fmt"

	"github.com/jackc/pgx/v5"
)

// EnsureDefaultChannel idempotently inserts the placeholder channel with
// id = DefaultChannelID and a matching channel_seq row.
//
// Called at chalkd startup (post-migrations, post-partition-ensure). Safe
// against concurrent callers: ON CONFLICT DO NOTHING means the loser of a
// race is a no-op. The channel is "system-owned" (created_by IS NULL),
// which is allowed by the schema introduced in migration 0002.
//
// Phase 05 stores every relayed message into this channel. Phase 08
// introduces real channel creation; the default channel persists as the
// "lobby" or can be hidden, depending on product design at that time.
func (s *Store) EnsureDefaultChannel(ctx context.Context) error {
	return s.withTx(ctx, func(tx pgx.Tx) error {
		_, err := tx.Exec(ctx,
			`INSERT INTO channels (id, name, created_by)
			 VALUES ($1, 'default', NULL)
			 ON CONFLICT (id) DO NOTHING`,
			DefaultChannelID,
		)
		if err != nil {
			return fmt.Errorf("ensure default channel: %w", err)
		}
		_, err = tx.Exec(ctx,
			`INSERT INTO channel_seq (channel_id, next_seq)
			 VALUES ($1, 1)
			 ON CONFLICT (channel_id) DO NOTHING`,
			DefaultChannelID,
		)
		if err != nil {
			return fmt.Errorf("ensure default channel_seq: %w", err)
		}
		return nil
	})
}
