package store

import (
	"context"
	"errors"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
)

// Phase 42-1: thread activity + per-user thread read cursors (migrations 0046,
// 0047).
//
// Two tables, one write path. thread_activity answers "what happened in this
// thread" without aggregating over the partitioned messages table;
// thread_reads answers "how much of it has this user seen", the same way
// channel_reads (0043) does one level up.
//
// As in reads.go, callers are responsible for the membership check; these
// functions only enforce that a cursor stays monotonic and within the thread's
// assigned reply range.

// ErrThreadHeadNotFound is returned by RecordThreadReplyTx when the thread's
// head message is not in messages for the given channel -- a reply whose parent
// chain does not resolve. The WS handler maps it to ErrCodeInvalidParent.
var ErrThreadHeadNotFound = errors.New("thread head not found")

// ErrThreadNotFound is returned by MarkThreadRead when no thread_activity row
// exists for the thread. A thread with no replies is not a thread, so there is
// nothing to have read.
var ErrThreadNotFound = errors.New("thread not found")

// threadActivityBumpSQL advances an existing thread's newest-reply pointers.
//
// The guard is on the whole correlated SET, not per column: a GREATEST() over
// four columns that must agree with each other would happily pair a new seq
// with an old id. A rewind cannot actually happen -- the send transaction holds
// the channel_seq row lock from seq allocation to commit, so within a channel
// seq order IS commit order -- but the guard makes that invariant legible
// instead of load-bearing by accident.
//
// Args: $1 thread, $2 reply id, $3 reply ts, $4 reply seq, $5 sender device.
const threadActivityBumpSQL = `
	UPDATE thread_activity
	   SET last_reply_id        = $2,
	       last_reply_ts        = $3,
	       last_reply_seq       = $4,
	       last_reply_sender_id = (SELECT user_id FROM devices WHERE id = $5),
	       reply_count          = reply_count + 1
	 WHERE thread_id = $1
	   AND last_reply_seq < $4`

// threadActivitySeedSQL creates the row on a thread's FIRST reply. It has to
// read the head from messages to learn head_ts/head_seq, and it looks the head
// up by id alone -- which IS an all-partition scan, because the primary key is
// (ts, id). That is exactly why this is a separate statement rather than one
// ON CONFLICT upsert: the scan then happens once per thread lifetime instead of
// once per reply.
//
// No race: two concurrent first replies to one thread are two sends to one
// channel, serialized by the channel_seq row lock. ON CONFLICT DO NOTHING
// covers a retry.
//
// Args: $1 thread (== head id), $2 reply id, $3 reply ts, $4 reply seq,
// $5 sender device, $6 channel.
const threadActivitySeedSQL = `
	INSERT INTO thread_activity (
	  thread_id, channel_id, head_ts, head_seq, head_sender_id,
	  last_reply_id, last_reply_ts, last_reply_seq, last_reply_sender_id, reply_count
	)
	SELECT h.id, h.channel_id, h.ts, h.seq, hd.user_id,
	       $2, $3, $4, rd.user_id, 1
	  FROM messages h
	  LEFT JOIN devices hd ON hd.id = h.sender_device_id
	  LEFT JOIN devices rd ON rd.id = $5
	 WHERE h.id = $1 AND h.channel_id = $6
	ON CONFLICT (thread_id) DO NOTHING`

// threadHeadInvolvedSQL puts the thread head's author on the hook. Their thread
// existing is the whole point of the feature: someone replied to something they
// wrote, and they should hear about it whether or not they have replied
// themselves.
//
// last_read_seq stays 0 for a fresh row -- the reply that triggered this IS the
// unread thing. Involvement is sticky, so an existing row is only ever raised
// to TRUE; you cannot un-take-part in a conversation.
const threadHeadInvolvedSQL = `
	INSERT INTO thread_reads (user_id, thread_id, channel_id, last_read_seq, involved)
	SELECT ta.head_sender_id, ta.thread_id, ta.channel_id, 0, TRUE
	  FROM thread_activity ta
	 WHERE ta.thread_id = $1 AND ta.head_sender_id IS NOT NULL
	ON CONFLICT (user_id, thread_id) DO UPDATE
	   SET involved = TRUE`

// threadReplyAuthorReadSQL marks the replier involved and caught up in one
// statement, resolving their device to a user inline so the send path does not
// need a second lookup.
//
// Replying is reading -- the rule MarkChannelReadTx applies to channels (33-1),
// one level down. Without it your own reply would come back to your other
// devices as unread.
//
// Args: $1 thread, $2 sender device, $3 reply seq.
const threadReplyAuthorReadSQL = `
	INSERT INTO thread_reads (user_id, thread_id, channel_id, last_read_seq, involved)
	SELECT d.user_id, ta.thread_id, ta.channel_id,
	       LEAST($3::BIGINT, ta.last_reply_seq), TRUE
	  FROM thread_activity ta, devices d
	 WHERE ta.thread_id = $1 AND d.id = $2
	ON CONFLICT (user_id, thread_id) DO UPDATE
	   SET last_read_seq = GREATEST(thread_reads.last_read_seq, EXCLUDED.last_read_seq),
	       involved      = TRUE,
	       updated_at    = now()`

// RecordThreadReplyTx records everything a newly-committed reply implies, inside
// the caller's transaction:
//
//  1. thread_activity gains or advances its row for this thread;
//  2. the thread head's author becomes "involved";
//  3. the replier's own thread cursor advances, and they become involved too.
//
// Called from the WS send handler and from InsertMessage, so the two insert
// paths cannot disagree about thread state.
func RecordThreadReplyTx(
	ctx context.Context, tx pgx.Tx,
	channelID, threadID, replyID, senderDeviceID uuid.UUID,
	replyTS time.Time, replySeq int64,
) error {
	tag, err := tx.Exec(ctx, threadActivityBumpSQL, threadID, replyID, replyTS, replySeq, senderDeviceID)
	if err != nil {
		return err
	}
	if tag.RowsAffected() == 0 {
		seeded, err := tx.Exec(ctx, threadActivitySeedSQL,
			threadID, replyID, replyTS, replySeq, senderDeviceID, channelID)
		if err != nil {
			return err
		}
		if seeded.RowsAffected() == 0 {
			// Two very different situations both land here: the head is not in
			// messages (a bad parent, which must surface as an error), or a row
			// already exists at or past this seq (a replay, which must not).
			// Tell them apart rather than swallowing both.
			var exists bool
			if err := tx.QueryRow(ctx,
				`SELECT EXISTS (SELECT 1 FROM thread_activity WHERE thread_id = $1)`,
				threadID,
			).Scan(&exists); err != nil {
				return err
			}
			if !exists {
				return ErrThreadHeadNotFound
			}
		}
	}

	if _, err := tx.Exec(ctx, threadHeadInvolvedSQL, threadID); err != nil {
		return err
	}
	if _, err := tx.Exec(ctx, threadReplyAuthorReadSQL, threadID, senderDeviceID, replySeq); err != nil {
		return err
	}
	return nil
}

// markThreadReadSQL raises a thread cursor, clamped to the thread's newest reply
// seq and never moving backwards. Args: $1 user, $2 thread, $3 requested seq,
// $4 also-mark-involved.
//
// Both guards are 0043's, for 0043's reasons: the clamp stops a client that
// guesses high from hiding replies it never saw; the GREATEST stops a stale or
// reordered mark from rewinding a cursor another device already advanced.
//
// $4 is true when the caller wrote the reply, false when they merely read it.
// Involvement is sticky -- OR'd in, never cleared.
const markThreadReadSQL = `
	INSERT INTO thread_reads (user_id, thread_id, channel_id, last_read_seq, involved)
	SELECT $1, $2, ta.channel_id, LEAST($3::BIGINT, ta.last_reply_seq), $4
	  FROM thread_activity ta
	 WHERE ta.thread_id = $2
	ON CONFLICT (user_id, thread_id) DO UPDATE
	   SET last_read_seq = GREATEST(thread_reads.last_read_seq, EXCLUDED.last_read_seq),
	       involved      = thread_reads.involved OR EXCLUDED.involved,
	       updated_at    = now()
	RETURNING last_read_seq`

// MarkThreadRead raises the user's cursor for a thread and returns the effective
// cursor after the write. Does not claim involvement: reading a thread you have
// no part in creates the row (so the badge you cleared here is cleared on your
// other devices) without putting you on the hook for it.
//
// Returns ErrThreadNotFound when the thread has no thread_activity row.
func (s *Store) MarkThreadRead(ctx context.Context, threadID, userID uuid.UUID, seq int64) (int64, error) {
	if seq < 0 {
		seq = 0
	}
	var effective int64
	err := s.Pool.QueryRow(ctx, markThreadReadSQL, userID, threadID, seq, false).Scan(&effective)
	if err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return 0, ErrThreadNotFound
		}
		return 0, err
	}
	return effective, nil
}

// MarkThreadReadTx is MarkThreadRead inside a caller's transaction, with
// explicit control over the involvement flag.
func MarkThreadReadTx(ctx context.Context, tx pgx.Tx, threadID, userID uuid.UUID, seq int64, involved bool) error {
	if seq < 0 {
		seq = 0
	}
	var effective int64
	err := tx.QueryRow(ctx, markThreadReadSQL, userID, threadID, seq, involved).Scan(&effective)
	if errors.Is(err, pgx.ErrNoRows) {
		return ErrThreadNotFound
	}
	return err
}

// GetThreadRead returns the user's cursor for one thread. A missing row means
// "never read", which is 0.
func (s *Store) GetThreadRead(ctx context.Context, threadID, userID uuid.UUID) (int64, error) {
	var seq int64
	err := s.Pool.QueryRow(ctx,
		`SELECT last_read_seq FROM thread_reads
		  WHERE user_id = $1 AND thread_id = $2`,
		userID, threadID,
	).Scan(&seq)
	if errors.Is(err, pgx.ErrNoRows) {
		return 0, nil
	}
	if err != nil {
		return 0, err
	}
	return seq, nil
}

// ---- 42-6: the thread inbox ---------------------------------------------

// ThreadInboxRow is one thread the caller should look at. Metadata only, plus
// the two preview ciphertexts -- which the server carries but never opens.
type ThreadInboxRow struct {
	ThreadID  uuid.UUID
	ChannelID uuid.UUID

	HeadSeq      int64
	HeadTS       time.Time
	HeadSenderID *uuid.UUID

	LastReplyID       uuid.UUID
	LastReplySeq      int64
	LastReplyTS       time.Time
	LastReplySenderID *uuid.UUID

	ReplyCount  int64
	LastReadSeq int64
	Involved    bool

	// Previews, filled in by the second query. Body is ciphertext; Deleted
	// means the row is a tombstone, so the client renders a placeholder rather
	// than trying to decrypt an empty body.
	HeadBody            []byte
	HeadKeyVersion      *int
	HeadDeleted         bool
	LastReplyBody       []byte
	LastReplyKeyVersion *int
	LastReplyDeleted    bool
}

// ThreadInboxPage is one page of the inbox plus the totals the badge needs.
//
// The two halves are returned SEPARATELY rather than concatenated, and that is a
// correctness requirement, not presentation. An earlier version appended them
// and only ran the aged half once the active half came up short -- which meant
// that as soon as a user had more live threads than fit on a page, an unread
// thread that had gone quiet became invisible. That is the exact failure this
// feature exists to fix, so the halves are now independent: paginating the
// active list can never suppress the aged one.
type ThreadInboxPage struct {
	// Active: threads with a reply inside the window, involved or not.
	// Paginated by last_reply_ts via beforeTS.
	Active []ThreadInboxRow
	// AgedUnread: threads the caller took part in that have an unread reply and
	// went quiet before the cutoff. Returned only on the first page (there is
	// nothing to page through -- it is bounded by involvement, and it is the
	// tail of the list by construction). Capped at the same limit; when it is
	// truncated UnreadInvolvedTotal is what tells the truth.
	AgedUnread []ThreadInboxRow
	// UnreadInvolvedTotal counts involved threads with an unread reply at ANY
	// age, ignoring every limit here, so the badge stays honest when either
	// list is truncated.
	UnreadInvolvedTotal int
	// HasMoreActive: the active half filled its limit, so there is another page
	// behind the oldest row in it.
	HasMoreActive bool
}

// threadInboxCols is the metadata projection shared by the two halves, hoisted
// so they cannot drift and so the scan has one shape to match (the three-site
// rule has one site to check instead of two).
const threadInboxCols = `
	ta.thread_id, ta.channel_id,
	ta.head_seq, ta.head_ts, ta.head_sender_id,
	ta.last_reply_id, ta.last_reply_seq, ta.last_reply_ts, ta.last_reply_sender_id,
	ta.reply_count,
	COALESCE(tr.last_read_seq, 0) AS last_read_seq,
	COALESCE(tr.involved, FALSE)  AS involved`

// threadInboxActiveSQL is half A: every thread in the caller's channels whose
// newest reply is inside the window, involved or not. This is DISCOVERY -- what
// is alive right now -- and the window is the only reason it is affordable.
//
// Driven off thread_activity_recent_idx: the range predicate on last_reply_ts
// bounds the work to rows in the window rather than to the size of the table,
// and membership is a probe per candidate through channel_members_user_idx.
//
// $1 user, $2 cutoff, $3 pagination bound (exclusive), $4 limit.
const threadInboxActiveSQL = `
	SELECT ` + threadInboxCols + `
	  FROM channel_members cm
	  JOIN thread_activity ta ON ta.channel_id = cm.channel_id
	  LEFT JOIN thread_reads tr
	         ON tr.user_id = cm.user_id AND tr.thread_id = ta.thread_id
	 WHERE cm.user_id = $1
	   AND ta.last_reply_ts >= $2
	   AND ta.last_reply_ts <  $3
	 ORDER BY ta.last_reply_ts DESC
	 LIMIT $4`

// threadInboxAgedSQL is half B: threads the caller TOOK PART IN that have an
// unread reply and went quiet before the cutoff.
//
// This half is what makes the feature safe rather than harmful. The window must
// not be allowed to define unread: a thread that went quiet three days ago with
// a reply you never read has to stay reachable, or this is worse than the bug it
// fixes.
//
// It is also the half that had to be BOUNDED, and involvement is what bounds it.
// "Every thread I could ever see with an unread reply" has no time bound at all
// -- at a thousand threads per channel that is the query this whole design
// exists to avoid. "Every thread I have written in" is a prefix scan of
// thread_reads_involved_idx, bounded by something human: how many conversations
// the caller actually joined.
//
// The channel_members join is NOT redundant with thread_reads.channel_id:
// leaving a channel removes the membership row but leaves the read rows behind,
// and a thread in a channel you were removed from must not surface.
//
// $1 user, $2 cutoff, $3 limit.
const threadInboxAgedSQL = `
	SELECT ` + threadInboxCols + `
	  FROM thread_reads tr
	  JOIN channel_members cm
	    ON cm.channel_id = tr.channel_id AND cm.user_id = tr.user_id
	  JOIN thread_activity ta ON ta.thread_id = tr.thread_id
	 WHERE tr.user_id = $1
	   AND tr.involved
	   AND ta.last_reply_seq > tr.last_read_seq
	   AND ta.last_reply_ts  < $2
	 ORDER BY ta.last_reply_ts DESC
	 LIMIT $3`

// threadInboxUnreadCountSQL is the number behind the badge: involved threads
// with an unread reply, at any age and with no limit.
const threadInboxUnreadCountSQL = `
	SELECT COUNT(*)
	  FROM thread_reads tr
	  JOIN channel_members cm
	    ON cm.channel_id = tr.channel_id AND cm.user_id = tr.user_id
	  JOIN thread_activity ta ON ta.thread_id = tr.thread_id
	 WHERE tr.user_id = $1 AND tr.involved
	   AND ta.last_reply_seq > tr.last_read_seq`

// threadInboxPreviewSQL fetches the preview bodies for a page of threads, as
// (ts, id) PRIMARY-KEY probes against the partitioned messages table.
//
// This is a SEPARATE query on purpose, and the reason is measured. Joining the
// two preview rows into the queries above made the planner hash-join them
// against a FULL sequential scan of the current messages partition -- twice,
// once per preview -- because it was cheaper than a thousand index probes for
// the candidate set it estimated. Fetching them afterwards, for the <=2N rows
// actually on the page, forces the probe and keeps the cost proportional to the
// page rather than to the number of messages on the server.
//
// unnest of two parallel arrays rather than a VALUES list: it is one bound
// parameter pair instead of 2N, so the statement text is stable and gets
// planned once.
//
// $1 timestamps, $2 ids.
const threadInboxPreviewSQL = `
	SELECT m.id, m.body, m.key_version, m.deleted_at
	  FROM unnest($1::timestamptz[], $2::uuid[]) AS v(ts, id)
	  JOIN messages m ON m.ts = v.ts AND m.id = v.id`

// ListThreadInbox answers "which threads should this user look at", as two
// independent queries whose results cannot overlap: every active row has
// last_reply_ts >= cutoff and every aged row has last_reply_ts < cutoff, so
// neither can ever contain the same thread as the other.
//
// beforeTS pages backwards through the active half; pass the zero time for the
// newest page. The aged half comes back with the first page only.
func (s *Store) ListThreadInbox(
	ctx context.Context, userID uuid.UUID, cutoff, beforeTS time.Time, limit int,
) (ThreadInboxPage, error) {
	if limit <= 0 {
		limit = 25
	}
	if limit > 100 {
		limit = 100
	}
	firstPage := beforeTS.IsZero()
	// The zero time means "from the newest"; translate to a bound no row can
	// exceed, the same shorthand ListMessagesByChannel uses for beforeSeq.
	if firstPage {
		beforeTS = time.Now().Add(100 * 365 * 24 * time.Hour)
	}

	var page ThreadInboxPage
	var err error

	page.Active, err = s.queryThreadInbox(ctx, threadInboxActiveSQL, userID, cutoff, beforeTS, limit)
	if err != nil {
		return ThreadInboxPage{}, err
	}
	page.HasMoreActive = len(page.Active) == limit

	// Unconditional on the first page. It must NOT be gated on the active half
	// coming up short: a user with a full page of live threads is exactly the
	// user most likely to have let an older one go unread.
	if firstPage {
		page.AgedUnread, err = s.queryThreadInbox(ctx, threadInboxAgedSQL, userID, cutoff, time.Time{}, limit)
		if err != nil {
			return ThreadInboxPage{}, err
		}
	}

	if err := s.Pool.QueryRow(ctx, threadInboxUnreadCountSQL, userID).Scan(&page.UnreadInvolvedTotal); err != nil {
		return ThreadInboxPage{}, err
	}

	// One preview fetch for both halves, so a page costs one probe round trip
	// regardless of how the rows are grouped. Both slices are filled in place,
	// which is why they are passed rather than concatenated into a copy.
	if err := s.fillThreadPreviews(ctx, page.Active, page.AgedUnread); err != nil {
		return ThreadInboxPage{}, err
	}
	return page, nil
}

// queryThreadInbox runs one half. The aged half takes no pagination bound, so a
// zero beforeTS means "bind only cutoff and limit" -- the two statements differ
// in arity, which is why this switches on it rather than always passing four.
func (s *Store) queryThreadInbox(
	ctx context.Context, sql string, userID uuid.UUID, cutoff, beforeTS time.Time, limit int,
) ([]ThreadInboxRow, error) {
	var rows pgx.Rows
	var err error
	if beforeTS.IsZero() {
		rows, err = s.Pool.Query(ctx, sql, userID, cutoff, limit)
	} else {
		rows, err = s.Pool.Query(ctx, sql, userID, cutoff, beforeTS, limit)
	}
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	out := make([]ThreadInboxRow, 0, limit)
	for rows.Next() {
		var r ThreadInboxRow
		if err := rows.Scan(
			&r.ThreadID, &r.ChannelID,
			&r.HeadSeq, &r.HeadTS, &r.HeadSenderID,
			&r.LastReplyID, &r.LastReplySeq, &r.LastReplyTS, &r.LastReplySenderID,
			&r.ReplyCount, &r.LastReadSeq, &r.Involved,
		); err != nil {
			return nil, err
		}
		out = append(out, r)
	}
	return out, rows.Err()
}

// fillThreadPreviews resolves the head and newest-reply bodies for a page,
// filling every passed group IN PLACE with one round trip.
//
// A miss is not an error: if an old partition was detached the probe finds
// nothing, and the row renders without that preview -- navigable, honestly
// degraded, not broken.
func (s *Store) fillThreadPreviews(ctx context.Context, groups ...[]ThreadInboxRow) error {
	n := 0
	for _, g := range groups {
		n += len(g)
	}
	if n == 0 {
		return nil
	}
	tss := make([]time.Time, 0, n*2)
	ids := make([]uuid.UUID, 0, n*2)
	for _, g := range groups {
		for _, r := range g {
			tss = append(tss, r.HeadTS, r.LastReplyTS)
			ids = append(ids, r.ThreadID, r.LastReplyID)
		}
	}

	type preview struct {
		body       []byte
		keyVersion *int
		deleted    bool
	}
	found := make(map[uuid.UUID]preview, len(ids))

	q, err := s.Pool.Query(ctx, threadInboxPreviewSQL, tss, ids)
	if err != nil {
		return err
	}
	defer q.Close()
	for q.Next() {
		var id uuid.UUID
		var p preview
		var deletedAt *time.Time
		if err := q.Scan(&id, &p.body, &p.keyVersion, &deletedAt); err != nil {
			return err
		}
		p.deleted = deletedAt != nil
		found[id] = p
	}
	if err := q.Err(); err != nil {
		return err
	}

	for _, g := range groups {
		for i := range g {
			if p, ok := found[g[i].ThreadID]; ok {
				g[i].HeadBody, g[i].HeadKeyVersion, g[i].HeadDeleted = p.body, p.keyVersion, p.deleted
			}
			if p, ok := found[g[i].LastReplyID]; ok {
				g[i].LastReplyBody, g[i].LastReplyKeyVersion, g[i].LastReplyDeleted = p.body, p.keyVersion, p.deleted
			}
		}
	}
	return nil
}

// ThreadActivity is one row of thread_activity. Returned by the test-facing
// lookup below and reused by the inbox query in 42-6.
type ThreadActivity struct {
	ThreadID          uuid.UUID
	ChannelID         uuid.UUID
	HeadTS            time.Time
	HeadSeq           int64
	HeadSenderID      *uuid.UUID
	LastReplyID       uuid.UUID
	LastReplyTS       time.Time
	LastReplySeq      int64
	LastReplySenderID *uuid.UUID
	ReplyCount        int64
}

// GetThreadActivity returns one thread's activity row, or ErrThreadNotFound.
func (s *Store) GetThreadActivity(ctx context.Context, threadID uuid.UUID) (ThreadActivity, error) {
	var ta ThreadActivity
	err := s.Pool.QueryRow(ctx,
		`SELECT thread_id, channel_id, head_ts, head_seq, head_sender_id,
		        last_reply_id, last_reply_ts, last_reply_seq, last_reply_sender_id,
		        reply_count
		   FROM thread_activity
		  WHERE thread_id = $1`,
		threadID,
	).Scan(
		&ta.ThreadID, &ta.ChannelID, &ta.HeadTS, &ta.HeadSeq, &ta.HeadSenderID,
		&ta.LastReplyID, &ta.LastReplyTS, &ta.LastReplySeq, &ta.LastReplySenderID,
		&ta.ReplyCount,
	)
	if errors.Is(err, pgx.ErrNoRows) {
		return ThreadActivity{}, ErrThreadNotFound
	}
	if err != nil {
		return ThreadActivity{}, err
	}
	return ta, nil
}
