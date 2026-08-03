package store

// 80-9: the guest data path against a real Postgres AS chalk_guest (skips
// without CHALK_TEST_PGURL). Reuses the grants scaffolding: same seeded room
// (alice + guest, outsider bob elsewhere), same SET ROLE guest pool -- so
// every method here is exercised under the exact policies production runs.

import (
	"bytes"
	"context"
	"errors"
	"testing"

	"github.com/google/uuid"
)

func TestGuestDataPath(t *testing.T) {
	owner, g := setupGrantsDB(t)
	ctx := context.Background()

	// Channel summary: the one room, both members, display names not handles.
	summary, names, err := g.ChannelSummary(ctx, gGuest, gRoom)
	if err != nil {
		t.Fatalf("ChannelSummary: %v", err)
	}
	if summary.ID != gRoom || len(summary.MemberIDs) != 2 {
		t.Errorf("summary = %+v", summary)
	}
	if summary.ExpiresAt == nil {
		t.Error("summary must carry the expiry")
	}
	if names[gAlice] != "Alice" || names[gGuest] != "Gustl" {
		t.Errorf("names = %v, want display names", names)
	}

	// History: the seeded message, sender resolved through devices.
	msgs, err := g.History(ctx, gGuest, gRoom, 0, 50)
	if err != nil {
		t.Fatalf("History: %v", err)
	}
	if len(msgs) != 1 || msgs[0].SenderUserID != gAlice {
		t.Errorf("history = %+v", msgs)
	}

	// Send: lands with the next seq, advances the own cursor, bumps the
	// activity pointer.
	msgID, seq, _, err := g.SendScratch(ctx, gGuest, gRoom, gDevG,
		[]byte{0x05}, 1, "cli-1", "inst", "conn")
	if err != nil {
		t.Fatalf("SendScratch: %v", err)
	}
	var gotSeq int64
	var lastMsg uuid.UUID
	if err := owner.QueryRow(ctx,
		`SELECT cr.last_read_seq, ca.last_msg_id
		   FROM channel_reads cr, channel_activity ca
		  WHERE cr.user_id = $1 AND cr.channel_id = $2 AND ca.channel_id = $2`,
		gGuest, gRoom).Scan(&gotSeq, &lastMsg); err != nil {
		t.Fatal(err)
	}
	if gotSeq != seq || lastMsg != msgID {
		t.Errorf("cursor/activity after send: seq=%d (want %d) last=%s (want %s)",
			gotSeq, seq, lastMsg, msgID)
	}

	// A send claiming a future key version refuses.
	if _, _, _, err := g.SendScratch(ctx, gGuest, gRoom, gDevG,
		[]byte{0x06}, 99, "", "inst", "conn"); !errors.Is(err, ErrStaleKeyVersion) {
		t.Errorf("future key version: want ErrStaleKeyVersion, got %v", err)
	}

	// MarkRead through the guest role.
	if err := g.MarkRead(ctx, gGuest, gRoom, seq); err != nil {
		t.Errorf("MarkRead: %v", err)
	}

	// Identity: alice from identity_keys; the guest itself from the
	// ephemeral table (the fallback both guests in a room depend on).
	if k, err := g.FetchIdentity(ctx, gGuest, gRoom, gAlice); err != nil || len(k.Ed25519Pub) != 32 {
		t.Errorf("FetchIdentity(alice): %v %d", err, len(k.Ed25519Pub))
	}
	if k, err := g.FetchIdentity(ctx, gGuest, gRoom, gGuest); err != nil || k.Generation != 1 {
		t.Errorf("FetchIdentity(guest, ephemeral fallback): %v %+v", err, k)
	}
	// Bob is an outsider: invisible, not just keyless.
	if _, err := g.FetchIdentity(ctx, gGuest, gRoom, gBob); !errors.Is(err, ErrNotFound) {
		t.Errorf("FetchIdentity(outsider): want ErrNotFound, got %v", err)
	}

	// Own wrap only.
	suite, blob, err := g.OwnKeyWrap(ctx, gGuest, gRoom, 1)
	if err != nil || suite != 1 || !bytes.Equal(blob, []byte{0x02}) {
		t.Errorf("OwnKeyWrap: %v suite=%d blob=%x", err, suite, blob)
	}

	// Devices: a fresh id registers; ALICE's id is unavailable, not rebound.
	if err := g.EnsureDevice(ctx, gGuest, gRoom, uuid.New(), "desktop"); err != nil {
		t.Errorf("EnsureDevice(fresh): %v", err)
	}
	if err := g.EnsureDevice(ctx, gGuest, gRoom, gDevA, "desktop"); err == nil {
		t.Error("EnsureDevice(alice's device) must refuse")
	}
	var owner2 uuid.UUID
	if err := owner.QueryRow(ctx,
		`SELECT user_id FROM devices WHERE id = $1`, gDevA).Scan(&owner2); err != nil {
		t.Fatal(err)
	}
	if owner2 != gAlice {
		t.Errorf("alice's device was rebound to %s", owner2)
	}

	// App-side fallback: a real member fetching the guest's identity.
	s := &Store{Pool: owner}
	if k, err := s.GetActiveIdentityKeyAny(ctx, gGuest); err != nil || k.Generation != 1 {
		t.Errorf("GetActiveIdentityKeyAny(guest): %v %+v", err, k)
	}

	// AddMember refusal + directory exclusion.
	if err := s.AddMember(ctx, gOther, gGuest); !errors.Is(err, ErrGuestImmutable) {
		t.Errorf("AddMember(guest): want ErrGuestImmutable, got %v", err)
	}
	dir, err := s.ListDirectoryUsers(ctx, uuid.Nil)
	if err != nil {
		t.Fatal(err)
	}
	for _, u := range dir {
		if u.ID == gGuest {
			t.Error("guest appears in the user directory")
		}
	}
}
