package store

import (
	"context"
	"errors"
	"fmt"
	"strings"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
)

// Channel is the in-memory shape of a row from the channels table plus
// the bare metadata. Member IDs live in channel_members and are loaded
// on demand via ListMembers.
type Channel struct {
	ID        uuid.UUID
	Name      string
	IsDM      bool
	CreatedBy *uuid.UUID // nil for system channels
	CreatedAt time.Time
}

// ChannelWithMembers couples a Channel with its full member set.
// Used by ListChannelsForUser, which needs both for the wire summary.
type ChannelWithMembers struct {
	Channel
	MemberIDs []uuid.UUID
}

// Member is one row from channel_members.
type Member struct {
	UserID   uuid.UUID
	Role     string
	JoinedAt time.Time
}

// --- Errors ----------------------------------------------------------------

// ErrChannelNotFound is returned when the channel ID has no row.
var ErrChannelNotFound = errors.New("channel not found")

// ErrNotAMember is returned when an authorization check finds the user
// is not in channel_members for the target channel.
var ErrNotAMember = errors.New("not a channel member")

// ErrDMCardinality is returned when a DM-flagged channel is being created
// with anything other than exactly 2 distinct members.
var ErrDMCardinality = errors.New("DM must have exactly 2 members")

// --- CreateChannel ---------------------------------------------------------

// CreateChannelInput is everything we need to create a channel in one
// transaction: the row plus the initial member set.
//
// CreatedBy is the user_id of the caller; they become role='owner'.
// MemberIDs is the set of OTHER users to add; the caller is added
// automatically. Duplicates are de-duplicated. The caller may appear
// in MemberIDs; their role stays 'owner'.
type CreateChannelInput struct {
	Name      string
	IsDM      bool
	CreatedBy uuid.UUID
	MemberIDs []uuid.UUID
}

// CreateChannel inserts the channel + the per-channel sequence row +
// all members in a single transaction. Returns the created channel
// with assigned ID and member list.
//
// The DM-cardinality constraint trigger is DEFERRABLE INITIALLY DEFERRED,
// so the inserts happen first and the check fires at COMMIT. If the
// trigger raises (DM with != 2 members), Commit returns an error; the
// caller sees that as ErrDMCardinality after our error normalization
// below.
func (s *Store) CreateChannel(ctx context.Context, in CreateChannelInput) (ChannelWithMembers, error) {
	if strings.TrimSpace(in.Name) == "" {
		return ChannelWithMembers{}, errors.New("channel name required")
	}
	if in.CreatedBy == uuid.Nil {
		return ChannelWithMembers{}, errors.New("created_by required")
	}

	// De-dup member list, ensure caller present, build the final ordered set.
	memberSet := make(map[uuid.UUID]struct{}, len(in.MemberIDs)+1)
	memberSet[in.CreatedBy] = struct{}{}
	for _, m := range in.MemberIDs {
		if m == uuid.Nil {
			return ChannelWithMembers{}, errors.New("nil member id")
		}
		memberSet[m] = struct{}{}
	}
	members := make([]uuid.UUID, 0, len(memberSet))
	for m := range memberSet {
		members = append(members, m)
	}

	// Pre-check DM cardinality here too. The trigger will catch us at
	// commit either way, but failing early gives a clean error rather
	// than wrapping a postgres error string.
	if in.IsDM && len(members) != 2 {
		return ChannelWithMembers{}, fmt.Errorf("%w: got %d", ErrDMCardinality, len(members))
	}

	var result ChannelWithMembers
	err := s.withTx(ctx, func(tx pgx.Tx) error {
		// 1. Insert channel.
		var ch Channel
		err := tx.QueryRow(ctx,
			`INSERT INTO channels (name, is_dm, created_by)
			 VALUES ($1, $2, $3)
			 RETURNING id, name, is_dm, created_by, created_at`,
			strings.TrimSpace(in.Name), in.IsDM, in.CreatedBy,
		).Scan(&ch.ID, &ch.Name, &ch.IsDM, &ch.CreatedBy, &ch.CreatedAt)
		if err != nil {
			return fmt.Errorf("insert channel: %w", err)
		}

		// 2. Per-channel sequence row.
		if _, err := tx.Exec(ctx,
			`INSERT INTO channel_seq (channel_id, next_seq) VALUES ($1, 1)`,
			ch.ID,
		); err != nil {
			return fmt.Errorf("insert channel_seq: %w", err)
		}

		// 3. Members. Owner first, then everyone else as member.
		// We INSERT each row; the trigger collects all DM checks until
		// COMMIT and fires once.
		for _, m := range members {
			role := "member"
			if m == in.CreatedBy {
				role = "owner"
			}
			if _, err := tx.Exec(ctx,
				`INSERT INTO channel_members (channel_id, user_id, role)
				 VALUES ($1, $2, $3)`,
				ch.ID, m, role,
			); err != nil {
				return fmt.Errorf("insert member %s: %w", m, err)
			}
		}

		result = ChannelWithMembers{Channel: ch, MemberIDs: members}
		return nil
	})
	if err != nil {
		// Normalize the DM cardinality trigger error if it fired at commit.
		if strings.Contains(err.Error(), "DM channel must have exactly 2 members") {
			return ChannelWithMembers{}, ErrDMCardinality
		}
		return ChannelWithMembers{}, err
	}
	return result, nil
}

// --- GetChannel -----------------------------------------------------------

// GetChannel returns a channel by ID without member info. Returns
// ErrChannelNotFound if missing.
func (s *Store) GetChannel(ctx context.Context, channelID uuid.UUID) (Channel, error) {
	var ch Channel
	err := s.Pool.QueryRow(ctx,
		`SELECT id, name, is_dm, created_by, created_at
		   FROM channels WHERE id = $1`,
		channelID,
	).Scan(&ch.ID, &ch.Name, &ch.IsDM, &ch.CreatedBy, &ch.CreatedAt)
	if errors.Is(err, pgx.ErrNoRows) {
		return Channel{}, ErrChannelNotFound
	}
	if err != nil {
		return Channel{}, err
	}
	return ch, nil
}

// --- IsMember -------------------------------------------------------------

// IsMember returns true iff (channelID, userID) is in channel_members.
// Used for the membership check on send / fetch_history / etc.
func (s *Store) IsMember(ctx context.Context, channelID, userID uuid.UUID) (bool, error) {
	var exists bool
	err := s.Pool.QueryRow(ctx,
		`SELECT EXISTS(
		   SELECT 1 FROM channel_members
		    WHERE channel_id = $1 AND user_id = $2
		 )`,
		channelID, userID,
	).Scan(&exists)
	return exists, err
}

// --- ListChannelsForUser --------------------------------------------------

// ListChannelsForUser returns every channel the user is a member of,
// each with its full member set. Used to build the sidebar on hello
// (welcome.Channels) and on explicit list_channels frames.
//
// We do this in two queries rather than one CTE-with-aggregation:
//   1) list channel rows
//   2) bulk-fetch all members for those channel IDs in a single IN()
// Keeping the queries plain reads better than a single clever join,
// and the member-count cardinality is small (a few users per channel).
func (s *Store) ListChannelsForUser(ctx context.Context, userID uuid.UUID) ([]ChannelWithMembers, error) {
	rows, err := s.Pool.Query(ctx,
		`SELECT c.id, c.name, c.is_dm, c.created_by, c.created_at
		   FROM channels c
		   JOIN channel_members cm ON cm.channel_id = c.id
		  WHERE cm.user_id = $1
		  ORDER BY c.created_at DESC`,
		userID,
	)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	channels := make([]ChannelWithMembers, 0, 16)
	channelIDs := make([]uuid.UUID, 0, 16)
	for rows.Next() {
		var c Channel
		if err := rows.Scan(&c.ID, &c.Name, &c.IsDM, &c.CreatedBy, &c.CreatedAt); err != nil {
			return nil, err
		}
		channels = append(channels, ChannelWithMembers{Channel: c})
		channelIDs = append(channelIDs, c.ID)
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}
	if len(channels) == 0 {
		return channels, nil
	}

	// Bulk-fetch members for all channels in one query.
	memberRows, err := s.Pool.Query(ctx,
		`SELECT channel_id, user_id
		   FROM channel_members
		  WHERE channel_id = ANY($1)`,
		channelIDs,
	)
	if err != nil {
		return nil, err
	}
	defer memberRows.Close()

	membersByChannel := make(map[uuid.UUID][]uuid.UUID, len(channels))
	for memberRows.Next() {
		var cid, uid uuid.UUID
		if err := memberRows.Scan(&cid, &uid); err != nil {
			return nil, err
		}
		membersByChannel[cid] = append(membersByChannel[cid], uid)
	}
	if err := memberRows.Err(); err != nil {
		return nil, err
	}
	for i := range channels {
		channels[i].MemberIDs = membersByChannel[channels[i].ID]
	}
	return channels, nil
}

// --- ListMessagesByChannel ------------------------------------------------

// ListMessagesByChannel returns up to limit messages from channelID with
// seq < beforeSeq, in descending seq order (newest first). beforeSeq=0
// means "from the newest message"; pass int64 max if you want to be
// explicit but the zero-value short-hand is friendlier.
//
// Returns at most limit rows; the caller decides whether fewer than
// limit means "end of history" or "small channel."
//
// SenderDeviceID may be NULL after a phase-12 user purge; we scan into
// a *uuid.UUID and convert to a string at the proto boundary.
func (s *Store) ListMessagesByChannel(ctx context.Context, channelID uuid.UUID, beforeSeq int64, limit int) ([]Message, error) {
	if limit <= 0 {
		limit = 50
	}
	if limit > 200 {
		limit = 200
	}
	// beforeSeq=0 is the natural "from newest" shorthand. Translate
	// to a large sentinel for the query.
	if beforeSeq <= 0 {
		beforeSeq = 1 << 62
	}

	// Phase 9.6i + 10a: LEFT JOIN devices for username, plus a
	// LEFT JOIN over a reply-count subquery so the main feed can
	// render the "N replies" indicator. The reply-count subquery
	// counts only messages that have a parent (parent_id IS NOT
	// NULL); thread heads themselves do not count themselves.
	rows, err := s.Pool.Query(ctx,
		`SELECT m.id, m.channel_id, m.sender_device_id, d.user_id,
		        m.ts, m.seq, m.content_type, m.ciphertext,
		        m.parent_id, m.thread_id,
		        COALESCE(r.cnt, 0) AS reply_count,
		        COALESCE(r.last_seq, 0) AS last_reply_seq,
		        lr_dev.user_id AS last_reply_sender_user_id,
		        lr.ciphertext  AS last_reply_body
		   FROM messages m
		   LEFT JOIN devices d ON d.id = m.sender_device_id
		   LEFT JOIN (
		     SELECT thread_id,
		            COUNT(*)      AS cnt,
		            MAX(seq)      AS last_seq
		       FROM messages
		      WHERE parent_id IS NOT NULL
		      GROUP BY thread_id
		   ) r ON r.thread_id = m.id
		   LEFT JOIN LATERAL (
		     SELECT sender_device_id, ciphertext
		       FROM messages
		      WHERE thread_id = m.id AND parent_id IS NOT NULL
		      ORDER BY seq DESC
		      LIMIT 1
		   ) lr ON true
		   LEFT JOIN devices lr_dev ON lr_dev.id = lr.sender_device_id
		  WHERE m.channel_id = $1 AND m.seq < $2
		  ORDER BY m.seq DESC
		  LIMIT $3`,
		channelID, beforeSeq, limit,
	)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	out := make([]Message, 0, limit)
	for rows.Next() {
		var m Message
		var senderDev *uuid.UUID
		var senderUser *uuid.UUID
		var parentID *uuid.UUID
		var threadID *uuid.UUID
		var replyCount int64
		var lastReplySeq int64
		var lastReplySender *uuid.UUID
		var lastReplyBody []byte
		if err := rows.Scan(
			&m.ID, &m.ChannelID, &senderDev, &senderUser,
			&m.TS, &m.Seq, &m.ContentType, &m.Ciphertext,
			&parentID, &threadID, &replyCount, &lastReplySeq,
			&lastReplySender, &lastReplyBody,
		); err != nil {
			return nil, err
		}
		if senderDev != nil {
			m.SenderDeviceID = *senderDev
		}
		if senderUser != nil {
			m.SenderUserID = *senderUser
		}
		m.ParentID = parentID
		m.ThreadID = threadID
		m.ReplyCount = replyCount
		m.LastReplySeq = lastReplySeq
		m.LastReplySenderUserID = lastReplySender
		m.LastReplyBody = lastReplyBody
		out = append(out, m)
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}
	return out, nil
}

// Phase 10a: ListMessagesByThread returns up to `limit` messages
// where thread_id = $threadID, ordered by seq DESC (newest first).
// Includes the thread head (whose id equals its own thread_id only
// if it had a self-thread row -- but the head's row has thread_id
// NULL in our model; replies have thread_id = head.id). So this
// query returns ONLY the replies. Callers wanting head+replies
// should also fetch the head via GetMessage.
//
// We could store thread_id = self.id on the head too (denormalizing)
// to make a single query return everything; that's a future
// optimization. For now: replies only.
func (s *Store) ListMessagesByThread(
	ctx context.Context,
	channelID, threadID uuid.UUID,
	beforeSeq int64,
	limit int,
) ([]Message, error) {
	if limit <= 0 {
		limit = 50
	}
	if limit > 200 {
		limit = 200
	}
	if beforeSeq <= 0 {
		beforeSeq = 1 << 62
	}
	rows, err := s.Pool.Query(ctx,
		`SELECT m.id, m.channel_id, m.sender_device_id, d.user_id,
		        m.ts, m.seq, m.content_type, m.ciphertext,
		        m.parent_id, m.thread_id
		   FROM messages m
		   LEFT JOIN devices d ON d.id = m.sender_device_id
		  WHERE m.channel_id = $1 AND m.thread_id = $2 AND m.seq < $3
		  ORDER BY m.seq DESC
		  LIMIT $4`,
		channelID, threadID, beforeSeq, limit,
	)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	out := make([]Message, 0, limit)
	for rows.Next() {
		var m Message
		var senderDev *uuid.UUID
		var senderUser *uuid.UUID
		var parentID *uuid.UUID
		var tID *uuid.UUID
		if err := rows.Scan(
			&m.ID, &m.ChannelID, &senderDev, &senderUser,
			&m.TS, &m.Seq, &m.ContentType, &m.Ciphertext,
			&parentID, &tID,
		); err != nil {
			return nil, err
		}
		if senderDev != nil {
			m.SenderDeviceID = *senderDev
		}
		if senderUser != nil {
			m.SenderUserID = *senderUser
		}
		m.ParentID = parentID
		m.ThreadID = tID
		out = append(out, m)
	}
	return out, rows.Err()
}
