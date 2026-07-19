package store

// Voice-room occupancy (Phase 30, slice 30-1). voice_participants is the LIVE
// "who is in the room" table (migration 0038): ephemeral session state,
// distinct from channel_members (allowed) and device_presence (online). Rows
// are written on voice_join, removed on voice_leave / WS disconnect (by
// conn_id), and swept by a janitor when their conn is gone (crash path).
//
// 30-1 is store-only: no wire frames, no fan-out (that is 30-2). The methods
// here are the primitives 30-2's handlers call.

import (
	"context"
	"errors"
	"fmt"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
)

// VoiceParticipant is one row of live room occupancy: a (user, device) that is
// currently in a voice channel, plus its broadcast media state (self-mute /
// camera / screen-share flags shown in the roster).
type VoiceParticipant struct {
	ChannelID uuid.UUID
	UserID    uuid.UUID
	DeviceID  uuid.UUID
	ConnID    string
	JoinedAt  time.Time
	Muted     bool
	VideoOn   bool
	ScreenOn  bool
}

// --- Errors ----------------------------------------------------------------

// ErrNotVoiceChannel is returned when a voice operation targets a channel
// whose channel_type is not 'voice'.
var ErrNotVoiceChannel = errors.New("not a voice channel")

// ErrVoiceRoomFull is returned when a join would exceed the mesh hard cap
// (CHALK_VOICE_MAX_PARTICIPANTS). Mesh bandwidth grows ~(N-1) per member, so
// the server refuses rather than letting the room degrade for everyone.
var ErrVoiceRoomFull = errors.New("voice room is full")

// ErrVoiceDeviceConflict is returned when the user is already in the room from
// a DIFFERENT device. v1 rejects the second device (echo/feedback); the PK
// supports multi-device later, at which point this check is dropped.
var ErrVoiceDeviceConflict = errors.New("user already in room from another device")

// --- JoinVoice --------------------------------------------------------------

// JoinVoice puts (userID, deviceID) into channelID's live room and returns the
// resulting roster (including the joiner). All checks and the write happen in
// one transaction with the channel row locked FOR UPDATE, so two concurrent
// joins cannot both pass the capacity check (the same lock-then-check shape as
// the last-passkey guard).
//
// Rules enforced here (design §9):
//   - channel must exist (ErrChannelNotFound) and be channel_type='voice'
//     (ErrNotVoiceChannel). Membership authz is the CALLER's job (30-2 handler
//     checks IsMember before calling, like every other channel op).
//   - same user on a DIFFERENT device already present => ErrVoiceDeviceConflict.
//   - room at maxParticipants => ErrVoiceRoomFull.
//   - same (user, device) re-joining is IDEMPOTENT: the row is refreshed
//     (new conn_id, joined_at=now, media flags reset) rather than rejected --
//     the reconnect path re-clicks join with a fresh WS conn.
func (s *Store) JoinVoice(
	ctx context.Context,
	channelID, userID, deviceID uuid.UUID,
	connID string,
	maxParticipants int,
) ([]VoiceParticipant, error) {
	if connID == "" {
		return nil, errors.New("conn_id required")
	}
	if maxParticipants < 2 {
		return nil, fmt.Errorf("maxParticipants must be >= 2 (got %d)", maxParticipants)
	}

	var roster []VoiceParticipant
	err := s.withTx(ctx, func(tx pgx.Tx) error {
		// 1. Lock the channel row: serializes concurrent joins to this room
		// so the count below cannot race, and verifies the type.
		var chType string
		err := tx.QueryRow(ctx,
			`SELECT channel_type FROM channels WHERE id = $1 FOR UPDATE`,
			channelID,
		).Scan(&chType)
		if errors.Is(err, pgx.ErrNoRows) {
			return ErrChannelNotFound
		}
		if err != nil {
			return fmt.Errorf("lock channel: %w", err)
		}
		if chType != "voice" {
			return ErrNotVoiceChannel
		}

		// 2. Same user, different device already in the room? (v1 rejects.)
		var otherDevice bool
		if err := tx.QueryRow(ctx,
			`SELECT EXISTS(
			   SELECT 1 FROM voice_participants
			    WHERE channel_id = $1 AND user_id = $2 AND device_id <> $3
			 )`,
			channelID, userID, deviceID,
		).Scan(&otherDevice); err != nil {
			return fmt.Errorf("device-conflict check: %w", err)
		}
		if otherDevice {
			return ErrVoiceDeviceConflict
		}

		// 3. Capacity: count OTHER occupants (a same-device rejoin must not
		// count itself toward the cap).
		var occupied int
		if err := tx.QueryRow(ctx,
			`SELECT count(*) FROM voice_participants
			  WHERE channel_id = $1
			    AND NOT (user_id = $2 AND device_id = $3)`,
			channelID, userID, deviceID,
		).Scan(&occupied); err != nil {
			return fmt.Errorf("capacity check: %w", err)
		}
		if occupied >= maxParticipants {
			return ErrVoiceRoomFull
		}

		// 4. Upsert the participant row (idempotent per device; a rejoin
		// refreshes conn binding and resets media flags to the join default).
		if _, err := tx.Exec(ctx,
			`INSERT INTO voice_participants
			   (channel_id, user_id, device_id, conn_id)
			 VALUES ($1, $2, $3, $4)
			 ON CONFLICT (channel_id, user_id, device_id) DO UPDATE
			   SET conn_id   = EXCLUDED.conn_id,
			       joined_at = now(),
			       muted     = false,
			       video_on  = false,
			       screen_on = false`,
			channelID, userID, deviceID, connID,
		); err != nil {
			return fmt.Errorf("insert participant: %w", err)
		}

		// 5. Read back the roster inside the tx (consistent snapshot).
		var rerr error
		roster, rerr = voiceRosterTx(ctx, tx, channelID)
		return rerr
	})
	if err != nil {
		return nil, err
	}
	return roster, nil
}

// --- LeaveVoice -------------------------------------------------------------

// LeaveVoice removes (userID, deviceID) from channelID's live room. Returns
// true if a row was deleted, false if the user wasn't in the room (idempotent:
// leaving twice is not an error).
func (s *Store) LeaveVoice(
	ctx context.Context,
	channelID, userID, deviceID uuid.UUID,
) (bool, error) {
	tag, err := s.Pool.Exec(ctx,
		`DELETE FROM voice_participants
		  WHERE channel_id = $1 AND user_id = $2 AND device_id = $3`,
		channelID, userID, deviceID,
	)
	if err != nil {
		return false, fmt.Errorf("leave voice: %w", err)
	}
	return tag.RowsAffected() > 0, nil
}

// --- VoiceRoster ------------------------------------------------------------

// VoiceRoster returns the live occupants of channelID, oldest joiner first
// (stable ordering for the join handshake: the JOINER offers to every EXISTING
// participant, design §4).
func (s *Store) VoiceRoster(ctx context.Context, channelID uuid.UUID) ([]VoiceParticipant, error) {
	rows, err := s.Pool.Query(ctx,
		`SELECT channel_id, user_id, device_id, conn_id, joined_at, muted, video_on, screen_on
		   FROM voice_participants
		  WHERE channel_id = $1
		  ORDER BY joined_at ASC`,
		channelID,
	)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	return scanVoiceParticipants(rows)
}

// voiceRosterTx is VoiceRoster inside an existing transaction.
func voiceRosterTx(ctx context.Context, tx pgx.Tx, channelID uuid.UUID) ([]VoiceParticipant, error) {
	rows, err := tx.Query(ctx,
		`SELECT channel_id, user_id, device_id, conn_id, joined_at, muted, video_on, screen_on
		   FROM voice_participants
		  WHERE channel_id = $1
		  ORDER BY joined_at ASC`,
		channelID,
	)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	return scanVoiceParticipants(rows)
}

func scanVoiceParticipants(rows pgx.Rows) ([]VoiceParticipant, error) {
	out := make([]VoiceParticipant, 0, 8)
	for rows.Next() {
		var p VoiceParticipant
		if err := rows.Scan(
			&p.ChannelID, &p.UserID, &p.DeviceID, &p.ConnID,
			&p.JoinedAt, &p.Muted, &p.VideoOn, &p.ScreenOn,
		); err != nil {
			return nil, err
		}
		out = append(out, p)
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}
	return out, nil
}

// --- UpdateVoiceState -------------------------------------------------------

// UpdateVoiceState sets the broadcast media flags (self-mute / camera /
// screen-share) for a participant. Returns false when the participant row
// doesn't exist (not in the room) -- the 30-2 handler maps that to an error
// rather than upserting, since state without presence is meaningless.
func (s *Store) UpdateVoiceState(
	ctx context.Context,
	channelID, userID, deviceID uuid.UUID,
	muted, videoOn, screenOn bool,
) (bool, error) {
	tag, err := s.Pool.Exec(ctx,
		`UPDATE voice_participants
		    SET muted = $4, video_on = $5, screen_on = $6
		  WHERE channel_id = $1 AND user_id = $2 AND device_id = $3`,
		channelID, userID, deviceID, muted, videoOn, screenOn,
	)
	if err != nil {
		return false, fmt.Errorf("update voice state: %w", err)
	}
	return tag.RowsAffected() > 0, nil
}

// --- Disconnect cleanup -----------------------------------------------------

// DeleteVoiceParticipantsByConn removes every voice_participants row bound to
// connID (a device can only be in one room per conn, but the schema doesn't
// force that -- delete all). Returns the deleted rows so the caller (the hub
// Unregister path, wired in 30-2) can fan out "left" per room.
func (s *Store) DeleteVoiceParticipantsByConn(
	ctx context.Context,
	connID string,
) ([]VoiceParticipant, error) {
	rows, err := s.Pool.Query(ctx,
		`DELETE FROM voice_participants
		  WHERE conn_id = $1
		  RETURNING channel_id, user_id, device_id, conn_id, joined_at, muted, video_on, screen_on`,
		connID,
	)
	if err != nil {
		return nil, fmt.Errorf("delete by conn: %w", err)
	}
	defer rows.Close()
	return scanVoiceParticipants(rows)
}

// --- Orphan janitor ---------------------------------------------------------

// SweepVoiceOrphans deletes rows older than minAge whose conn_id is NOT in
// liveConnIDs -- rows whose WS died without an Unregister (process crash,
// netsplit). minAge guards the race where a row was just inserted for a conn
// the caller's snapshot hasn't seen yet. An empty liveConnIDs list means "no
// live conns on this instance": every sufficiently old row of THIS sweep's
// view is an orphan. Returns the number of rows removed; the caller decides
// what to fan out (30-2 wires the loop with the hub's live-conn snapshot).
func (s *Store) SweepVoiceOrphans(
	ctx context.Context,
	instancePrefix string,
	liveConnIDs []string,
	minAge time.Duration,
) (int64, error) {
	if liveConnIDs == nil {
		liveConnIDs = []string{}
	}
	// 30-2: conn_id is instance-prefixed; sweep only THIS instance's rows so
	// a multi-instance deploy can't reap another instance's live calls.
	tag, err := s.Pool.Exec(ctx,
		`DELETE FROM voice_participants
		  WHERE joined_at < now() - $3::interval
		    AND conn_id LIKE $2 || '%'
		    AND conn_id <> ALL($1)`,
		liveConnIDs, instancePrefix, minAge.String(),
	)
	if err != nil {
		return 0, fmt.Errorf("sweep voice orphans: %w", err)
	}
	return tag.RowsAffected(), nil
}

// VoiceJanitorLoop runs SweepVoiceOrphans once immediately and then every
// interval until ctx is canceled. liveConns supplies the current live WS
// Conn.IDs (the hub's snapshot; wired in 30-2 -- until then a caller may pass
// nil to skip sweeping entirely). Errors are logged, not fatal, the same
// posture as OrphanAttachmentJanitorLoop.
func (s *Store) VoiceJanitorLoop(
	ctx context.Context,
	instancePrefix string,
	interval, minAge time.Duration,
	liveConns func() []string,
	logf func(string, ...any),
) {
	if logf == nil {
		logf = func(string, ...any) {}
	}
	if liveConns == nil {
		return // nothing to sweep against; 30-2 wires the hub snapshot
	}
	if interval <= 0 {
		interval = time.Minute
	}
	if minAge <= 0 {
		minAge = 2 * time.Minute
	}
	sweep := func() {
		cctx, cancel := context.WithTimeout(ctx, 30*time.Second)
		defer cancel()
		n, err := s.SweepVoiceOrphans(cctx, instancePrefix, liveConns(), minAge)
		if err != nil {
			logf("voice janitor: %v", err)
			return
		}
		if n > 0 {
			logf("voice janitor: pruned %d orphaned participant row(s)", n)
		}
	}
	sweep()
	t := time.NewTicker(interval)
	defer t.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-t.C:
			sweep()
		}
	}
}
