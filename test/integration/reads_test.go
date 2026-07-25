package integration

// Phase 33-1 integration tests for per-user channel read cursors
// (store/reads.go, migrations/0043). Cover the four properties the unread
// indicator depends on:
//
//   * a fresh channel reads as fully caught up (last_seq == last_read_seq)
//   * the cursor is monotonic and clamped to the channel's last seq
//   * cursors are per user, so alice reading doesn't clear bob's dot
//   * joining a channel with history starts you caught up, not buried
//
// Skips without CHALK_TEST_PGURL, like every other test in this package.

import (
	"context"
	"testing"
	"time"

	"github.com/google/uuid"

	"github.com/scuq/chalk/internal/store"
)

// seedReadsChannel creates a non-DM channel owned by alice with bob as a
// member, plus a device for each so messages can be inserted.
func seedReadsChannel(t *testing.T, st *store.Store) (channelID, aliceDev, bobDev uuid.UUID) {
	t.Helper()
	c := ctx(t)

	if _, err := st.Pool.Exec(c,
		`UPDATE users SET status = 'active', status_reason = NULL WHERE id = ANY($1)`,
		[]uuid.UUID{aliceID, bobID, carolID},
	); err != nil {
		t.Fatalf("reset user status: %v", err)
	}

	ch, err := st.CreateChannel(c, store.CreateChannelInput{
		Name:      "reads-" + uuid.NewString()[:8],
		CreatedBy: aliceID,
		MemberIDs: []uuid.UUID{bobID},
	})
	if err != nil {
		t.Fatalf("CreateChannel: %v", err)
	}
	return ch.ID, seedReadsDevice(t, st, aliceID), seedReadsDevice(t, st, bobID)
}

func seedReadsDevice(t *testing.T, st *store.Store, userID uuid.UUID) uuid.UUID {
	t.Helper()
	devID := uuid.New()
	c, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	if _, err := st.Pool.Exec(c,
		`INSERT INTO devices (id, user_id, device_type, device_label)
		 VALUES ($1, $2, 'desktop', 'reads-test')`,
		devID, userID,
	); err != nil {
		t.Fatalf("seed device for %s: %v", userID, err)
	}
	return devID
}

// sendN inserts n messages and returns the seq of the last one.
func sendN(t *testing.T, st *store.Store, channelID, deviceID uuid.UUID, n int) int64 {
	t.Helper()
	c := ctx(t)
	var last int64
	for i := 0; i < n; i++ {
		m, err := st.InsertMessage(c, store.Message{
			ChannelID:      channelID,
			SenderDeviceID: deviceID,
			Body:           []byte("ciphertext"),
		})
		if err != nil {
			t.Fatalf("InsertMessage %d: %v", i, err)
		}
		last = m.Seq
	}
	return last
}

// channelFor finds a channel in a user's listing. Fails if absent.
func channelFor(t *testing.T, st *store.Store, userID, channelID uuid.UUID) store.ChannelWithMembers {
	t.Helper()
	list, err := st.ListChannelsForUser(ctx(t), userID)
	if err != nil {
		t.Fatalf("ListChannelsForUser: %v", err)
	}
	for _, ch := range list {
		if ch.ID == channelID {
			return ch
		}
	}
	t.Fatalf("channel %s not in listing for user %s", channelID, userID)
	return store.ChannelWithMembers{}
}

func TestReads_EmptyChannelHasNoUnread(t *testing.T) {
	st := openStore(t)
	channelID, _, _ := seedReadsChannel(t, st)

	ch := channelFor(t, st, aliceID, channelID)
	if ch.LastSeq != 0 || ch.LastReadSeq != 0 {
		t.Errorf("fresh channel: last_seq=%d last_read_seq=%d, want 0/0", ch.LastSeq, ch.LastReadSeq)
	}
}

func TestReads_UnreadAppearsThenClears(t *testing.T) {
	st := openStore(t)
	c := ctx(t)
	channelID, aliceDev, _ := seedReadsChannel(t, st)

	lastSeq := sendN(t, st, channelID, aliceDev, 3)

	// Bob has read nothing: the whole channel is unread for him.
	ch := channelFor(t, st, bobID, channelID)
	if ch.LastSeq != lastSeq {
		t.Fatalf("bob last_seq = %d, want %d", ch.LastSeq, lastSeq)
	}
	if ch.LastReadSeq != 0 {
		t.Fatalf("bob last_read_seq = %d, want 0", ch.LastReadSeq)
	}

	got, err := st.MarkChannelRead(c, channelID, bobID, lastSeq)
	if err != nil {
		t.Fatalf("MarkChannelRead: %v", err)
	}
	if got != lastSeq {
		t.Fatalf("MarkChannelRead returned %d, want %d", got, lastSeq)
	}
	ch = channelFor(t, st, bobID, channelID)
	if ch.LastSeq != ch.LastReadSeq {
		t.Errorf("after mark read: last_seq=%d last_read_seq=%d, want equal", ch.LastSeq, ch.LastReadSeq)
	}
}

func TestReads_CursorIsMonotonicAndClamped(t *testing.T) {
	st := openStore(t)
	c := ctx(t)
	channelID, aliceDev, _ := seedReadsChannel(t, st)
	lastSeq := sendN(t, st, channelID, aliceDev, 5)

	if _, err := st.MarkChannelRead(c, channelID, bobID, lastSeq); err != nil {
		t.Fatalf("MarkChannelRead: %v", err)
	}

	// A stale mark_read from a slower device must not rewind the cursor.
	got, err := st.MarkChannelRead(c, channelID, bobID, 2)
	if err != nil {
		t.Fatalf("MarkChannelRead (rewind): %v", err)
	}
	if got != lastSeq {
		t.Errorf("rewind moved cursor to %d, want it pinned at %d", got, lastSeq)
	}

	// A client guessing past the end must not skip messages it never saw.
	got, err = st.MarkChannelRead(c, channelID, bobID, lastSeq+1000)
	if err != nil {
		t.Fatalf("MarkChannelRead (overshoot): %v", err)
	}
	if got != lastSeq {
		t.Errorf("overshoot set cursor to %d, want clamped to %d", got, lastSeq)
	}
}

func TestReads_CursorsArePerUser(t *testing.T) {
	st := openStore(t)
	c := ctx(t)
	channelID, aliceDev, _ := seedReadsChannel(t, st)
	lastSeq := sendN(t, st, channelID, aliceDev, 2)

	if _, err := st.MarkChannelRead(c, channelID, bobID, lastSeq); err != nil {
		t.Fatalf("MarkChannelRead(bob): %v", err)
	}

	bobCursor, err := st.GetChannelRead(c, channelID, bobID)
	if err != nil {
		t.Fatalf("GetChannelRead(bob): %v", err)
	}
	if bobCursor != lastSeq {
		t.Errorf("bob cursor = %d, want %d", bobCursor, lastSeq)
	}
	// Alice inserted the messages directly (no send handler), so her cursor
	// is untouched -- proving bob's read didn't write through to her row.
	aliceCursor, err := st.GetChannelRead(c, channelID, aliceID)
	if err != nil {
		t.Fatalf("GetChannelRead(alice): %v", err)
	}
	if aliceCursor != 0 {
		t.Errorf("alice cursor = %d, want 0 (bob's read leaked)", aliceCursor)
	}
}

func TestReads_NewMemberStartsCaughtUp(t *testing.T) {
	st := openStore(t)
	c := ctx(t)
	channelID, aliceDev, _ := seedReadsChannel(t, st)
	lastSeq := sendN(t, st, channelID, aliceDev, 4)

	if err := st.AddMember(c, channelID, carolID); err != nil {
		t.Fatalf("AddMember: %v", err)
	}
	ch := channelFor(t, st, carolID, channelID)
	if ch.LastReadSeq != lastSeq {
		t.Errorf("new member cursor = %d, want %d (should join caught up)", ch.LastReadSeq, lastSeq)
	}
	if ch.LastSeq != ch.LastReadSeq {
		t.Errorf("new member sees unread: last_seq=%d last_read_seq=%d", ch.LastSeq, ch.LastReadSeq)
	}
}

func TestReads_UnknownChannelIsRejected(t *testing.T) {
	st := openStore(t)
	if _, err := st.MarkChannelRead(ctx(t), uuid.New(), aliceID, 1); err != store.ErrChannelNotFound {
		t.Errorf("MarkChannelRead(unknown channel) = %v, want ErrChannelNotFound", err)
	}
}
