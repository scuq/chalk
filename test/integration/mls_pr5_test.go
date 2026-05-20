package integration

// Phase 11c-1 PR 5: tests for the new store primitives that power
// MLS commit catchup + live broadcast.
//
// PR 5 also extends MlsCommit with CommittedAt; this file exercises
// the new field via the existing GetMlsCommitAt / ListMlsCommitsSince
// methods that PR 1 introduced.
//
// Note: the WS-level handler (handleFetchMlsCommits) and the live
// broadcast (fanOutMlsCommitEvent) are not tested in this PR.
// They require a full chalkd + WS-dialer harness; that arrives in
// the 11c-2 client-side phase. The pieces tested here are the store
// methods those handlers compose, plus the new ListMembersForChannel
// primitive.

import (
	"testing"
	"time"

	"github.com/google/uuid"
)

func TestPhase11c1_MlsListMembersForChannel(t *testing.T) {
	st, channelID, aliceID, _ := setupPhase11c1(t)
	c := ctx(t)
	bobID := uuid.MustParse(phase11c1BobID)

	members, err := st.ListMembersForChannel(c, channelID)
	if err != nil {
		t.Fatalf("ListMembersForChannel: %v", err)
	}
	// setupPhase11c1 seeds alice + bob.
	if len(members) != 2 {
		t.Errorf("len(members) = %d, want 2", len(members))
	}
	hasAlice, hasBob := false, false
	for _, m := range members {
		if m == aliceID {
			hasAlice = true
		}
		if m == bobID {
			hasBob = true
		}
	}
	if !hasAlice || !hasBob {
		t.Errorf("members missing alice or bob: %v", members)
	}
}

func TestPhase11c1_MlsListMembersForChannel_Empty(t *testing.T) {
	st, _, _, _ := setupPhase11c1(t)
	c := ctx(t)

	// Brand new channel with no members.
	emptyChannelID := uuid.New()
	if _, err := st.Pool.Exec(c,
		`INSERT INTO channels (id, name, is_dm, is_mls)
		 VALUES ($1, 'phase-11c1-test-empty', false, true)`,
		emptyChannelID,
	); err != nil {
		t.Fatalf("insert empty channel: %v", err)
	}
	defer st.Pool.Exec(c, `DELETE FROM channels WHERE id = $1`, emptyChannelID)

	members, err := st.ListMembersForChannel(c, emptyChannelID)
	if err != nil {
		t.Fatalf("ListMembersForChannel: %v", err)
	}
	if members == nil {
		t.Error("ListMembersForChannel returned nil; want empty slice")
	}
	if len(members) != 0 {
		t.Errorf("len(members) = %d, want 0", len(members))
	}
}

func TestPhase11c1_MlsListMembersForChannel_Nonexistent(t *testing.T) {
	st, _, _, _ := setupPhase11c1(t)
	c := ctx(t)

	members, err := st.ListMembersForChannel(c, uuid.New())
	if err != nil {
		t.Fatalf("ListMembersForChannel: %v", err)
	}
	if len(members) != 0 {
		t.Errorf("len(members) for nonexistent channel = %d, want 0", len(members))
	}
}

func TestPhase11c1_MlsCommitCommittedAt(t *testing.T) {
	// PR 5 extension: MlsCommit gains CommittedAt. Confirm it
	// roundtrips correctly via Get + List.
	st, channelID, aliceID, aliceDeviceID := setupPhase11c1(t)
	c := ctx(t)

	before := time.Now().UTC()
	if err := st.InsertMlsCommit(c, channelID, 1, []byte{0x01, 0x02},
		aliceID, aliceDeviceID,
	); err != nil {
		t.Fatalf("InsertMlsCommit: %v", err)
	}
	after := time.Now().UTC()

	got, err := st.GetMlsCommitAt(c, channelID, 1)
	if err != nil || got == nil {
		t.Fatalf("GetMlsCommitAt: got=%v err=%v", got, err)
	}
	if got.CommittedAt.IsZero() {
		t.Error("CommittedAt is zero; expected DB-set NOW()")
	}
	// Should be in [before, after]. Allow a small skew because the
	// DB's clock may differ slightly from ours; +/- 5s is generous.
	if got.CommittedAt.Before(before.Add(-5*time.Second)) ||
		got.CommittedAt.After(after.Add(5*time.Second)) {
		t.Errorf("CommittedAt %v outside expected range [%v, %v]",
			got.CommittedAt, before, after)
	}

	// And via ListMlsCommitsSince.
	list, err := st.ListMlsCommitsSince(c, channelID, 0)
	if err != nil {
		t.Fatalf("ListMlsCommitsSince: %v", err)
	}
	if len(list) != 1 {
		t.Fatalf("list length = %d, want 1", len(list))
	}
	if list[0].CommittedAt.IsZero() {
		t.Error("list[0].CommittedAt is zero")
	}
	if !list[0].CommittedAt.Equal(got.CommittedAt) {
		t.Errorf("CommittedAt mismatch: Get=%v List=%v",
			got.CommittedAt, list[0].CommittedAt)
	}
}
