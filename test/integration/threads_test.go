package integration

// Phase 42-1 integration tests for thread activity and per-user thread read
// cursors (store/threads.go, migrations 0046 + 0047). Cover the properties the
// thread inbox depends on:
//
//   * a thread's first reply seeds head pointers and a count of 1
//   * later replies advance the newest-reply pointers and increment the count
//   * a reply to a reply stays on the same thread and leaves head pointers alone
//   * a reply whose head does not exist is rejected, not silently dropped
//   * the maintained reply_count/last_reply_seq equal what the old full-scan
//     aggregate computed -- this is what licenses 42-3 to delete that aggregate
//   * replying marks you involved and caught up, so your own reply is never
//     unread for you on another device
//   * the head's author becomes involved when someone replies to them
//   * cursors are monotonic, clamped, per-user, and involvement is sticky
//
// Skips without CHALK_TEST_PGURL, like every other test in this package.

import (
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"

	"github.com/scuq/chalk/internal/store"
)

// seedThreadChannel creates a non-DM channel owned by alice with bob as a
// member, plus a device for each. Mirrors seedReadsChannel.
func seedThreadChannel(t *testing.T, st *store.Store) (channelID, aliceDev, bobDev uuid.UUID) {
	t.Helper()
	c := ctx(t)

	if _, err := st.Pool.Exec(c,
		`UPDATE users SET status = 'active', status_reason = NULL WHERE id = ANY($1)`,
		[]uuid.UUID{aliceID, bobID, carolID},
	); err != nil {
		t.Fatalf("reset user status: %v", err)
	}

	ch, err := st.CreateChannel(c, store.CreateChannelInput{
		Name:      "threads-" + uuid.NewString()[:8],
		CreatedBy: aliceID,
		MemberIDs: []uuid.UUID{bobID},
	})
	if err != nil {
		t.Fatalf("CreateChannel: %v", err)
	}
	return ch.ID, seedReadsDevice(t, st, aliceID), seedReadsDevice(t, st, bobID)
}

// insertHead inserts a top-level message and returns its id. A head is not a
// thread until it has a reply, so nothing thread-shaped is recorded here.
func insertHead(t *testing.T, st *store.Store, channelID, devID uuid.UUID) uuid.UUID {
	t.Helper()
	m, err := st.InsertMessage(ctx(t), store.Message{
		ChannelID:      channelID,
		SenderDeviceID: devID,
		Body:           []byte("head"),
	})
	if err != nil {
		t.Fatalf("InsertMessage(head): %v", err)
	}
	return m.ID
}

// insertReply inserts a reply and records its thread state in ONE transaction,
// the way handleSend does.
//
// Deliberately does not go through InsertMessage: this slice tests
// RecordThreadReplyTx in isolation, so these tests keep passing unchanged when
// 42-2 makes InsertMessage maintain the same tables itself.
//
// parentID is what the reply points at; threadID is the head it belongs to
// (they differ for a reply to a reply). Returns the reply's seq.
func insertReply(t *testing.T, st *store.Store, channelID, devID, parentID, threadID uuid.UUID) int64 {
	t.Helper()
	c := ctx(t)

	var seq int64
	tx, err := st.Pool.Begin(c)
	if err != nil {
		t.Fatalf("begin: %v", err)
	}
	defer func() { _ = tx.Rollback(c) }()

	if err := tx.QueryRow(c,
		`UPDATE channel_seq SET next_seq = next_seq + 1
		  WHERE channel_id = $1
		 RETURNING next_seq - 1`,
		channelID,
	).Scan(&seq); err != nil {
		t.Fatalf("allocate seq: %v", err)
	}

	replyID := uuid.New()
	var ts time.Time
	if err := tx.QueryRow(c,
		`INSERT INTO messages
		   (id, channel_id, thread_id, parent_id, sender_device_id, seq, body, meta)
		 VALUES ($1, $2, $3, $4, $5, $6, $7, '{}'::jsonb)
		 RETURNING ts`,
		replyID, channelID, threadID, parentID, devID, seq, []byte("reply"),
	).Scan(&ts); err != nil {
		t.Fatalf("insert reply: %v", err)
	}

	if err := store.RecordThreadReplyTx(c, tx, channelID, threadID, replyID, devID, ts, seq); err != nil {
		t.Fatalf("RecordThreadReplyTx: %v", err)
	}
	if err := tx.Commit(c); err != nil {
		t.Fatalf("commit: %v", err)
	}
	return seq
}

func TestThreadActivity_FirstReplySeedsHeadAndCount(t *testing.T) {
	st := openStore(t)
	chID, aliceDev, bobDev := seedThreadChannel(t, st)

	head := insertHead(t, st, chID, aliceDev)
	replySeq := insertReply(t, st, chID, bobDev, head, head)

	ta, err := st.GetThreadActivity(ctx(t), head)
	if err != nil {
		t.Fatalf("GetThreadActivity: %v", err)
	}
	if ta.ThreadID != head {
		t.Errorf("thread_id = %s, want %s", ta.ThreadID, head)
	}
	if ta.ChannelID != chID {
		t.Errorf("channel_id = %s, want %s", ta.ChannelID, chID)
	}
	if ta.ReplyCount != 1 {
		t.Errorf("reply_count = %d, want 1", ta.ReplyCount)
	}
	if ta.LastReplySeq != replySeq {
		t.Errorf("last_reply_seq = %d, want %d", ta.LastReplySeq, replySeq)
	}
	if ta.HeadSenderID == nil || *ta.HeadSenderID != aliceID {
		t.Errorf("head_sender_id = %v, want %s", ta.HeadSenderID, aliceID)
	}
	if ta.LastReplySenderID == nil || *ta.LastReplySenderID != bobID {
		t.Errorf("last_reply_sender_id = %v, want %s", ta.LastReplySenderID, bobID)
	}

	// head_ts must match the head row exactly: it is the partition-pruning half
	// of the (ts, id) probe that fetches the head's body.
	var headTS time.Time
	var headSeq int64
	if err := st.Pool.QueryRow(ctx(t),
		`SELECT ts, seq FROM messages WHERE id = $1`, head,
	).Scan(&headTS, &headSeq); err != nil {
		t.Fatalf("read head row: %v", err)
	}
	if !ta.HeadTS.Equal(headTS) {
		t.Errorf("head_ts = %v, want %v", ta.HeadTS, headTS)
	}
	if ta.HeadSeq != headSeq {
		t.Errorf("head_seq = %d, want %d", ta.HeadSeq, headSeq)
	}
}

func TestThreadActivity_SubsequentRepliesAdvancePointers(t *testing.T) {
	st := openStore(t)
	chID, aliceDev, bobDev := seedThreadChannel(t, st)

	head := insertHead(t, st, chID, aliceDev)
	insertReply(t, st, chID, bobDev, head, head)
	third := insertReply(t, st, chID, aliceDev, head, head)

	ta, err := st.GetThreadActivity(ctx(t), head)
	if err != nil {
		t.Fatalf("GetThreadActivity: %v", err)
	}
	if ta.ReplyCount != 2 {
		t.Errorf("reply_count = %d, want 2", ta.ReplyCount)
	}
	if ta.LastReplySeq != third {
		t.Errorf("last_reply_seq = %d, want %d", ta.LastReplySeq, third)
	}
	if ta.LastReplySenderID == nil || *ta.LastReplySenderID != aliceID {
		t.Errorf("last_reply_sender_id = %v, want alice", ta.LastReplySenderID)
	}
}

func TestThreadActivity_ReplyToReplyStaysOnTheHead(t *testing.T) {
	st := openStore(t)
	chID, aliceDev, bobDev := seedThreadChannel(t, st)

	head := insertHead(t, st, chID, aliceDev)
	insertReply(t, st, chID, bobDev, head, head)

	before, err := st.GetThreadActivity(ctx(t), head)
	if err != nil {
		t.Fatalf("GetThreadActivity: %v", err)
	}

	// A reply whose parent is itself a reply: parent differs, thread does not.
	var firstReplyID uuid.UUID
	if err := st.Pool.QueryRow(ctx(t),
		`SELECT id FROM messages WHERE thread_id = $1 ORDER BY seq LIMIT 1`, head,
	).Scan(&firstReplyID); err != nil {
		t.Fatalf("find first reply: %v", err)
	}
	insertReply(t, st, chID, aliceDev, firstReplyID, head)

	after, err := st.GetThreadActivity(ctx(t), head)
	if err != nil {
		t.Fatalf("GetThreadActivity: %v", err)
	}
	if after.ReplyCount != 2 {
		t.Errorf("reply_count = %d, want 2", after.ReplyCount)
	}
	if !after.HeadTS.Equal(before.HeadTS) || after.HeadSeq != before.HeadSeq {
		t.Error("head pointers moved on a reply-to-a-reply; they must not")
	}

	// And no second thread row was created for the reply that was replied to.
	if _, err := st.GetThreadActivity(ctx(t), firstReplyID); err != store.ErrThreadNotFound {
		t.Errorf("a reply grew its own thread row; err = %v, want ErrThreadNotFound", err)
	}
}

func TestThreadActivity_UnknownHeadIsRejected(t *testing.T) {
	st := openStore(t)
	chID, aliceDev, _ := seedThreadChannel(t, st)
	c := ctx(t)

	tx, err := st.Pool.Begin(c)
	if err != nil {
		t.Fatalf("begin: %v", err)
	}
	defer func() { _ = tx.Rollback(c) }()

	err = store.RecordThreadReplyTx(c, tx, chID, uuid.New(), uuid.New(), aliceDev, time.Now().UTC(), 1)
	if err != store.ErrThreadHeadNotFound {
		t.Errorf("err = %v, want ErrThreadHeadNotFound", err)
	}
}

// TestThreadActivity_MatchesTheOldAggregate is the license for slice 42-3.
// The maintained table must agree, per thread, with both the full-scan
// GROUP BY it replaces and the migration's backfill projection. If this ever
// fails, deleting the aggregate in ListMessagesByChannel changed behaviour.
func TestThreadActivity_MatchesTheOldAggregate(t *testing.T) {
	st := openStore(t)
	chID, aliceDev, bobDev := seedThreadChannel(t, st)
	c := ctx(t)

	// Two threads of different shapes, plus a top-level message with no
	// replies (which must NOT appear -- it is not a thread).
	headA := insertHead(t, st, chID, aliceDev)
	insertReply(t, st, chID, bobDev, headA, headA)
	insertReply(t, st, chID, aliceDev, headA, headA)
	insertReply(t, st, chID, bobDev, headA, headA)

	headB := insertHead(t, st, chID, bobDev)
	insertReply(t, st, chID, aliceDev, headB, headB)

	lonely := insertHead(t, st, chID, aliceDev)

	// The aggregate exactly as channels.go computes it today.
	rows, err := st.Pool.Query(c,
		`SELECT m.thread_id, COUNT(*), MAX(m.seq)
		   FROM messages m
		  WHERE m.parent_id IS NOT NULL AND m.channel_id = $1
		  GROUP BY m.thread_id`,
		chID,
	)
	if err != nil {
		t.Fatalf("old aggregate: %v", err)
	}
	defer rows.Close()

	seen := 0
	for rows.Next() {
		var threadID uuid.UUID
		var cnt, maxSeq int64
		if err := rows.Scan(&threadID, &cnt, &maxSeq); err != nil {
			t.Fatalf("scan: %v", err)
		}
		ta, err := st.GetThreadActivity(c, threadID)
		if err != nil {
			t.Fatalf("thread %s in the aggregate but not in thread_activity: %v", threadID, err)
		}
		if ta.ReplyCount != cnt {
			t.Errorf("thread %s: reply_count = %d, aggregate said %d", threadID, ta.ReplyCount, cnt)
		}
		if ta.LastReplySeq != maxSeq {
			t.Errorf("thread %s: last_reply_seq = %d, aggregate said %d", threadID, ta.LastReplySeq, maxSeq)
		}
		seen++
	}
	if err := rows.Err(); err != nil {
		t.Fatalf("rows: %v", err)
	}
	if seen != 2 {
		t.Errorf("aggregate found %d threads, want 2", seen)
	}
	if _, err := st.GetThreadActivity(c, lonely); err != store.ErrThreadNotFound {
		t.Errorf("a reply-less message got a thread row; err = %v", err)
	}
}

// TestThreadActivity_InsertMessagePathMaintainsActivity covers the second
// insert path (42-2). InsertMessage is test-only, but if it did not maintain
// these tables every test that builds a thread through it would describe a
// database production never produces.
func TestThreadActivity_InsertMessagePathMaintainsActivity(t *testing.T) {
	st := openStore(t)
	chID, aliceDev, bobDev := seedThreadChannel(t, st)
	c := ctx(t)

	head := insertHead(t, st, chID, aliceDev)

	reply, err := st.InsertMessage(c, store.Message{
		ChannelID:      chID,
		SenderDeviceID: bobDev,
		ParentID:       &head,
		ThreadID:       &head,
		Body:           []byte("reply via InsertMessage"),
	})
	if err != nil {
		t.Fatalf("InsertMessage(reply): %v", err)
	}

	ta, err := st.GetThreadActivity(c, head)
	if err != nil {
		t.Fatalf("GetThreadActivity: %v", err)
	}
	if ta.ReplyCount != 1 {
		t.Errorf("reply_count = %d, want 1", ta.ReplyCount)
	}
	if ta.LastReplySeq != reply.Seq {
		t.Errorf("last_reply_seq = %d, want %d", ta.LastReplySeq, reply.Seq)
	}
	if !threadInvolved(t, st, head, bobID) {
		t.Error("the replier is not involved via the InsertMessage path")
	}
	if !threadInvolved(t, st, head, aliceID) {
		t.Error("the head author is not involved via the InsertMessage path")
	}
}

// ---- 42-3: the feed query carries thread state ---------------------------

// TestListMessagesByChannel_CarriesThreadCursors exercises the rewritten feed
// query end to end. It is the only place the new joins actually run, and
// go build proves nothing about SQL scope, so this is the real check that
// 42-3's rewrite is correct.
func TestListMessagesByChannel_CarriesThreadCursors(t *testing.T) {
	st := openStore(t)
	chID, aliceDev, bobDev := seedThreadChannel(t, st)
	c := ctx(t)

	head := insertHead(t, st, chID, aliceDev)
	insertReply(t, st, chID, bobDev, head, head)
	last := insertReply(t, st, chID, bobDev, head, head)

	headRow := func(viewer uuid.UUID) store.Message {
		t.Helper()
		msgs, err := st.ListMessagesByChannel(c, chID, viewer, 0, 50, false)
		if err != nil {
			t.Fatalf("ListMessagesByChannel: %v", err)
		}
		for _, m := range msgs {
			if m.ID == head {
				return m
			}
		}
		t.Fatalf("head %s not in the feed", head)
		return store.Message{}
	}

	// Alice wrote the head: involved, and has read none of the replies.
	m := headRow(aliceID)
	if m.ReplyCount != 2 {
		t.Errorf("reply_count = %d, want 2", m.ReplyCount)
	}
	if m.LastReplySeq != last {
		t.Errorf("last_reply_seq = %d, want %d", m.LastReplySeq, last)
	}
	if m.LastReplySenderUserID == nil || *m.LastReplySenderUserID != bobID {
		t.Errorf("last_reply_sender = %v, want bob", m.LastReplySenderUserID)
	}
	if len(m.LastReplyBody) == 0 {
		t.Error("last_reply_body is empty; the (ts, id) probe for the newest reply did not resolve")
	}
	if !m.ThreadInvolved {
		t.Error("alice wrote the head but the feed says she is not involved")
	}
	if m.ThreadLastReadSeq != 0 {
		t.Errorf("alice's thread cursor = %d, want 0", m.ThreadLastReadSeq)
	}

	// After reading, the same query reports her caught up -- this is what
	// replaced the per-device localStorage cursor.
	if _, err := st.MarkThreadRead(c, head, aliceID, last); err != nil {
		t.Fatalf("MarkThreadRead: %v", err)
	}
	if got := headRow(aliceID).ThreadLastReadSeq; got != last {
		t.Errorf("after reading, thread cursor = %d, want %d", got, last)
	}

	// Cursors are per viewer: carol has read nothing and took no part.
	m = headRow(carolID)
	if m.ThreadLastReadSeq != 0 || m.ThreadInvolved {
		t.Errorf("carol sees cursor=%d involved=%v, want 0/false", m.ThreadLastReadSeq, m.ThreadInvolved)
	}
	// ...but she still sees the thread itself.
	if m.ReplyCount != 2 {
		t.Errorf("carol sees reply_count = %d, want 2", m.ReplyCount)
	}

	// A viewerless read must not error, and reports everything unread.
	m = headRow(uuid.Nil)
	if m.ThreadLastReadSeq != 0 || m.ThreadInvolved {
		t.Error("viewerless read claimed read/involved state")
	}
}

// TestListMessagesByChannel_ReplylessMessageHasNoThreadState guards the LEFT
// JOINs: an ordinary message must come back with zeroes, not vanish. If any of
// the three new joins were written as an inner join, this row disappears.
func TestListMessagesByChannel_ReplylessMessageHasNoThreadState(t *testing.T) {
	st := openStore(t)
	chID, aliceDev, _ := seedThreadChannel(t, st)
	c := ctx(t)

	lonely := insertHead(t, st, chID, aliceDev)

	msgs, err := st.ListMessagesByChannel(c, chID, aliceID, 0, 50, false)
	if err != nil {
		t.Fatalf("ListMessagesByChannel: %v", err)
	}
	for _, m := range msgs {
		if m.ID != lonely {
			continue
		}
		if m.ReplyCount != 0 || m.LastReplySeq != 0 || len(m.LastReplyBody) != 0 {
			t.Errorf("reply-less message has thread state: count=%d seq=%d body=%q",
				m.ReplyCount, m.LastReplySeq, m.LastReplyBody)
		}
		if m.ThreadInvolved || m.ThreadLastReadSeq != 0 {
			t.Error("reply-less message reports thread read state")
		}
		return
	}
	t.Fatal("a message with no replies fell out of the feed; a LEFT JOIN degraded to an inner join")
}

// TestListMessagesByChannel_HeadsOnly guards 55-2: with headsOnly set the
// page carries no replies, but the head still arrives with its thread
// decorations -- the client's reply counts and snippets come from these
// rows, so a heads-only page that lost them would blank every thread badge
// loaded through scrollback.
func TestListMessagesByChannel_HeadsOnly(t *testing.T) {
	st := openStore(t)
	chID, aliceDev, bobDev := seedThreadChannel(t, st)
	c := ctx(t)

	head := insertHead(t, st, chID, aliceDev)
	insertReply(t, st, chID, bobDev, head, head)
	last := insertReply(t, st, chID, bobDev, head, head)

	msgs, err := st.ListMessagesByChannel(c, chID, aliceID, 0, 50, true)
	if err != nil {
		t.Fatalf("ListMessagesByChannel(headsOnly): %v", err)
	}
	found := false
	for _, m := range msgs {
		if m.ParentID != nil {
			t.Errorf("heads-only page contains reply %s", m.ID)
		}
		if m.ID == head {
			found = true
			if m.ReplyCount != 2 || m.LastReplySeq != last {
				t.Errorf("head lost its decorations: count=%d last=%d, want 2/%d",
					m.ReplyCount, m.LastReplySeq, last)
			}
		}
	}
	if !found {
		t.Fatal("the head is missing from a heads-only page")
	}
}

// ---- 42-1: thread read cursors ------------------------------------------

func TestThreadReply_AuthorIsCaughtUpAndInvolved(t *testing.T) {
	st := openStore(t)
	chID, aliceDev, bobDev := seedThreadChannel(t, st)
	c := ctx(t)

	head := insertHead(t, st, chID, aliceDev)
	replySeq := insertReply(t, st, chID, bobDev, head, head)

	// Bob wrote the reply: caught up, on the hook.
	got, err := st.GetThreadRead(c, head, bobID)
	if err != nil {
		t.Fatalf("GetThreadRead(bob): %v", err)
	}
	if got != replySeq {
		t.Errorf("bob's cursor = %d, want %d (his own reply must not be unread for him)", got, replySeq)
	}
	if !threadInvolved(t, st, head, bobID) {
		t.Error("bob replied but is not marked involved")
	}

	// Alice wrote the head: involved, but NOT caught up -- the reply is the
	// unread thing she needs to hear about.
	aliceCursor, err := st.GetThreadRead(c, head, aliceID)
	if err != nil {
		t.Fatalf("GetThreadRead(alice): %v", err)
	}
	if aliceCursor != 0 {
		t.Errorf("alice's cursor = %d, want 0", aliceCursor)
	}
	if !threadInvolved(t, st, head, aliceID) {
		t.Error("alice wrote the head but is not marked involved")
	}
}

func TestThreadRead_MonotonicAndClamped(t *testing.T) {
	st := openStore(t)
	chID, aliceDev, bobDev := seedThreadChannel(t, st)
	c := ctx(t)

	head := insertHead(t, st, chID, aliceDev)
	insertReply(t, st, chID, bobDev, head, head)
	last := insertReply(t, st, chID, bobDev, head, head)

	// Guessing high cannot hide replies alice never saw.
	got, err := st.MarkThreadRead(c, head, aliceID, last+9999)
	if err != nil {
		t.Fatalf("MarkThreadRead: %v", err)
	}
	if got != last {
		t.Errorf("clamped cursor = %d, want %d", got, last)
	}

	// A stale mark cannot rewind what another device already advanced.
	got, err = st.MarkThreadRead(c, head, aliceID, 1)
	if err != nil {
		t.Fatalf("MarkThreadRead(stale): %v", err)
	}
	if got != last {
		t.Errorf("cursor rewound to %d, want %d", got, last)
	}
}

func TestThreadRead_ReadingDoesNotClaimInvolvement(t *testing.T) {
	st := openStore(t)
	chID, aliceDev, bobDev := seedThreadChannel(t, st)
	c := ctx(t)

	// Alice's head, bob replies -- so carol is a bystander with no part in it.
	head := insertHead(t, st, chID, aliceDev)
	seq := insertReply(t, st, chID, bobDev, head, head)

	if _, err := st.MarkThreadRead(c, head, carolID, seq); err != nil {
		t.Fatalf("MarkThreadRead(carol): %v", err)
	}
	got, err := st.GetThreadRead(c, head, carolID)
	if err != nil {
		t.Fatalf("GetThreadRead(carol): %v", err)
	}
	if got != seq {
		t.Errorf("carol's cursor = %d, want %d", got, seq)
	}
	if threadInvolved(t, st, head, carolID) {
		t.Error("merely reading a thread marked carol involved; it must not")
	}
}

func TestThreadRead_InvolvementIsSticky(t *testing.T) {
	st := openStore(t)
	chID, aliceDev, bobDev := seedThreadChannel(t, st)
	c := ctx(t)

	head := insertHead(t, st, chID, aliceDev)
	seq := insertReply(t, st, chID, bobDev, head, head)

	// Bob is involved. A plain read must not clear that.
	if _, err := st.MarkThreadRead(c, head, bobID, seq); err != nil {
		t.Fatalf("MarkThreadRead(bob): %v", err)
	}
	if !threadInvolved(t, st, head, bobID) {
		t.Error("a read cleared bob's involvement; involvement is sticky")
	}
}

func TestThreadRead_CursorsArePerUser(t *testing.T) {
	st := openStore(t)
	chID, aliceDev, bobDev := seedThreadChannel(t, st)
	c := ctx(t)

	head := insertHead(t, st, chID, aliceDev)
	seq := insertReply(t, st, chID, bobDev, head, head)

	if _, err := st.MarkThreadRead(c, head, carolID, seq); err != nil {
		t.Fatalf("MarkThreadRead(carol): %v", err)
	}
	// Alice wrote the head and has not read the reply; carol reading it must
	// not have moved alice's cursor.
	aliceCursor, err := st.GetThreadRead(c, head, aliceID)
	if err != nil {
		t.Fatalf("GetThreadRead(alice): %v", err)
	}
	if aliceCursor != 0 {
		t.Errorf("alice's cursor = %d, want 0 -- carol's read leaked", aliceCursor)
	}
}

func TestThreadRead_UnknownThreadIsRejected(t *testing.T) {
	st := openStore(t)
	if _, err := st.MarkThreadRead(ctx(t), uuid.New(), aliceID, 1); err != store.ErrThreadNotFound {
		t.Errorf("err = %v, want ErrThreadNotFound", err)
	}
}

// ---- 42-6: the thread inbox ---------------------------------------------

// backdateThread pushes a thread's newest-reply timestamp into the past so it
// falls outside the recency window. Only last_reply_ts moves: head_ts is half of
// the (ts, id) key that fetches the head's body, and the composite FK is on it.
func backdateThread(t *testing.T, st *store.Store, threadID uuid.UUID, d time.Duration) {
	t.Helper()
	if _, err := st.Pool.Exec(ctx(t),
		`UPDATE thread_activity SET last_reply_ts = last_reply_ts - $2::interval
		  WHERE thread_id = $1`,
		threadID, d.String(),
	); err != nil {
		t.Fatalf("backdate thread: %v", err)
	}
}

// inboxFor runs the inbox for a viewer with a 48h window and returns every row
// from both halves keyed by thread, so tests can assert about their own threads
// without caring what else the shared fixture database holds.
func inboxFor(t *testing.T, st *store.Store, userID uuid.UUID) (map[uuid.UUID]store.ThreadInboxRow, store.ThreadInboxPage) {
	t.Helper()
	page, err := st.ListThreadInbox(ctx(t), userID, time.Now().Add(-48*time.Hour), time.Time{}, 100)
	if err != nil {
		t.Fatalf("ListThreadInbox: %v", err)
	}
	byID := make(map[uuid.UUID]store.ThreadInboxRow, len(page.Active)+len(page.AgedUnread))
	for _, r := range page.Active {
		byID[r.ThreadID] = r
	}
	for _, r := range page.AgedUnread {
		byID[r.ThreadID] = r
	}
	return byID, page
}

// TestThreadInbox_AgedOutUnreadThreadIsStillReturned is the "feature is worse
// than the bug" guard. If the recency window is ever allowed to define unread,
// a thread that went quiet with a reply you never read disappears silently --
// which is exactly the failure this whole feature exists to fix.
func TestThreadInbox_AgedOutUnreadThreadIsStillReturned(t *testing.T) {
	st := openStore(t)
	chID, aliceDev, bobDev := seedThreadChannel(t, st)

	// Alice's thread, bob replies, alice never reads it. Then it goes quiet for
	// a week -- well past the 48h window.
	head := insertHead(t, st, chID, aliceDev)
	insertReply(t, st, chID, bobDev, head, head)
	backdateThread(t, st, head, 7*24*time.Hour)

	rows, page := inboxFor(t, st, aliceID)
	row, ok := rows[head]
	if !ok {
		t.Fatal("an unread thread alice took part in vanished once it aged out of the window")
	}
	if !row.Involved {
		t.Error("alice wrote the head; involved should be true")
	}
	if row.LastReplySeq <= row.LastReadSeq {
		t.Errorf("row does not read as unread: last_reply=%d last_read=%d",
			row.LastReplySeq, row.LastReadSeq)
	}
	if page.UnreadInvolvedTotal < 1 {
		t.Errorf("unread total = %d, want >= 1", page.UnreadInvolvedTotal)
	}
}

func TestThreadInbox_ActiveWindowIncludesUninvolvedThreads(t *testing.T) {
	st := openStore(t)
	chID, aliceDev, bobDev := seedThreadChannel(t, st)

	// Bob's thread, bob replies to himself -- carol has no part in it, but it is
	// alive right now, so discovery should surface it for her.
	_ = aliceDev
	head := insertHead(t, st, chID, bobDev)
	insertReply(t, st, chID, bobDev, head, head)

	if err := st.AddMember(ctx(t), chID, carolID); err != nil {
		t.Fatalf("AddMember(carol): %v", err)
	}

	rows, _ := inboxFor(t, st, carolID)
	row, ok := rows[head]
	if !ok {
		t.Fatal("a thread active inside the window is missing for an uninvolved member")
	}
	if row.Involved {
		t.Error("carol took no part; involved should be false")
	}
}

func TestThreadInbox_AgedOutReadThreadIsNotReturned(t *testing.T) {
	st := openStore(t)
	chID, aliceDev, bobDev := seedThreadChannel(t, st)

	head := insertHead(t, st, chID, aliceDev)
	seq := insertReply(t, st, chID, bobDev, head, head)
	if _, err := st.MarkThreadRead(ctx(t), head, aliceID, seq); err != nil {
		t.Fatalf("MarkThreadRead: %v", err)
	}
	backdateThread(t, st, head, 7*24*time.Hour)

	rows, _ := inboxFor(t, st, aliceID)
	if _, ok := rows[head]; ok {
		t.Error("a thread that is both read and aged out is still listed")
	}
}

// TestThreadInbox_UninvolvedAgedOutThreadIsNotReturned is the noise bound. A
// forty-reply thread you never touched, gone quiet, must not follow you around.
func TestThreadInbox_UninvolvedAgedOutThreadIsNotReturned(t *testing.T) {
	st := openStore(t)
	chID, _, bobDev := seedThreadChannel(t, st)

	head := insertHead(t, st, chID, bobDev)
	insertReply(t, st, chID, bobDev, head, head)
	backdateThread(t, st, head, 7*24*time.Hour)

	if err := st.AddMember(ctx(t), chID, carolID); err != nil {
		t.Fatalf("AddMember(carol): %v", err)
	}

	rows, _ := inboxFor(t, st, carolID)
	if _, ok := rows[head]; ok {
		t.Error("an aged-out thread carol never took part in is in her inbox")
	}
}

// TestThreadInbox_HalvesDoNotOverlap: the cutoff partitions the two lists, so no
// thread can appear in both and neither needs a dedup pass. Each is also sorted
// newest-first on its own.
func TestThreadInbox_HalvesDoNotOverlap(t *testing.T) {
	st := openStore(t)
	chID, aliceDev, bobDev := seedThreadChannel(t, st)

	fresh := insertHead(t, st, chID, aliceDev)
	insertReply(t, st, chID, bobDev, fresh, fresh)

	stale := insertHead(t, st, chID, aliceDev)
	insertReply(t, st, chID, bobDev, stale, stale)
	backdateThread(t, st, stale, 7*24*time.Hour)

	_, page := inboxFor(t, st, aliceID)

	inActive := make(map[uuid.UUID]bool, len(page.Active))
	for _, r := range page.Active {
		inActive[r.ThreadID] = true
	}
	for _, r := range page.AgedUnread {
		if inActive[r.ThreadID] {
			t.Errorf("thread %s is in both halves; the cutoff did not partition them", r.ThreadID)
		}
	}
	for _, half := range [][]store.ThreadInboxRow{page.Active, page.AgedUnread} {
		for i := 1; i < len(half); i++ {
			if half[i].LastReplyTS.After(half[i-1].LastReplyTS) {
				t.Errorf("row %d is newer than row %d; a half is not sorted newest-first", i, i-1)
			}
		}
	}
	// The fresh thread belongs to the active half, the stale one to the aged
	// half -- not merely present somewhere.
	if !inActive[fresh] {
		t.Error("a thread replied to just now is not in the active half")
	}
	found := false
	for _, r := range page.AgedUnread {
		if r.ThreadID == stale {
			found = true
		}
	}
	if !found {
		t.Error("an aged-out unread thread is not in the aged half")
	}
}

// TestThreadInbox_AgedHalfSurvivesAFullActivePage is the regression guard for the
// bug the aging-out test caught: the aged half used to run only when the active
// half came up short, so a user with a full page of live threads silently lost
// the forgotten unread one. Exactly backwards -- that user needs it most.
func TestThreadInbox_AgedHalfSurvivesAFullActivePage(t *testing.T) {
	st := openStore(t)
	chID, aliceDev, bobDev := seedThreadChannel(t, st)

	stale := insertHead(t, st, chID, aliceDev)
	insertReply(t, st, chID, bobDev, stale, stale)
	backdateThread(t, st, stale, 7*24*time.Hour)

	// Two live threads, then ask for a page of ONE so the active half is full.
	for i := 0; i < 2; i++ {
		h := insertHead(t, st, chID, aliceDev)
		insertReply(t, st, chID, bobDev, h, h)
	}

	page, err := st.ListThreadInbox(ctx(t), aliceID, time.Now().Add(-48*time.Hour), time.Time{}, 1)
	if err != nil {
		t.Fatalf("ListThreadInbox: %v", err)
	}
	if !page.HasMoreActive {
		t.Fatal("precondition: the active half should be full at limit 1")
	}
	for _, r := range page.AgedUnread {
		if r.ThreadID == stale {
			return
		}
	}
	t.Error("a full active page suppressed the aged-unread half")
}

func TestThreadInbox_ExcludesChannelsYouLeft(t *testing.T) {
	st := openStore(t)
	chID, aliceDev, bobDev := seedThreadChannel(t, st)

	// Bob's own thread, so his read rows survive his removal from the channel.
	head := insertHead(t, st, chID, bobDev)
	insertReply(t, st, chID, bobDev, head, head)

	if rows, _ := inboxFor(t, st, bobID); rows[head].ThreadID != head {
		t.Fatal("precondition: bob should see his own thread while a member")
	}
	_ = aliceDev

	if err := st.RemoveMember(ctx(t), chID, bobID); err != nil {
		t.Fatalf("RemoveMember: %v", err)
	}
	if rows, _ := inboxFor(t, st, bobID); rows[head].ThreadID == head {
		t.Error("a thread in a channel bob was removed from is still in his inbox")
	}
}

func TestThreadInbox_PreviewsAreCiphertextAndResolve(t *testing.T) {
	st := openStore(t)
	chID, aliceDev, bobDev := seedThreadChannel(t, st)

	head := insertHead(t, st, chID, aliceDev)
	insertReply(t, st, chID, bobDev, head, head)

	rows, _ := inboxFor(t, st, aliceID)
	row := rows[head]
	// insertHead writes "head" and insertReply writes "reply" as the raw body;
	// what matters here is that the (ts, id) probes resolved at all -- an empty
	// body would mean the preview join silently missed.
	if len(row.HeadBody) == 0 {
		t.Error("head preview did not resolve")
	}
	if len(row.LastReplyBody) == 0 {
		t.Error("last-reply preview did not resolve")
	}
	if row.HeadDeleted || row.LastReplyDeleted {
		t.Error("live messages reported as tombstones")
	}
	if row.ReplyCount != 1 {
		t.Errorf("reply_count = %d, want 1", row.ReplyCount)
	}
}

func TestThreadInbox_UnreadTotalCountsBeyondTheLimit(t *testing.T) {
	st := openStore(t)
	chID, aliceDev, bobDev := seedThreadChannel(t, st)

	const n = 5
	for i := 0; i < n; i++ {
		head := insertHead(t, st, chID, aliceDev)
		insertReply(t, st, chID, bobDev, head, head)
	}

	// A limit of 1 truncates the page, but the badge must still be honest.
	page, err := st.ListThreadInbox(ctx(t), aliceID, time.Now().Add(-48*time.Hour), time.Time{}, 1)
	if err != nil {
		t.Fatalf("ListThreadInbox: %v", err)
	}
	if len(page.Active) != 1 {
		t.Errorf("active rows = %d, want 1", len(page.Active))
	}
	if !page.HasMoreActive {
		t.Error("has_more_active should be true when the active half filled the limit")
	}
	if page.UnreadInvolvedTotal < n {
		t.Errorf("unread total = %d, want >= %d -- the count must ignore the limit",
			page.UnreadInvolvedTotal, n)
	}
}

func threadInvolved(t *testing.T, st *store.Store, threadID, userID uuid.UUID) bool {
	t.Helper()
	var involved bool
	err := st.Pool.QueryRow(ctx(t),
		`SELECT involved FROM thread_reads WHERE user_id = $1 AND thread_id = $2`,
		userID, threadID,
	).Scan(&involved)
	if err == pgx.ErrNoRows {
		return false
	}
	if err != nil {
		t.Fatalf("read involved flag: %v", err)
	}
	return involved
}
