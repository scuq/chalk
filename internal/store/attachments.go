package store

import (
	"context"
	"errors"
	"fmt"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
)

// att-1: attachments server core. Encrypted attachment blobs live in their own
// range-partitioned table (see migration 0037). The server is a blind store of
// ciphertext: name/mime/kind live inside enc_meta (E2E), never in columns.
//
// Upload is chunked over HTTP (auth/attachments_http.go) because a multi-MB
// blob cannot ride a single 1 MiB WS frame (proto.MaxFrameBytes). Lifecycle:
//
//	CreateAttachment   -> a row in status='uploading' (declared byte_len, enc_meta,
//	                      optional enc_preview), no ciphertext yet.
//	AppendChunk        -> stage ciphertext chunks in attachment_chunks.
//	FinalizeAttachment -> assemble chunks in seq order, verify length, write
//	                      ciphertext, flip status='complete', clear staged chunks.
//	(send frame)       -> LinkAttachmentsToMessage stamps message_id/message_ts.
//	GetAttachmentForDownload -> member-of-channel authz, returns ciphertext.
//	DeleteOrphanedUploads    -> janitor: prune stale 'uploading' rows + chunks.

// Attachment status values. Mirrors the attachments_status_valid CHECK.
const (
	AttachmentStatusUploading = "uploading"
	AttachmentStatusComplete  = "complete"
	AttachmentStatusOrphaned  = "orphaned"
)

// Attachment errors. Returned by the store methods below and mapped to HTTP
// status codes by auth/attachments_http.go.
var (
	// ErrAttachmentNotFound: no row for the id (or, for download, the requester
	// is not a member of the attachment's channel -- the two are deliberately
	// indistinguishable so non-members can't probe existence).
	ErrAttachmentNotFound = errors.New("attachment not found")
	// ErrAttachmentNotUploading: chunk/finalize targeted a row that is not in
	// the 'uploading' state (already complete, or orphaned).
	ErrAttachmentNotUploading = errors.New("attachment not in uploading state")
	// ErrAttachmentIncomplete: finalize found missing/extra chunks or the
	// assembled length did not match the declared byte_len.
	ErrAttachmentIncomplete = errors.New("attachment chunks incomplete or length mismatch")
	// ErrAttachmentTooLarge: a chunk append would push the staged total past the
	// declared byte_len.
	ErrAttachmentTooLarge = errors.New("attachment exceeds declared length")
	// ErrAttachmentLinkMismatch: a send tried to link attachment ids that did
	// not all satisfy (complete, same channel, unlinked, owned by sender).
	ErrAttachmentLinkMismatch = errors.New("attachment link count mismatch")
)

// Attachment is one row of the attachments table. Ciphertext is populated only
// by GetAttachmentForDownload; the list/ref queries deliberately omit it (the
// heavy blob is fetched separately).
type Attachment struct {
	ID               uuid.UUID
	ChannelID        uuid.UUID
	MessageID        *uuid.UUID // nil while uploading / before send
	MessageTS        *time.Time // nil while uploading / before send
	UploaderDeviceID uuid.UUID
	KeyVersion       int
	ByteLen          int64
	EncMeta          []byte
	EncPreview       []byte // nil for non-image kinds
	PreviewLen       int
	Ciphertext       []byte // download path only; nil elsewhere
	CreatedAt        time.Time
	Status           string
}

// CreateAttachmentInput is the validated input for an upload-init. The HTTP
// layer enforces the size cap, membership, and key-version ceiling BEFORE
// calling this.
type CreateAttachmentInput struct {
	ChannelID        uuid.UUID
	UploaderDeviceID uuid.UUID
	KeyVersion       int
	ByteLen          int64  // declared full ciphertext length
	EncMeta          []byte // required, server-opaque
	EncPreview       []byte // optional (image kinds)
	PreviewLen       int
}

// CreateAttachment inserts a new 'uploading' attachment row and returns it with
// its server-assigned id and created_at. ciphertext stays NULL until the chunks
// are assembled by FinalizeAttachment.
func (s *Store) CreateAttachment(ctx context.Context, in CreateAttachmentInput) (Attachment, error) {
	if in.ChannelID == uuid.Nil {
		return Attachment{}, errors.New("CreateAttachment: channel_id required")
	}
	if in.UploaderDeviceID == uuid.Nil {
		return Attachment{}, errors.New("CreateAttachment: uploader_device_id required")
	}
	if in.KeyVersion < 1 {
		return Attachment{}, errors.New("CreateAttachment: key_version must be >= 1")
	}
	if in.ByteLen <= 0 {
		return Attachment{}, errors.New("CreateAttachment: byte_len must be > 0")
	}
	if len(in.EncMeta) == 0 {
		return Attachment{}, errors.New("CreateAttachment: enc_meta required")
	}
	if in.PreviewLen < 0 {
		return Attachment{}, errors.New("CreateAttachment: preview_len must be >= 0")
	}

	a := Attachment{
		ID:               uuid.New(),
		ChannelID:        in.ChannelID,
		UploaderDeviceID: in.UploaderDeviceID,
		KeyVersion:       in.KeyVersion,
		ByteLen:          in.ByteLen,
		EncMeta:          in.EncMeta,
		EncPreview:       in.EncPreview,
		PreviewLen:       in.PreviewLen,
		Status:           AttachmentStatusUploading,
	}
	err := s.Pool.QueryRow(ctx,
		`INSERT INTO attachments
		   (id, channel_id, uploader_device_id, key_version, byte_len,
		    enc_meta, enc_preview, preview_len, status)
		 VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'uploading')
		 RETURNING created_at`,
		a.ID, a.ChannelID, a.UploaderDeviceID, a.KeyVersion, a.ByteLen,
		a.EncMeta, a.EncPreview, a.PreviewLen,
	).Scan(&a.CreatedAt)
	if err != nil {
		return Attachment{}, fmt.Errorf("insert attachment: %w", err)
	}
	return a, nil
}

// loadAttachmentForOwner loads an attachment by id and verifies ownerUserID
// owns its uploader_device_id. Gates chunk-append and finalize so only the
// original uploader can drive their own upload session. Returns
// ErrAttachmentNotFound when the id is unknown OR not owned by ownerUserID.
//
// The lookup is by id alone (served by attachments_id index across partitions);
// the row was created moments earlier so it is in the current partition.
func (s *Store) loadAttachmentForOwner(ctx context.Context, tx pgx.Tx, id, ownerUserID uuid.UUID) (Attachment, error) {
	var a Attachment
	err := tx.QueryRow(ctx,
		`SELECT a.id, a.channel_id, a.uploader_device_id, a.key_version,
		        a.byte_len, a.created_at, a.status
		   FROM attachments a
		   JOIN devices d ON d.id = a.uploader_device_id
		  WHERE a.id = $1 AND d.user_id = $2`,
		id, ownerUserID,
	).Scan(&a.ID, &a.ChannelID, &a.UploaderDeviceID, &a.KeyVersion,
		&a.ByteLen, &a.CreatedAt, &a.Status)
	if errors.Is(err, pgx.ErrNoRows) {
		return Attachment{}, ErrAttachmentNotFound
	}
	if err != nil {
		return Attachment{}, err
	}
	return a, nil
}

// AppendChunk stages one ciphertext chunk for an in-progress upload. seq is the
// 0-based chunk index; out-of-order arrival is fine (assembly orders by seq).
// Idempotent per (attachment_id, seq): a re-PUT of the same seq is a no-op.
// Rejects a chunk that would push the staged total past the declared byte_len.
func (s *Store) AppendChunk(ctx context.Context, id, ownerUserID uuid.UUID, seq int, data []byte) error {
	if seq < 0 {
		return errors.New("AppendChunk: seq must be >= 0")
	}
	if len(data) == 0 {
		return errors.New("AppendChunk: empty chunk")
	}
	return s.withTx(ctx, func(tx pgx.Tx) error {
		a, err := s.loadAttachmentForOwner(ctx, tx, id, ownerUserID)
		if err != nil {
			return err
		}
		if a.Status != AttachmentStatusUploading {
			return ErrAttachmentNotUploading
		}
		// Bound the staged total against the declared length so a client can't
		// overflow the cap by uploading more bytes than it declared at init.
		var staged int64
		if err := tx.QueryRow(ctx,
			`SELECT COALESCE(SUM(octet_length(data)), 0)
			   FROM attachment_chunks WHERE attachment_id = $1`,
			id,
		).Scan(&staged); err != nil {
			return fmt.Errorf("sum staged chunks: %w", err)
		}
		if staged+int64(len(data)) > a.ByteLen {
			return ErrAttachmentTooLarge
		}
		if _, err := tx.Exec(ctx,
			`INSERT INTO attachment_chunks (attachment_id, seq, data)
			 VALUES ($1, $2, $3)
			 ON CONFLICT (attachment_id, seq) DO NOTHING`,
			id, seq, data,
		); err != nil {
			return fmt.Errorf("insert chunk: %w", err)
		}
		return nil
	})
}

// FinalizeAttachment assembles the staged chunks into attachments.ciphertext,
// verifies they are contiguous (seq 0..N-1) and sum to the declared byte_len,
// flips status to 'complete', and clears the staged rows -- all in one tx.
// Idempotent: finalizing an already-complete attachment returns it unchanged.
func (s *Store) FinalizeAttachment(ctx context.Context, id, ownerUserID uuid.UUID) (Attachment, error) {
	var out Attachment
	err := s.withTx(ctx, func(tx pgx.Tx) error {
		a, err := s.loadAttachmentForOwner(ctx, tx, id, ownerUserID)
		if err != nil {
			return err
		}
		if a.Status == AttachmentStatusComplete {
			out = a // idempotent: already assembled
			return nil
		}
		if a.Status != AttachmentStatusUploading {
			return ErrAttachmentNotUploading
		}

		var (
			cnt       int64
			maxSeq    int64
			total     int64
			assembled []byte
		)
		// string_agg(bytea, bytea ORDER BY seq) concatenates the chunks in seq
		// order. COUNT/MAX/SUM let us prove contiguity and total length.
		if err := tx.QueryRow(ctx,
			`SELECT COUNT(*),
			        COALESCE(MAX(seq), -1),
			        COALESCE(SUM(octet_length(data)), 0),
			        COALESCE(string_agg(data, ''::bytea ORDER BY seq), ''::bytea)
			   FROM attachment_chunks WHERE attachment_id = $1`,
			id,
		).Scan(&cnt, &maxSeq, &total, &assembled); err != nil {
			return fmt.Errorf("assemble chunks: %w", err)
		}
		// Contiguous from 0 means max(seq) == count-1 (the PK already forbids
		// duplicate seqs), and the assembled bytes must match the declared len.
		if cnt == 0 || maxSeq != cnt-1 {
			return ErrAttachmentIncomplete
		}
		if total != a.ByteLen {
			return ErrAttachmentIncomplete
		}

		ct, err := tx.Exec(ctx,
			`UPDATE attachments
			    SET ciphertext = $2, status = 'complete'
			  WHERE id = $1 AND status = 'uploading'`,
			id, assembled,
		)
		if err != nil {
			return fmt.Errorf("write ciphertext: %w", err)
		}
		if ct.RowsAffected() != 1 {
			// Lost a race (someone else finalized/orphaned): treat as wrong state.
			return ErrAttachmentNotUploading
		}
		if _, err := tx.Exec(ctx,
			`DELETE FROM attachment_chunks WHERE attachment_id = $1`, id,
		); err != nil {
			return fmt.Errorf("clear staged chunks: %w", err)
		}

		a.Status = AttachmentStatusComplete
		a.ByteLen = total
		out = a
		return nil
	})
	if err != nil {
		return Attachment{}, err
	}
	return out, nil
}

// GetAttachmentForDownload returns a completed attachment (including ciphertext)
// ONLY when requesterUserID is a member of the attachment's channel. A
// non-member -- or a missing/incomplete row -- gets ErrAttachmentNotFound, so
// the server refuses ciphertext to non-members without leaking existence
// (defense in depth; a removed member also can't decrypt, having no key).
func (s *Store) GetAttachmentForDownload(ctx context.Context, id, requesterUserID uuid.UUID) (Attachment, error) {
	var a Attachment
	err := s.Pool.QueryRow(ctx,
		`SELECT a.id, a.channel_id, a.message_id, a.message_ts,
		        a.uploader_device_id, a.key_version, a.byte_len,
		        a.enc_meta, a.preview_len, a.created_at, a.status, a.ciphertext
		   FROM attachments a
		  WHERE a.id = $1
		    AND a.status = 'complete'
		    AND EXISTS (
		      SELECT 1 FROM channel_members cm
		       WHERE cm.channel_id = a.channel_id AND cm.user_id = $2
		    )`,
		id, requesterUserID,
	).Scan(&a.ID, &a.ChannelID, &a.MessageID, &a.MessageTS,
		&a.UploaderDeviceID, &a.KeyVersion, &a.ByteLen,
		&a.EncMeta, &a.PreviewLen, &a.CreatedAt, &a.Status, &a.Ciphertext)
	if errors.Is(err, pgx.ErrNoRows) {
		return Attachment{}, ErrAttachmentNotFound
	}
	if err != nil {
		return Attachment{}, err
	}
	return a, nil
}

// scanAttachmentListRows scans the shared 12-column "list shape" (everything
// except ciphertext) used by both ListAttachmentsForChannelWindow and
// ListAttachmentRefsForMessage. Keeping the column set + scan in one place keeps
// SELECT<->Scan parity from drifting between the two callers.
func scanAttachmentListRows(rows pgx.Rows) ([]Attachment, error) {
	defer rows.Close()
	out := make([]Attachment, 0, 16)
	for rows.Next() {
		var a Attachment
		if err := rows.Scan(
			&a.ID, &a.ChannelID, &a.MessageID, &a.MessageTS,
			&a.UploaderDeviceID, &a.KeyVersion, &a.ByteLen,
			&a.EncMeta, &a.EncPreview, &a.PreviewLen, &a.CreatedAt, &a.Status,
		); err != nil {
			return nil, err
		}
		out = append(out, a)
	}
	return out, rows.Err()
}

// attachmentListColumns is the column list backing scanAttachmentListRows. Both
// list queries embed this verbatim; the comment above scanAttachmentListRows
// explains why they must stay in lockstep.
const attachmentListColumns = `a.id, a.channel_id, a.message_id, a.message_ts,
	        a.uploader_device_id, a.key_version, a.byte_len,
	        a.enc_meta, a.enc_preview, a.preview_len, a.created_at, a.status`

// ListAttachmentsForChannelWindow returns completed, message-linked attachments
// for a channel whose created_at is within the lookback window (since), newest
// first. Includes the small enc_preview (eager feed render) but never the heavy
// ciphertext. Returns nothing if requesterUserID is not a member of the channel
// (the EXISTS gate). This is the CHALK_ATTACH_FETCH_WINDOW_HOURS query: it
// bounds the eager backfetch; scrolling further back fetches older partitions
// lazily (att-2).
func (s *Store) ListAttachmentsForChannelWindow(
	ctx context.Context,
	channelID, requesterUserID uuid.UUID,
	since time.Time,
	limit int,
) ([]Attachment, error) {
	if limit <= 0 {
		limit = 200
	}
	if limit > 1000 {
		limit = 1000
	}
	rows, err := s.Pool.Query(ctx,
		`SELECT `+attachmentListColumns+`
		   FROM attachments a
		  WHERE a.channel_id = $1
		    AND a.status = 'complete'
		    AND a.message_id IS NOT NULL
		    AND a.created_at >= $2
		    AND EXISTS (
		      SELECT 1 FROM channel_members cm
		       WHERE cm.channel_id = a.channel_id AND cm.user_id = $3
		    )
		  ORDER BY a.created_at DESC
		  LIMIT $4`,
		channelID, since, requesterUserID, limit,
	)
	if err != nil {
		return nil, err
	}
	return scanAttachmentListRows(rows)
}

// ListAttachmentRefsForMessage returns the completed attachments linked to one
// message, oldest first. Used to attach refs to a live message push. Cheap
// indexed probe (attachments_message_idx); returns an empty slice for the
// common attachment-less message.
func (s *Store) ListAttachmentRefsForMessage(ctx context.Context, messageID uuid.UUID) ([]Attachment, error) {
	rows, err := s.Pool.Query(ctx,
		`SELECT `+attachmentListColumns+`
		   FROM attachments a
		  WHERE a.message_id = $1 AND a.status = 'complete'
		  ORDER BY a.created_at ASC`,
		messageID,
	)
	if err != nil {
		return nil, err
	}
	return scanAttachmentListRows(rows)
}

// LinkAttachmentsToMessage stamps message_id/message_ts onto the given
// attachment ids, inside the caller's send transaction. An id is linked only if
// it is complete, in channelID, not already linked, and owned by ownerUserID's
// device. If any id fails those predicates the update count won't match and
// ErrAttachmentLinkMismatch is returned, so the whole send rolls back (refs link
// atomically with the message or not at all). attachmentIDs must be de-duplicated
// by the caller; the per-message count cap is enforced by the caller too.
func (s *Store) LinkAttachmentsToMessage(
	ctx context.Context,
	tx pgx.Tx,
	channelID, messageID uuid.UUID,
	messageTS time.Time,
	ownerUserID uuid.UUID,
	attachmentIDs []uuid.UUID,
) error {
	if len(attachmentIDs) == 0 {
		return nil
	}
	ct, err := tx.Exec(ctx,
		`UPDATE attachments a
		    SET message_id = $2, message_ts = $3
		   FROM devices d
		  WHERE a.id = ANY($1)
		    AND a.channel_id = $4
		    AND a.status = 'complete'
		    AND a.message_id IS NULL
		    AND d.id = a.uploader_device_id
		    AND d.user_id = $5`,
		attachmentIDs, messageID, messageTS, channelID, ownerUserID,
	)
	if err != nil {
		return fmt.Errorf("link attachments: %w", err)
	}
	if ct.RowsAffected() != int64(len(attachmentIDs)) {
		return ErrAttachmentLinkMismatch
	}
	return nil
}

// DeleteOrphanedUploads hard-deletes 'uploading' attachment rows older than
// olderThan, plus their staged chunks. Returns how many attachment rows were
// removed. Reclaims space from upload sessions that never finalized/sent. A
// hard delete (rather than marking 'orphaned') is what actually reclaims the
// bytea; the 'orphaned' status remains in the schema for future/manual use.
func (s *Store) DeleteOrphanedUploads(ctx context.Context, olderThan time.Time) (int64, error) {
	var n int64
	err := s.withTx(ctx, func(tx pgx.Tx) error {
		rows, err := tx.Query(ctx,
			`SELECT id FROM attachments
			  WHERE status = 'uploading' AND created_at < $1`,
			olderThan,
		)
		if err != nil {
			return err
		}
		var ids []uuid.UUID
		for rows.Next() {
			var id uuid.UUID
			if err := rows.Scan(&id); err != nil {
				rows.Close()
				return err
			}
			ids = append(ids, id)
		}
		rows.Close()
		if err := rows.Err(); err != nil {
			return err
		}
		if len(ids) == 0 {
			return nil
		}
		if _, err := tx.Exec(ctx,
			`DELETE FROM attachment_chunks WHERE attachment_id = ANY($1)`, ids,
		); err != nil {
			return err
		}
		ct, err := tx.Exec(ctx,
			`DELETE FROM attachments WHERE id = ANY($1) AND status = 'uploading'`, ids,
		)
		if err != nil {
			return err
		}
		n = ct.RowsAffected()
		return nil
	})
	return n, err
}

// OrphanAttachmentJanitorLoop runs DeleteOrphanedUploads once immediately and
// then every interval until ctx is canceled, pruning 'uploading' rows older than
// ttl. Errors are logged, not fatal -- a failed sweep must not bring chalkd down
// (same posture as the partition + presence loops).
func (s *Store) OrphanAttachmentJanitorLoop(
	ctx context.Context,
	interval, ttl time.Duration,
	logf func(string, ...any),
) {
	if logf == nil {
		logf = func(string, ...any) {}
	}
	if interval <= 0 {
		interval = time.Hour
	}
	if ttl <= 0 {
		ttl = 24 * time.Hour
	}
	sweep := func() {
		cctx, cancel := context.WithTimeout(ctx, 30*time.Second)
		defer cancel()
		n, err := s.DeleteOrphanedUploads(cctx, time.Now().UTC().Add(-ttl))
		if err != nil {
			logf("attachment janitor: %v", err)
			return
		}
		if n > 0 {
			logf("attachment janitor: pruned %d stale upload(s)", n)
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

// EnsureDeviceForUser upserts a minimal device row bound to userID, rebinding on
// conflict (same semantics as the WS hello-time ensure in package server). att-1:
// the chunked HTTP upload runs outside the WS, so it needs its own device-ensure
// to bind the client-supplied device_id to the session user before an attachment
// records its uploader_device_id. device_id is non-secret; the session cookie on
// the request is what gates access, and it's already validated by the time we're
// here.
func (s *Store) EnsureDeviceForUser(ctx context.Context, deviceID, userID uuid.UUID) error {
	_, err := s.Pool.Exec(ctx,
		`INSERT INTO devices (id, user_id, device_type, device_label)
		 VALUES ($1, $2, 'browser-unknown', 'att-1-upload')
		 ON CONFLICT (id) DO UPDATE
		   SET user_id = EXCLUDED.user_id, last_seen = now()
		   WHERE devices.user_id IS DISTINCT FROM EXCLUDED.user_id`,
		deviceID, userID,
	)
	if err != nil {
		return fmt.Errorf("ensure device: %w", err)
	}
	return nil
}
