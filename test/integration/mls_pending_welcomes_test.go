package integration

// Phase 11c-1 PR 4: integration tests for the mls_pending_welcomes
// store. Reuses the setupPhase11c1 helper from PR 1's
// mls_commits_test.go (same package).
//
// Six scenarios:
//   * InsertAndDrain: basic round trip
//   * DrainEmpty: zero-row case returns empty slice (not nil)
//   * DrainPreservesRows: drain doesn't delete
//   * UpsertReplaces: second insert for (user, channel) overwrites
//   * Delete: explicit DELETE removes the row
//   * UserCascade: deleting a user cascades to their pending welcomes
//   * ChannelCascade: deleting a channel cascades

import (
	"testing"

	"github.com/google/uuid"
)

func TestPhase11c1_MlsPendingWelcomes_InsertAndDrain(t *testing.T) {
	st, channelID, aliceID, _ := setupPhase11c1(t)
	c := ctx(t)

	bobID := uuid.MustParse(phase11c1BobID)
	groupID := []byte{0x01, 0x02, 0x03}
	welcomeBytes := []byte("welcome bytes for bob")

	// alice queues a welcome for bob.
	if err := st.InsertPendingWelcome(
		c, bobID, channelID, groupID, welcomeBytes, aliceID,
	); err != nil {
		t.Fatalf("InsertPendingWelcome: %v", err)
	}

	got, err := st.DrainPendingWelcomesForUser(c, bobID)
	if err != nil {
		t.Fatalf("Drain: %v", err)
	}
	if len(got) != 1 {
		t.Fatalf("Drain returned %d rows, want 1", len(got))
	}
	w := got[0]
	if w.UserID != bobID {
		t.Errorf("user_id = %s, want %s", w.UserID, bobID)
	}
	if w.ChannelID != channelID {
		t.Errorf("channel_id = %s, want %s", w.ChannelID, channelID)
	}
	if !bytesEqual(w.MlsGroupID, groupID) {
		t.Errorf("mls_group_id = %x, want %x", w.MlsGroupID, groupID)
	}
	if !bytesEqual(w.WelcomeBytes, welcomeBytes) {
		t.Errorf("welcome_bytes = %x, want %x", w.WelcomeBytes, welcomeBytes)
	}
	if w.SenderUserID != aliceID {
		t.Errorf("sender_user_id = %s, want %s", w.SenderUserID, aliceID)
	}
}

func TestPhase11c1_MlsPendingWelcomes_DrainEmpty(t *testing.T) {
	st, _, _, _ := setupPhase11c1(t)
	c := ctx(t)

	bobID := uuid.MustParse(phase11c1BobID)
	got, err := st.DrainPendingWelcomesForUser(c, bobID)
	if err != nil {
		t.Fatalf("Drain: %v", err)
	}
	if got == nil {
		t.Error("Drain returned nil slice; want empty slice")
	}
	if len(got) != 0 {
		t.Errorf("Drain returned %d rows, want 0", len(got))
	}
}

func TestPhase11c1_MlsPendingWelcomes_DrainPreservesRows(t *testing.T) {
	st, channelID, aliceID, _ := setupPhase11c1(t)
	c := ctx(t)

	bobID := uuid.MustParse(phase11c1BobID)
	if err := st.InsertPendingWelcome(
		c, bobID, channelID, []byte{0xab}, []byte("welcome"), aliceID,
	); err != nil {
		t.Fatalf("InsertPendingWelcome: %v", err)
	}

	// Drain once.
	first, _ := st.DrainPendingWelcomesForUser(c, bobID)
	if len(first) != 1 {
		t.Fatalf("first drain: %d rows, want 1", len(first))
	}

	// Drain again -- should still return the same row.
	second, _ := st.DrainPendingWelcomesForUser(c, bobID)
	if len(second) != 1 {
		t.Errorf("second drain: %d rows, want 1 (drain should not delete)", len(second))
	}
}

func TestPhase11c1_MlsPendingWelcomes_UpsertReplaces(t *testing.T) {
	st, channelID, aliceID, _ := setupPhase11c1(t)
	c := ctx(t)

	bobID := uuid.MustParse(phase11c1BobID)
	firstWelcome := []byte("first welcome")
	secondWelcome := []byte("a fresher welcome bytes")

	if err := st.InsertPendingWelcome(
		c, bobID, channelID, []byte{0x01}, firstWelcome, aliceID,
	); err != nil {
		t.Fatalf("first Insert: %v", err)
	}
	if err := st.InsertPendingWelcome(
		c, bobID, channelID, []byte{0x02}, secondWelcome, aliceID,
	); err != nil {
		t.Fatalf("second Insert: %v", err)
	}

	got, _ := st.DrainPendingWelcomesForUser(c, bobID)
	if len(got) != 1 {
		t.Fatalf("rows after upsert = %d, want 1 (PK should enforce single row)", len(got))
	}
	if !bytesEqual(got[0].WelcomeBytes, secondWelcome) {
		t.Errorf("welcome_bytes = %x, want second welcome %x", got[0].WelcomeBytes, secondWelcome)
	}
}

func TestPhase11c1_MlsPendingWelcomes_Delete(t *testing.T) {
	st, channelID, aliceID, _ := setupPhase11c1(t)
	c := ctx(t)

	bobID := uuid.MustParse(phase11c1BobID)
	if err := st.InsertPendingWelcome(
		c, bobID, channelID, []byte{0x01}, []byte("welcome"), aliceID,
	); err != nil {
		t.Fatalf("Insert: %v", err)
	}

	if err := st.DeletePendingWelcome(c, bobID, channelID); err != nil {
		t.Fatalf("Delete: %v", err)
	}
	got, _ := st.DrainPendingWelcomesForUser(c, bobID)
	if len(got) != 0 {
		t.Errorf("rows after delete = %d, want 0", len(got))
	}

	// Idempotent: deleting again is a no-op.
	if err := st.DeletePendingWelcome(c, bobID, channelID); err != nil {
		t.Errorf("idempotent Delete: %v", err)
	}
}

func TestPhase11c1_MlsPendingWelcomes_CountForUser(t *testing.T) {
	st, channelID, aliceID, _ := setupPhase11c1(t)
	c := ctx(t)

	bobID := uuid.MustParse(phase11c1BobID)

	if n, _ := st.CountPendingWelcomesForUser(c, bobID); n != 0 {
		t.Errorf("Count before insert = %d, want 0", n)
	}
	if err := st.InsertPendingWelcome(
		c, bobID, channelID, []byte{0x01}, []byte("welcome"), aliceID,
	); err != nil {
		t.Fatalf("Insert: %v", err)
	}
	if n, _ := st.CountPendingWelcomesForUser(c, bobID); n != 1 {
		t.Errorf("Count after insert = %d, want 1", n)
	}
}

func TestPhase11c1_MlsPendingWelcomes_ChannelCascade(t *testing.T) {
	st, channelID, aliceID, _ := setupPhase11c1(t)
	c := ctx(t)

	bobID := uuid.MustParse(phase11c1BobID)
	if err := st.InsertPendingWelcome(
		c, bobID, channelID, []byte{0x01}, []byte("welcome"), aliceID,
	); err != nil {
		t.Fatalf("Insert: %v", err)
	}
	// Delete the channel; row should cascade-delete.
	if _, err := st.Pool.Exec(c, `DELETE FROM channels WHERE id = $1`, channelID); err != nil {
		t.Fatalf("delete channel: %v", err)
	}
	if n, _ := st.CountPendingWelcomesForUser(c, bobID); n != 0 {
		t.Errorf("pending welcomes count after channel delete = %d, want 0 (cascade)", n)
	}
}

func TestPhase11c1_MlsPendingWelcomes_EmptyBytesRejected(t *testing.T) {
	st, channelID, aliceID, _ := setupPhase11c1(t)
	c := ctx(t)

	bobID := uuid.MustParse(phase11c1BobID)
	// Empty welcome bytes.
	if err := st.InsertPendingWelcome(
		c, bobID, channelID, []byte{0x01}, nil, aliceID,
	); err == nil {
		t.Error("Insert accepted nil welcome_bytes")
	}
	if err := st.InsertPendingWelcome(
		c, bobID, channelID, []byte{0x01}, []byte{}, aliceID,
	); err == nil {
		t.Error("Insert accepted empty welcome_bytes")
	}
	// Empty group id.
	if err := st.InsertPendingWelcome(
		c, bobID, channelID, nil, []byte("welcome"), aliceID,
	); err == nil {
		t.Error("Insert accepted nil mls_group_id")
	}
}

func TestPhase11c1_MlsPendingWelcomes_SizeCapRejection(t *testing.T) {
	st, channelID, aliceID, _ := setupPhase11c1(t)
	c := ctx(t)

	bobID := uuid.MustParse(phase11c1BobID)
	tooBig := make([]byte, 65537)
	for i := range tooBig {
		tooBig[i] = 0xff
	}
	if err := st.InsertPendingWelcome(
		c, bobID, channelID, []byte{0x01}, tooBig, aliceID,
	); err == nil {
		t.Error("Insert accepted 64KB+1 welcome")
	}

	// Exactly 64KB should succeed.
	atLimit := make([]byte, 65536)
	for i := range atLimit {
		atLimit[i] = 0xab
	}
	if err := st.InsertPendingWelcome(
		c, bobID, channelID, []byte{0x01}, atLimit, aliceID,
	); err != nil {
		t.Errorf("Insert at exactly 64KB: %v", err)
	}
}
