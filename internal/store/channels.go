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
	// CurrentKeyVersion is the channel's current space-key version (phase 25).
	// Defaults to 1; advanced by a creator-only rotation. Clients encrypt new
	// messages under this version.
	CurrentKeyVersion int
	// RotationPending is true when a member was removed but the key hasn't been
	// rotated yet (removal sets it; the next rotation clears it). Surfaced so the
	// pending revocation is visible.
	RotationPending bool
	// GovernanceMode is the channel's governance mode ("dictator"|"democratic",
	// gov-1a). Surfaced in the summary so the client can render the mode and
	// gate unilateral vs proposal-based actions (gov-2).
	GovernanceMode string
	// ChannelType is 'text' (default) or 'voice' (a Discord-style voice room,
	// 30-1). Voice channels reuse membership/governance/keys; live occupancy
	// lives in voice_participants (store/voice.go).
	ChannelType string
	// GroupName is the creator's roster-grouping suggestion (54-2). Set once
	// at creation, never updated: per-user regrouping happens client-side in
	// prefs. 'General' for pre-54 channels and DMs.
	GroupName string
}

// ChannelWithMembers couples a Channel with its full member set.
// Used by ListChannelsForUser, which needs both for the wire summary.
type ChannelWithMembers struct {
	Channel
	MemberIDs []uuid.UUID
	// LastSeq is the highest seq assigned in this channel (0 when empty).
	// Phase 33-1: paired with LastReadSeq it gives the client an unread
	// indicator without loading any history.
	LastSeq int64
	// LastReadSeq is the read cursor of the user this listing was built
	// for. Zero for listings not scoped to a user (e.g. a create ack,
	// where the channel is empty anyway).
	LastReadSeq int64
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

// ErrBadChannelType is returned when a create names a channel_type outside
// {'text','voice'} (30-1).
var ErrBadChannelType = errors.New("channel_type must be 'text' or 'voice'")

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
	// ChannelType is 'text' or 'voice'; empty means 'text' (30-1). A DM
	// cannot be a voice channel.
	ChannelType string
	// GroupName is the roster-grouping suggestion (54-2). Empty means
	// 'General'. Trimmed; same 80-char cap as the channel name.
	GroupName string
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

	// 30-1: normalize + fence the channel type. Empty means 'text' so every
	// pre-30 caller is unchanged; a DM voice room makes no sense (a DM is a
	// text surface; voice needs a joinable room).
	channelType := strings.TrimSpace(in.ChannelType)
	if channelType == "" {
		channelType = "text"
	}
	if channelType != "text" && channelType != "voice" {
		return ChannelWithMembers{}, fmt.Errorf("%w: got %q", ErrBadChannelType, in.ChannelType)
	}
	if in.IsDM && channelType == "voice" {
		return ChannelWithMembers{}, fmt.Errorf("%w: a DM cannot be a voice channel", ErrBadChannelType)
	}

	// 54-2: normalize the group suggestion. Empty means the default group so
	// every pre-54 caller (and the DM path, which never sends one) lands in
	// 'General' -- matching the migration DEFAULT for existing rows.
	groupName := strings.TrimSpace(in.GroupName)
	if groupName == "" {
		groupName = "General"
	}
	if len(groupName) > 80 {
		return ChannelWithMembers{}, errors.New("group_name too long (max 80)")
	}

	var result ChannelWithMembers
	// gov-1a: seed this channel's governance columns from the server-wide
	// defaults captured at startup (withDefaults fills any zero field, so a
	// directly-constructed Store still yields a valid channel). The migration
	// column DEFAULTs match these; seeding explicitly is what makes a changed
	// CHALK_VOTE_* env affect channels created AFTERWARD.
	gd := s.GovDefaults.withDefaults()
	err := s.withTx(ctx, func(tx pgx.Tx) error {
		// 1. Insert channel.
		var ch Channel
		err := tx.QueryRow(ctx,
			`INSERT INTO channels
			   (name, is_dm, created_by,
			    governance_mode, vote_window_days, vote_expiry_hours, min_eligible,
			    quorum_percent, pass_percent, supermajority_percent, repropose_cooldown_hours,
			    channel_type, group_name)
			 VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)
			 RETURNING id, name, is_dm, created_by, created_at, current_key_version, rotation_pending, governance_mode, channel_type, group_name`,
			strings.TrimSpace(in.Name), in.IsDM, in.CreatedBy,
			gd.Mode, gd.VoteWindowDays, gd.VoteExpiryHours, gd.MinEligible,
			gd.QuorumPercent, gd.PassPercent, gd.SupermajorityPercent, gd.ReproposeCooldownHours,
			channelType, groupName,
		).Scan(&ch.ID, &ch.Name, &ch.IsDM, &ch.CreatedBy, &ch.CreatedAt, &ch.CurrentKeyVersion, &ch.RotationPending, &ch.GovernanceMode, &ch.ChannelType, &ch.GroupName)
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
		`SELECT id, name, is_dm, created_by, created_at, current_key_version, rotation_pending, governance_mode, channel_type, group_name
		   FROM channels WHERE id = $1`,
		channelID,
	).Scan(&ch.ID, &ch.Name, &ch.IsDM, &ch.CreatedBy, &ch.CreatedAt, &ch.CurrentKeyVersion, &ch.RotationPending, &ch.GovernanceMode, &ch.ChannelType, &ch.GroupName)
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
//  1. list channel rows
//  2. bulk-fetch all members for those channel IDs in a single IN()
//
// Keeping the queries plain reads better than a single clever join,
// and the member-count cardinality is small (a few users per channel).
func (s *Store) ListChannelsForUser(ctx context.Context, userID uuid.UUID) ([]ChannelWithMembers, error) {
	rows, err := s.Pool.Query(ctx,
		`SELECT c.id, c.name, c.is_dm, c.created_by, c.created_at, c.current_key_version, c.rotation_pending, c.governance_mode, c.channel_type, c.group_name,
		        GREATEST(COALESCE(cs.next_seq, 1) - 1, 0), COALESCE(cr.last_read_seq, 0)
		   FROM channels c
		   JOIN channel_members cm ON cm.channel_id = c.id
		   LEFT JOIN channel_seq cs ON cs.channel_id = c.id
		   LEFT JOIN channel_reads cr ON cr.channel_id = c.id AND cr.user_id = $1
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
		var lastSeq, lastReadSeq int64
		if err := rows.Scan(&c.ID, &c.Name, &c.IsDM, &c.CreatedBy, &c.CreatedAt, &c.CurrentKeyVersion, &c.RotationPending, &c.GovernanceMode, &c.ChannelType, &c.GroupName, &lastSeq, &lastReadSeq); err != nil {
			return nil, err
		}
		channels = append(channels, ChannelWithMembers{Channel: c, LastSeq: lastSeq, LastReadSeq: lastReadSeq})
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
// viewerID is whose thread read cursors decorate the rows. Pass uuid.Nil for a
// viewerless read; every thread then reports as unread and uninvolved.
func (s *Store) ListMessagesByChannel(ctx context.Context, channelID, viewerID uuid.UUID, beforeSeq int64, limit int) ([]Message, error) {
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

	// Phase 9.6i: LEFT JOIN devices for username.
	//
	// 42-3: the thread decoration used to be a GROUP BY over messages with no
	// channel filter and no ts bound -- a sequential scan plus group-by of
	// EVERY monthly partition, run to decorate at most 200 rows, on every
	// history page load -- plus a LATERAL re-finding the newest reply. Both are
	// now a single-row lookup in thread_activity, and the newest reply's body
	// is a (ts, id) PRIMARY-KEY probe: ta.last_reply_ts is stored precisely so
	// this join prunes to one partition instead of scanning all of them.
	//
	// The last reply's sender comes from ta.last_reply_sender_id, resolved at
	// write time, so the devices join it used to need is gone too.
	//
	// thread_reads rides along here on purpose: the viewer's cursor arrives
	// with the row it decorates, so the client never needs a bulk "every thread
	// cursor I hold" sync -- hydration is bounded by the page, not by every
	// thread the user has ever touched.
	rows, err := s.Pool.Query(ctx,
		`SELECT m.id, m.channel_id, m.sender_device_id, d.user_id,
		        m.ts, m.seq, m.body, m.key_version,
		        m.deleted_at, m.deleted_by, m.edited_at,
		        m.parent_id, m.thread_id,
		        COALESCE(ta.reply_count, 0)    AS reply_count,
		        COALESCE(ta.last_reply_seq, 0) AS last_reply_seq,
		        ta.last_reply_sender_id        AS last_reply_sender_user_id,
		        lr.body                        AS last_reply_body,
		        lr.key_version                 AS last_reply_key_version,
		        COALESCE(tr.last_read_seq, 0)  AS thread_last_read_seq,
		        COALESCE(tr.involved, FALSE)   AS thread_involved
		   FROM messages m
		   LEFT JOIN devices d ON d.id = m.sender_device_id
		   LEFT JOIN thread_activity ta ON ta.thread_id = m.id
		   LEFT JOIN messages lr
		          ON lr.ts = ta.last_reply_ts AND lr.id = ta.last_reply_id
		   LEFT JOIN thread_reads tr
		          ON tr.user_id = $4 AND tr.thread_id = m.id
		  WHERE m.channel_id = $1 AND m.seq < $2
		  ORDER BY m.seq DESC
		  LIMIT $3`,
		channelID, beforeSeq, limit, viewerID,
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
		var lastReplyKeyVersion *int
		var deletedAt *time.Time
		var deletedBy *uuid.UUID
		var editedAt *time.Time
		if err := rows.Scan(
			&m.ID, &m.ChannelID, &senderDev, &senderUser,
			&m.TS, &m.Seq, &m.Body, &m.KeyVersion,
			&deletedAt, &deletedBy, &editedAt,
			&parentID, &threadID, &replyCount, &lastReplySeq,
			&lastReplySender, &lastReplyBody, &lastReplyKeyVersion,
			&m.ThreadLastReadSeq, &m.ThreadInvolved,
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
		m.LastReplyKeyVersion = lastReplyKeyVersion
		m.DeletedAt = deletedAt
		m.DeletedBy = deletedBy
		m.EditedAt = editedAt
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
		        m.ts, m.seq, m.body, m.key_version,
		        m.deleted_at, m.deleted_by, m.edited_at,
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
		var deletedAt *time.Time
		var deletedBy *uuid.UUID
		var editedAt *time.Time
		if err := rows.Scan(
			&m.ID, &m.ChannelID, &senderDev, &senderUser,
			&m.TS, &m.Seq, &m.Body, &m.KeyVersion,
			&deletedAt, &deletedBy, &editedAt,
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
		m.DeletedAt = deletedAt
		m.DeletedBy = deletedBy
		m.EditedAt = editedAt
		out = append(out, m)
	}
	return out, rows.Err()
}

// ListMembersForChannel returns every user_id in channel_members
// for the given channel. Used by phase 11c-1 PR 5 to determine the
// fan-out set for live mls_commit_event broadcast (each commit must
// reach every current member's connected devices).
//
// Returns an empty slice (not nil) if the channel has no members
// or doesn't exist.
func (s *Store) ListMembersForChannel(
	ctx context.Context,
	channelID uuid.UUID,
) ([]uuid.UUID, error) {
	rows, err := s.Pool.Query(ctx,
		`SELECT user_id FROM channel_members WHERE channel_id = $1`,
		channelID,
	)
	if err != nil {
		return nil, fmt.Errorf("query channel_members: %w", err)
	}
	defer rows.Close()
	out := make([]uuid.UUID, 0)
	for rows.Next() {
		var uid uuid.UUID
		if err := rows.Scan(&uid); err != nil {
			return nil, fmt.Errorf("scan channel_member: %w", err)
		}
		out = append(out, uid)
	}
	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("rows.Err channel_members: %w", err)
	}
	return out, nil
}

// CurrentKeyVersion returns a channel's current space-key version (phase 25).
// Cheap lookup used by the send gate to reject a key_version above current.
func (s *Store) CurrentKeyVersion(ctx context.Context, channelID uuid.UUID) (int, error) {
	var v int
	err := s.Pool.QueryRow(ctx,
		`SELECT current_key_version FROM channels WHERE id = $1`,
		channelID,
	).Scan(&v)
	if errors.Is(err, pgx.ErrNoRows) {
		return 0, ErrChannelNotFound
	}
	if err != nil {
		return 0, err
	}
	return v, nil
}

// AdvanceChannelKeyVersion advances a channel's current_key_version to
// newVersion, but ONLY when the caller is the channel creator AND newVersion is
// exactly current+1 (monotonic, no skips). All three conditions are enforced in
// a single atomic UPDATE, so concurrent rotations can't race past each other:
// at most one advance to a given version succeeds. Returns true iff the row was
// advanced. A false return means: not the creator, a stale expected version, or
// the channel is gone -- the caller can disambiguate by loading the channel.
//
// This is the authoritative version bump, applied AFTER the creator has
// uploaded the new-version wraps via publish_channel_key (phase 25).
func (s *Store) AdvanceChannelKeyVersion(
	ctx context.Context,
	channelID, callerID uuid.UUID,
	newVersion int,
) (bool, error) {
	tag, err := s.Pool.Exec(ctx,
		`UPDATE channels
		    SET current_key_version = $3,
		        rotation_pending = FALSE
		  WHERE id = $1
		    AND created_by = $2
		    AND current_key_version = $3 - 1`,
		channelID, callerID, newVersion,
	)
	if err != nil {
		return false, err
	}
	return tag.RowsAffected() == 1, nil
}

// ErrCannotRemoveOwner is returned when a removal targets the channel owner.
var ErrCannotRemoveOwner = errors.New("cannot remove the channel owner")

// ErrDMNoRemoval is returned when a removal targets a DM channel (the DM
// cardinality trigger would reject the delete anyway; we check first for a
// clean error).
var ErrDMNoRemoval = errors.New("cannot remove members from a DM")

// GetMemberRole returns a member's role in a channel ("owner" | "member"), or
// ErrNotAMember if the user is not a member.
func (s *Store) GetMemberRole(ctx context.Context, channelID, userID uuid.UUID) (string, error) {
	var role string
	err := s.Pool.QueryRow(ctx,
		`SELECT role FROM channel_members WHERE channel_id = $1 AND user_id = $2`,
		channelID, userID,
	).Scan(&role)
	if errors.Is(err, pgx.ErrNoRows) {
		return "", ErrNotAMember
	}
	if err != nil {
		return "", err
	}
	return role, nil
}

// RemoveMember deletes (channelID, targetID) from channel_members and, in the
// same transaction, sets channels.rotation_pending = TRUE so the channel key
// gets rotated (the removed member must lose read access to future messages).
// Rejects removal from a DM up front (ErrDMNoRemoval) and removal of the owner
// (ErrCannotRemoveOwner). Removing a non-member returns ErrNotAMember.
func (s *Store) RemoveMember(ctx context.Context, channelID, targetID uuid.UUID) error {
	return s.withTx(ctx, func(tx pgx.Tx) error {
		var isDM bool
		if err := tx.QueryRow(ctx,
			`SELECT is_dm FROM channels WHERE id = $1`, channelID,
		).Scan(&isDM); err != nil {
			if errors.Is(err, pgx.ErrNoRows) {
				return ErrChannelNotFound
			}
			return err
		}
		if isDM {
			return ErrDMNoRemoval
		}
		var role string
		if err := tx.QueryRow(ctx,
			`SELECT role FROM channel_members WHERE channel_id = $1 AND user_id = $2`,
			channelID, targetID,
		).Scan(&role); err != nil {
			if errors.Is(err, pgx.ErrNoRows) {
				return ErrNotAMember
			}
			return err
		}
		if role == "owner" {
			return ErrCannotRemoveOwner
		}
		tag, err := tx.Exec(ctx,
			`DELETE FROM channel_members WHERE channel_id = $1 AND user_id = $2`,
			channelID, targetID,
		)
		if err != nil {
			return err
		}
		if tag.RowsAffected() == 0 {
			return ErrNotAMember
		}
		// Scrub the removed member's key wraps at ALL versions (not just the
		// current one). Without this, their old-version wraps survive in
		// channel_keys, and re-adding them later would silently restore read
		// access to history from before their removal -- breaking forward-only
		// access. (Forward secrecy of messages they already received is
		// unrecoverable regardless; this removes server-held access going
		// forward and on any future re-add.)
		if _, err := tx.Exec(ctx,
			`DELETE FROM channel_keys WHERE channel_id = $1 AND recipient_id = $2`,
			channelID, targetID,
		); err != nil {
			return err
		}
		if _, err := tx.Exec(ctx,
			`UPDATE channels SET rotation_pending = TRUE WHERE id = $1`, channelID,
		); err != nil {
			return err
		}
		return nil
	})
}

// ErrAlreadyMember is returned when adding a user who is already a member.
var ErrAlreadyMember = errors.New("already a channel member")

// ErrDMNoAdd is returned when an add targets a DM channel (DMs are fixed at 2
// members; the cardinality trigger would reject the insert anyway).
var ErrDMNoAdd = errors.New("cannot add members to a DM")

// AddMember inserts (channelID, userID) into channel_members with role
// "member". Rejects DMs (ErrDMNoAdd) and an existing member (ErrAlreadyMember).
// Unlike removal, adding does NOT touch the key version: the new member gets the
// CURRENT space key wrapped for them by a key holder (client reshareKey), so
// they read from join-time forward; pre-join history stays opaque.
func (s *Store) AddMember(ctx context.Context, channelID, userID uuid.UUID) error {
	return s.withTx(ctx, func(tx pgx.Tx) error {
		var isDM bool
		if err := tx.QueryRow(ctx,
			`SELECT is_dm FROM channels WHERE id = $1`, channelID,
		).Scan(&isDM); err != nil {
			if errors.Is(err, pgx.ErrNoRows) {
				return ErrChannelNotFound
			}
			return err
		}
		if isDM {
			return ErrDMNoAdd
		}
		var exists bool
		if err := tx.QueryRow(ctx,
			`SELECT EXISTS(SELECT 1 FROM channel_members WHERE channel_id = $1 AND user_id = $2)`,
			channelID, userID,
		).Scan(&exists); err != nil {
			return err
		}
		if exists {
			return ErrAlreadyMember
		}
		if _, err := tx.Exec(ctx,
			`INSERT INTO channel_members (channel_id, user_id, role)
			 VALUES ($1, $2, 'member')`,
			channelID, userID,
		); err != nil {
			return err
		}
		// 33-1: start the new member caught up rather than staring at a
		// backlog-sized unread dot for history they just gained access to.
		return seedChannelRead(ctx, tx, channelID, userID)
	})
}
