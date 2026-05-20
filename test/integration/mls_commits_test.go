package integration

// Phase 11c-1: integration tests for mls_commits store.
//
// Covers:
//   * TestPhase11c1_MlsCommits_InsertAndRetrieve -- happy-path round
//     trip; insert one commit, fetch it back via GetMlsCommitAt.
//   * TestPhase11c1_MlsCommits_IdempotentRetry -- same sender posting
//     the same bytes at the same epoch twice succeeds both times
//     (network retry simulation).
//   * TestPhase11c1_MlsCommits_RaceDifferentBytes -- two different
//     senders racing on the same epoch: first wins, second sees
//     ErrMlsCommitEpochExists.
//   * TestPhase11c1_MlsCommits_RaceSameSenderDifferentBytes -- one
//     sender posts two different commits at the same epoch (bug or
//     client misbehavior): second posting rejected.
//   * TestPhase11c1_MlsCommits_ListSince -- catchup scenario; insert
//     a sequence and verify ListMlsCommitsSince returns the right
//     slice in epoch order.
//   * TestPhase11c1_MlsCommits_SizeCapRejection -- a 65KB+1 commit
//     is rejected (DB-level CHECK constraint).
//   * TestPhase11c1_MlsCommits_EmptyBytesRejected -- empty
//     commit_bytes rejected at the store layer.
//   * TestPhase11c1_MlsCommits_ChannelCascade -- deleting a channel
//     cascades to its mls_commits rows.
//
// Tests skip if CHALK_TEST_PGURL is unset, matching the rest of
// test/integration/.

import (
	"context"
	"errors"
	"testing"

	"github.com/google/uuid"

	"github.com/scuq/chalk/internal/store"
)

const (
	phase11c1AliceID = "00000000-0000-0000-0000-00000000a11c"
	phase11c1BobID   = "00000000-0000-0000-0000-000000000b0b"
)

// setupPhase11c1 builds a fresh channel + two members on it and
// returns the channel_id along with the store. The phase-08 fixture
// users (alice + bob) are reused; we just need a channel they're
// both in so the mls_commits rows have valid FK targets.
func setupPhase11c1(t *testing.T) (*store.Store, uuid.UUID, uuid.UUID, uuid.UUID) {
	t.Helper()
	st := openStore(t)
	c := ctx(t)

	aliceID := uuid.MustParse(phase11c1AliceID)
	bobID := uuid.MustParse(phase11c1BobID)

	// Wipe state from any prior phase-11c1 run.
	if _, err := st.Pool.Exec(c,
		`DELETE FROM mls_commits
		   WHERE channel_id IN (
		     SELECT id FROM channels
		      WHERE name LIKE 'phase-11c1-test%'
		   )`,
	); err != nil {
		t.Fatalf("wipe mls_commits: %v", err)
	}
	if _, err := st.Pool.Exec(c,
		`DELETE FROM channel_members
		   WHERE channel_id IN (
		     SELECT id FROM channels
		      WHERE name LIKE 'phase-11c1-test%'
		   )`,
	); err != nil {
		t.Fatalf("wipe channel_members: %v", err)
	}
	if _, err := st.Pool.Exec(c,
		`DELETE FROM channels WHERE name LIKE 'phase-11c1-test%'`,
	); err != nil {
		t.Fatalf("wipe channels: %v", err)
	}

	// Find or create an alice-device row for committed_by_device.
	// Phase-09b's device-link migrations require a non-null device
	// reference; we pick or create an alice device.
	var aliceDeviceID uuid.UUID
	err := st.Pool.QueryRow(c,
		`SELECT id FROM devices WHERE user_id = $1 LIMIT 1`,
		aliceID,
	).Scan(&aliceDeviceID)
	if err != nil {
		// No device for alice yet -> create one for the test.
		aliceDeviceID = uuid.New()
		if _, err := st.Pool.Exec(c,
			`INSERT INTO devices (id, user_id, device_label)
			 VALUES ($1, $2, $3)`,
			aliceDeviceID, aliceID, "phase-11c1-test-device",
		); err != nil {
			t.Fatalf("insert alice device: %v", err)
		}
	}

	// Create a fresh channel for the test.
	channelID := uuid.New()
	if _, err := st.Pool.Exec(c,
		`INSERT INTO channels (id, name, is_dm, is_mls, created_at)
		 VALUES ($1, 'phase-11c1-test-channel', false, true, NOW())`,
		channelID,
	); err != nil {
		t.Fatalf("create channel: %v", err)
	}
	if _, err := st.Pool.Exec(c,
		`INSERT INTO channel_members (channel_id, user_id)
		 VALUES ($1, $2), ($1, $3)`,
		channelID, aliceID, bobID,
	); err != nil {
		t.Fatalf("add channel members: %v", err)
	}

	t.Cleanup(func() {
		ctxCleanup, cancel := context.WithCancel(context.Background())
		defer cancel()
		_, _ = st.Pool.Exec(ctxCleanup,
			`DELETE FROM channels WHERE id = $1`, channelID)
		// mls_commits cascade-deletes via FK ON DELETE CASCADE.
	})

	return st, channelID, aliceID, aliceDeviceID
}

func TestPhase11c1_MlsCommits_InsertAndRetrieve(t *testing.T) {
	st, channelID, aliceID, aliceDeviceID := setupPhase11c1(t)
	c := ctx(t)

	commitBytes := []byte{0x01, 0x02, 0x03, 0x04, 0x05}
	if err := st.InsertMlsCommit(c, channelID, 1, commitBytes, aliceID, aliceDeviceID); err != nil {
		t.Fatalf("InsertMlsCommit: %v", err)
	}

	got, err := st.GetMlsCommitAt(c, channelID, 1)
	if err != nil {
		t.Fatalf("GetMlsCommitAt: %v", err)
	}
	if got == nil {
		t.Fatal("GetMlsCommitAt returned nil; expected a row")
	}
	if got.Epoch != 1 {
		t.Errorf("epoch = %d, want 1", got.Epoch)
	}
	if !bytesEqual(got.CommitBytes, commitBytes) {
		t.Errorf("commit_bytes = %x, want %x", got.CommitBytes, commitBytes)
	}
	if got.CommittedByUserID != aliceID {
		t.Errorf("committed_by_user = %s, want %s", got.CommittedByUserID, aliceID)
	}
	if got.CommittedByDeviceID != aliceDeviceID {
		t.Errorf("committed_by_device = %s, want %s", got.CommittedByDeviceID, aliceDeviceID)
	}

	// Missing epoch returns nil, no error.
	got2, err := st.GetMlsCommitAt(c, channelID, 99)
	if err != nil {
		t.Fatalf("GetMlsCommitAt(missing): %v", err)
	}
	if got2 != nil {
		t.Errorf("GetMlsCommitAt(missing) = %+v, want nil", got2)
	}
}

func TestPhase11c1_MlsCommits_IdempotentRetry(t *testing.T) {
	st, channelID, aliceID, aliceDeviceID := setupPhase11c1(t)
	c := ctx(t)

	commitBytes := []byte("identical-bytes-from-alice")

	// First insert -- fresh, succeeds.
	if err := st.InsertMlsCommit(c, channelID, 1, commitBytes, aliceID, aliceDeviceID); err != nil {
		t.Fatalf("first InsertMlsCommit: %v", err)
	}
	// Second insert with identical (sender, bytes, epoch) -- treated
	// as a network retry, succeeds idempotently.
	if err := st.InsertMlsCommit(c, channelID, 1, commitBytes, aliceID, aliceDeviceID); err != nil {
		t.Fatalf("idempotent retry InsertMlsCommit: %v", err)
	}
	// Verify still exactly one row.
	var n int
	if err := st.Pool.QueryRow(c,
		`SELECT count(*) FROM mls_commits WHERE channel_id = $1 AND epoch = 1`,
		channelID,
	).Scan(&n); err != nil {
		t.Fatalf("count rows: %v", err)
	}
	if n != 1 {
		t.Errorf("row count after idempotent retry = %d, want 1", n)
	}
}

func TestPhase11c1_MlsCommits_RaceDifferentSenders(t *testing.T) {
	st, channelID, aliceID, aliceDeviceID := setupPhase11c1(t)
	c := ctx(t)

	bobID := uuid.MustParse(phase11c1BobID)
	// Bob needs a device too for the race scenario.
	var bobDeviceID uuid.UUID
	err := st.Pool.QueryRow(c,
		`SELECT id FROM devices WHERE user_id = $1 LIMIT 1`,
		bobID,
	).Scan(&bobDeviceID)
	if err != nil {
		bobDeviceID = uuid.New()
		if _, err := st.Pool.Exec(c,
			`INSERT INTO devices (id, user_id, device_label)
			 VALUES ($1, $2, $3)`,
			bobDeviceID, bobID, "phase-11c1-test-device-bob",
		); err != nil {
			t.Fatalf("insert bob device: %v", err)
		}
	}

	aliceCommit := []byte("alice's commit bytes")
	bobCommit := []byte("bob's commit bytes")

	// Alice wins.
	if err := st.InsertMlsCommit(c, channelID, 1, aliceCommit, aliceID, aliceDeviceID); err != nil {
		t.Fatalf("alice InsertMlsCommit: %v", err)
	}
	// Bob loses -- different sender, different bytes, same epoch.
	err = st.InsertMlsCommit(c, channelID, 1, bobCommit, bobID, bobDeviceID)
	if !errors.Is(err, store.ErrMlsCommitEpochExists) {
		t.Errorf("bob's InsertMlsCommit error = %v, want ErrMlsCommitEpochExists", err)
	}

	// Verify it's alice's bytes that landed.
	got, err := st.GetMlsCommitAt(c, channelID, 1)
	if err != nil {
		t.Fatalf("GetMlsCommitAt: %v", err)
	}
	if !bytesEqual(got.CommitBytes, aliceCommit) {
		t.Errorf("stored bytes are not alice's: got %x, want %x", got.CommitBytes, aliceCommit)
	}
}

func TestPhase11c1_MlsCommits_RaceSameSenderDifferentBytes(t *testing.T) {
	st, channelID, aliceID, aliceDeviceID := setupPhase11c1(t)
	c := ctx(t)

	firstBytes := []byte("first commit")
	secondBytes := []byte("a wildly different commit")

	if err := st.InsertMlsCommit(c, channelID, 1, firstBytes, aliceID, aliceDeviceID); err != nil {
		t.Fatalf("first InsertMlsCommit: %v", err)
	}
	// Same sender, different bytes -> still a race.
	err := st.InsertMlsCommit(c, channelID, 1, secondBytes, aliceID, aliceDeviceID)
	if !errors.Is(err, store.ErrMlsCommitEpochExists) {
		t.Errorf("InsertMlsCommit error = %v, want ErrMlsCommitEpochExists", err)
	}
}

func TestPhase11c1_MlsCommits_ListSince(t *testing.T) {
	st, channelID, aliceID, aliceDeviceID := setupPhase11c1(t)
	c := ctx(t)

	// Insert 5 commits at epochs 1..5.
	for epoch := int64(1); epoch <= 5; epoch++ {
		bytesAtEpoch := []byte{byte(epoch), 0xab, 0xcd}
		if err := st.InsertMlsCommit(c, channelID, epoch, bytesAtEpoch, aliceID, aliceDeviceID); err != nil {
			t.Fatalf("Insert epoch %d: %v", epoch, err)
		}
	}

	// Catchup from epoch 0 should return all 5.
	got, err := st.ListMlsCommitsSince(c, channelID, 0)
	if err != nil {
		t.Fatalf("ListMlsCommitsSince(0): %v", err)
	}
	if len(got) != 5 {
		t.Fatalf("count = %d, want 5", len(got))
	}
	// Verify ascending epoch order.
	for i, c := range got {
		if c.Epoch != int64(i+1) {
			t.Errorf("got[%d].Epoch = %d, want %d", i, c.Epoch, i+1)
		}
	}

	// Catchup from epoch 3 should return epochs 4, 5.
	got2, err := st.ListMlsCommitsSince(c, channelID, 3)
	if err != nil {
		t.Fatalf("ListMlsCommitsSince(3): %v", err)
	}
	if len(got2) != 2 {
		t.Fatalf("count from epoch 3 = %d, want 2", len(got2))
	}
	if got2[0].Epoch != 4 || got2[1].Epoch != 5 {
		t.Errorf("epochs from 3 = %d, %d; want 4, 5", got2[0].Epoch, got2[1].Epoch)
	}

	// Catchup from current returns empty slice (NOT nil).
	got3, err := st.ListMlsCommitsSince(c, channelID, 5)
	if err != nil {
		t.Fatalf("ListMlsCommitsSince(5): %v", err)
	}
	if got3 == nil {
		t.Error("ListMlsCommitsSince at HEAD returned nil; want empty slice")
	}
	if len(got3) != 0 {
		t.Errorf("count from HEAD = %d, want 0", len(got3))
	}
}

func TestPhase11c1_MlsCommits_SizeCapRejection(t *testing.T) {
	st, channelID, aliceID, aliceDeviceID := setupPhase11c1(t)
	c := ctx(t)

	// 64KB + 1 byte. Caught at the Go layer (before hitting DB).
	tooBig := make([]byte, 65537)
	for i := range tooBig {
		tooBig[i] = 0xff
	}
	err := st.InsertMlsCommit(c, channelID, 1, tooBig, aliceID, aliceDeviceID)
	if err == nil {
		t.Fatal("InsertMlsCommit accepted 64KB+1 commit; want rejection")
	}

	// Exactly 64KB should succeed.
	atLimit := make([]byte, 65536)
	for i := range atLimit {
		atLimit[i] = 0xab
	}
	if err := st.InsertMlsCommit(c, channelID, 2, atLimit, aliceID, aliceDeviceID); err != nil {
		t.Errorf("InsertMlsCommit at exactly 64KB: %v", err)
	}
}

func TestPhase11c1_MlsCommits_EmptyBytesRejected(t *testing.T) {
	st, channelID, aliceID, aliceDeviceID := setupPhase11c1(t)
	c := ctx(t)

	err := st.InsertMlsCommit(c, channelID, 1, nil, aliceID, aliceDeviceID)
	if err == nil {
		t.Fatal("InsertMlsCommit accepted nil bytes")
	}
	err = st.InsertMlsCommit(c, channelID, 1, []byte{}, aliceID, aliceDeviceID)
	if err == nil {
		t.Fatal("InsertMlsCommit accepted empty bytes")
	}
}

func TestPhase11c1_MlsCommits_ChannelCascade(t *testing.T) {
	st, channelID, aliceID, aliceDeviceID := setupPhase11c1(t)
	c := ctx(t)

	if err := st.InsertMlsCommit(c, channelID, 1, []byte{0x01}, aliceID, aliceDeviceID); err != nil {
		t.Fatalf("Insert: %v", err)
	}
	if _, err := st.Pool.Exec(c, `DELETE FROM channels WHERE id = $1`, channelID); err != nil {
		t.Fatalf("delete channel: %v", err)
	}
	got, err := st.GetMlsCommitAt(c, channelID, 1)
	if err != nil {
		t.Fatalf("GetMlsCommitAt after channel delete: %v", err)
	}
	if got != nil {
		t.Errorf("mls_commits row survived channel DELETE; got %+v", got)
	}
}

// bytesEqual is a local copy to keep this test file independent of
// the unexported helper in internal/store. Keeping it local also
// avoids the cycle where test/integration imports store and store
// would otherwise need to re-export.
func bytesEqual(a, b []byte) bool {
	if len(a) != len(b) {
		return false
	}
	for i := range a {
		if a[i] != b[i] {
			return false
		}
	}
	return true
}
