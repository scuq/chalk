// Phase 11c-1 PR 3: tests for InsertMlsCommitAndApplyMembership.
//
// Builds on PR 1's mls_commits_test.go but adds coverage for the
// combined commit + membership mutation path. We reuse the
// setupPhase11c1 helper from that file (same package).
//
// Five scenarios:
//   * NoMembershipChange: empty add/remove slices behaves like PR 1
//   * AddOneMember: channel_members row appears, commit stored
//   * RemoveOneMember: channel_members row gone, commit stored
//   * AddAndRemoveInOneCommit: bulk change is atomic
//   * RaceRollsBackMembership: stale-commit detection rolls back the
//     channel_members mutations too (atomicity check)

package integration

import (
	"errors"
	"testing"

	"github.com/google/uuid"

	"github.com/scuq/chalk/internal/store"
)

const (
	phase11c1CarolID = "00000000-0000-0000-0000-0000000ca201"
)

func TestPhase11c1_MlsCommitMembership_NoMembershipChange(t *testing.T) {
	st, channelID, aliceID, aliceDeviceID := setupPhase11c1(t)
	c := ctx(t)

	commitBytes := []byte("update commit, no membership change")
	err := st.InsertMlsCommitAndApplyMembership(
		c, channelID, 1, commitBytes,
		aliceID, aliceDeviceID,
		nil, nil,
	)
	if err != nil {
		t.Fatalf("InsertMlsCommitAndApplyMembership: %v", err)
	}

	// Verify commit stored.
	got, err := st.GetMlsCommitAt(c, channelID, 1)
	if err != nil || got == nil {
		t.Fatalf("commit not stored: got=%v err=%v", got, err)
	}
	// Verify channel_members unchanged (alice + bob from setup).
	var n int
	if err := st.Pool.QueryRow(c,
		`SELECT count(*) FROM channel_members WHERE channel_id = $1`,
		channelID,
	).Scan(&n); err != nil {
		t.Fatalf("count members: %v", err)
	}
	if n != 2 {
		t.Errorf("member count = %d, want 2 (setup adds alice + bob)", n)
	}
}

func TestPhase11c1_MlsCommitMembership_AddOneMember(t *testing.T) {
	st, channelID, aliceID, aliceDeviceID := setupPhase11c1(t)
	c := ctx(t)

	carolID := uuid.MustParse(phase11c1CarolID)

	// Verify carol is NOT a member to start.
	isMemBefore, err := st.IsMember(c, channelID, carolID)
	if err != nil {
		t.Fatalf("IsMember before: %v", err)
	}
	if isMemBefore {
		t.Fatal("carol should not be a member at test start")
	}

	commitBytes := []byte("commit adding carol")
	err = st.InsertMlsCommitAndApplyMembership(
		c, channelID, 1, commitBytes,
		aliceID, aliceDeviceID,
		[]uuid.UUID{carolID}, nil,
	)
	if err != nil {
		t.Fatalf("InsertMlsCommitAndApplyMembership: %v", err)
	}

	// Verify commit stored.
	if got, err := st.GetMlsCommitAt(c, channelID, 1); err != nil || got == nil {
		t.Fatalf("commit not stored: got=%v err=%v", got, err)
	}
	// Verify carol is now a member.
	isMemAfter, err := st.IsMember(c, channelID, carolID)
	if err != nil {
		t.Fatalf("IsMember after: %v", err)
	}
	if !isMemAfter {
		t.Error("carol should be a member after add commit")
	}

	// Verify add is idempotent: re-call with same args succeeds
	// (PR 1's idempotent-retry path) without duplicating the row.
	err = st.InsertMlsCommitAndApplyMembership(
		c, channelID, 1, commitBytes,
		aliceID, aliceDeviceID,
		[]uuid.UUID{carolID}, nil,
	)
	if err != nil {
		t.Errorf("idempotent retry: %v", err)
	}
	var n int
	if err := st.Pool.QueryRow(c,
		`SELECT count(*) FROM channel_members
		   WHERE channel_id = $1 AND user_id = $2`,
		channelID, carolID,
	).Scan(&n); err != nil {
		t.Fatalf("count carol rows: %v", err)
	}
	if n != 1 {
		t.Errorf("carol's channel_members rows = %d, want 1", n)
	}
}

func TestPhase11c1_MlsCommitMembership_RemoveOneMember(t *testing.T) {
	st, channelID, aliceID, aliceDeviceID := setupPhase11c1(t)
	c := ctx(t)

	bobID := uuid.MustParse(phase11c1BobID)
	// Bob is a member from setupPhase11c1.

	commitBytes := []byte("commit removing bob")
	err := st.InsertMlsCommitAndApplyMembership(
		c, channelID, 1, commitBytes,
		aliceID, aliceDeviceID,
		nil, []uuid.UUID{bobID},
	)
	if err != nil {
		t.Fatalf("InsertMlsCommitAndApplyMembership: %v", err)
	}

	isMem, err := st.IsMember(c, channelID, bobID)
	if err != nil {
		t.Fatalf("IsMember: %v", err)
	}
	if isMem {
		t.Error("bob should no longer be a member after remove commit")
	}

	// Removing a non-member is a no-op.
	err = st.InsertMlsCommitAndApplyMembership(
		c, channelID, 1, commitBytes,
		aliceID, aliceDeviceID,
		nil, []uuid.UUID{bobID},
	)
	if err != nil {
		t.Errorf("idempotent remove retry: %v", err)
	}
}

func TestPhase11c1_MlsCommitMembership_AddAndRemoveInOneCommit(t *testing.T) {
	st, channelID, aliceID, aliceDeviceID := setupPhase11c1(t)
	c := ctx(t)

	bobID := uuid.MustParse(phase11c1BobID)
	carolID := uuid.MustParse(phase11c1CarolID)

	// One commit that adds carol AND removes bob.
	commitBytes := []byte("swap bob for carol")
	err := st.InsertMlsCommitAndApplyMembership(
		c, channelID, 1, commitBytes,
		aliceID, aliceDeviceID,
		[]uuid.UUID{carolID},
		[]uuid.UUID{bobID},
	)
	if err != nil {
		t.Fatalf("InsertMlsCommitAndApplyMembership: %v", err)
	}

	// carol should now be a member; bob should not.
	carolIsMem, _ := st.IsMember(c, channelID, carolID)
	if !carolIsMem {
		t.Error("carol should be a member")
	}
	bobIsMem, _ := st.IsMember(c, channelID, bobID)
	if bobIsMem {
		t.Error("bob should not be a member")
	}
}

func TestPhase11c1_MlsCommitMembership_RaceRollsBackMembership(t *testing.T) {
	// Atomicity check: if the commit insert race-loses (someone else
	// already committed at this epoch with different bytes), the
	// membership mutations must also roll back.
	st, channelID, aliceID, aliceDeviceID := setupPhase11c1(t)
	c := ctx(t)

	bobID := uuid.MustParse(phase11c1BobID)
	carolID := uuid.MustParse(phase11c1CarolID)

	// Alice gets there first with one commit.
	if err := st.InsertMlsCommit(
		c, channelID, 1, []byte("alice's commit"),
		aliceID, aliceDeviceID,
	); err != nil {
		t.Fatalf("alice's commit: %v", err)
	}

	// Now bob (well, alice claiming to be at the same epoch but with
	// different bytes) tries to commit with proposed add/remove.
	// Should race-lose AND not mutate channel_members.
	err := st.InsertMlsCommitAndApplyMembership(
		c, channelID, 1, []byte("a different commit body"),
		aliceID, aliceDeviceID,
		[]uuid.UUID{carolID}, []uuid.UUID{bobID},
	)
	if err == nil {
		t.Fatal("expected ErrMlsCommitEpochExists, got nil")
	}
	if !errors.Is(err, store.ErrMlsCommitEpochExists) {
		t.Errorf("err = %v, want ErrMlsCommitEpochExists", err)
	}

	// Verify channel_members untouched: bob still a member, carol not.
	bobIsMem, _ := st.IsMember(c, channelID, bobID)
	if !bobIsMem {
		t.Error("bob should still be a member (race rollback)")
	}
	carolIsMem, _ := st.IsMember(c, channelID, carolID)
	if carolIsMem {
		t.Error("carol should not be a member (race rollback)")
	}
}
