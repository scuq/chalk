package store

// 80-7: invite mint/list/revoke against a real Postgres (skips without
// CHALK_TEST_PGURL). The interesting properties: the guest cap is enforced
// atomically under the channel lock, revoking frees a slot, collisions map to
// ErrInviteExists, and a permanent channel refuses invites outright.

import (
	"context"
	"errors"
	"testing"
	"time"

	"github.com/google/uuid"
)

func TestEphemeralInvites(t *testing.T) {
	pool := openProbeDB(t, "chalk_invites_probe")
	ctx := context.Background()
	s := &Store{Pool: pool}

	creator := uuid.New()
	if _, err := pool.Exec(ctx,
		`INSERT INTO users (id, handle, username, display_name, email)
		 VALUES ($1,'erin','erin','Erin','erin@x.test')`, creator); err != nil {
		t.Fatal(err)
	}
	expires := time.Now().UTC().Add(2 * time.Hour)
	room, err := s.CreateChannel(ctx, CreateChannelInput{
		Name: "room", CreatedBy: creator, ChannelType: "voice", ExpiresAt: &expires,
	})
	if err != nil {
		t.Fatal(err)
	}
	perm, err := s.CreateChannel(ctx, CreateChannelInput{
		Name: "perm", CreatedBy: creator, ChannelType: "voice",
	})
	if err != nil {
		t.Fatal(err)
	}

	mk := func(seed byte) EphemeralInvite {
		lookup := make([]byte, 16)
		for i := range lookup {
			lookup[i] = seed
		}
		return EphemeralInvite{
			Lookup:      lookup,
			ChannelID:   room.ID,
			CreatedBy:   creator,
			GuestUserID: uuid.New(),
			X25519Pub:   keyBytes(seed, 32),
			Ed25519Pub:  keyBytes(seed, 32),
			SelfSig:     keyBytes(seed, 64),
			KeyVersion:  1,
			WrapSuite:   1,
			WrapBlob:    []byte{seed},
			Label:       "link",
			ExpiresAt:   time.Now().UTC().Add(time.Hour),
		}
	}

	// Permanent channel: refused.
	permInv := mk(9)
	permInv.ChannelID = perm.ID
	if err := s.MintEphemeralInvite(ctx, permInv, 2); !errors.Is(err, ErrNotEphemeral) {
		t.Errorf("mint on permanent channel: want ErrNotEphemeral, got %v", err)
	}

	// Two fit under a cap of 2; the third does not.
	if err := s.MintEphemeralInvite(ctx, mk(1), 2); err != nil {
		t.Fatalf("mint 1: %v", err)
	}
	if err := s.MintEphemeralInvite(ctx, mk(2), 2); err != nil {
		t.Fatalf("mint 2: %v", err)
	}
	third := mk(3)
	if err := s.MintEphemeralInvite(ctx, third, 2); !errors.Is(err, ErrGuestLimit) {
		t.Errorf("mint over cap: want ErrGuestLimit, got %v", err)
	}

	// Same lookup again: collision.
	if err := s.MintEphemeralInvite(ctx, mk(1), 0); !errors.Is(err, ErrInviteExists) {
		t.Errorf("duplicate lookup: want ErrInviteExists, got %v", err)
	}

	// Revoke one; the slot frees up and the third mint fits.
	if err := s.RevokeEphemeralInvite(ctx, room.ID, mk(2).Lookup); err != nil {
		t.Fatalf("revoke: %v", err)
	}
	if err := s.RevokeEphemeralInvite(ctx, room.ID, mk(2).Lookup); !errors.Is(err, ErrNotFound) {
		t.Errorf("double revoke: want ErrNotFound, got %v", err)
	}
	if err := s.MintEphemeralInvite(ctx, third, 2); err != nil {
		t.Errorf("mint after revoke should fit: %v", err)
	}

	invites, err := s.ListEphemeralInvites(ctx, room.ID)
	if err != nil {
		t.Fatal(err)
	}
	if len(invites) != 3 {
		t.Fatalf("list: %d invites, want 3", len(invites))
	}
	var revoked int
	for _, inv := range invites {
		if inv.RevokedAt != nil {
			revoked++
		}
		if inv.RedeemedAt != nil {
			t.Errorf("nothing was redeemed, but %x has redeemed_at", inv.Lookup)
		}
	}
	if revoked != 1 {
		t.Errorf("list: %d revoked, want 1", revoked)
	}
}
