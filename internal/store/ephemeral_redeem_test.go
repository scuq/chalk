package store

// 80-8: guest materialization against a real Postgres (skips without
// CHALK_TEST_PGURL). First redemption builds the full principal; a second
// redemption of the same link is the SAME identity with a fresh session and
// the newly typed name; revoked and expired links answer their typed errors;
// the session never outlives the room.

import (
	"context"
	"errors"
	"testing"
	"time"

	"github.com/google/uuid"
)

func TestRedeemEphemeralInvite(t *testing.T) {
	pool := openProbeDB(t, "chalk_redeem_probe")
	ctx := context.Background()
	s := &Store{Pool: pool}

	creator := uuid.New()
	if _, err := pool.Exec(ctx,
		`INSERT INTO users (id, handle, username, display_name, email)
		 VALUES ($1,'faye','faye','Faye','faye@x.test')`, creator); err != nil {
		t.Fatal(err)
	}
	chExpires := time.Now().UTC().Add(2 * time.Hour)
	room, err := s.CreateChannel(ctx, CreateChannelInput{
		Name: "room", CreatedBy: creator, ChannelType: "voice", ExpiresAt: &chExpires,
	})
	if err != nil {
		t.Fatal(err)
	}

	guestID := uuid.New()
	lookup := keyBytes(0xAA, 16)
	inv := EphemeralInvite{
		Lookup: lookup, ChannelID: room.ID, CreatedBy: creator, GuestUserID: guestID,
		X25519Pub: keyBytes(1, 32), Ed25519Pub: keyBytes(2, 32), SelfSig: keyBytes(3, 64),
		KeyVersion: 1, WrapSuite: 1, WrapBlob: []byte{7, 7},
		ExpiresAt: time.Now().UTC().Add(time.Hour),
	}
	if err := s.MintEphemeralInvite(ctx, inv, 0); err != nil {
		t.Fatal(err)
	}

	got, err := s.RedeemEphemeralInvite(ctx, RedeemInput{
		Lookup: lookup, DisplayName: "Bob", SessionTTL: 24 * time.Hour,
	})
	if err != nil {
		t.Fatalf("redeem: %v", err)
	}
	if got.UserID != guestID || got.ChannelID != room.ID || got.ChannelName != "room" {
		t.Errorf("redeemed = %+v", got)
	}
	if string(got.WrapBlob) != string(inv.WrapBlob) || got.KeyVersion != 1 || got.WrapSuite != 1 {
		t.Errorf("wrap not returned: %+v", got)
	}
	// 24 h TTL > 2 h room life: the session is clamped to the room.
	if !got.SessionExpiresAt.Equal(got.ChannelExpiresAt) {
		t.Errorf("session %v must clamp to channel %v", got.SessionExpiresAt, got.ChannelExpiresAt)
	}

	// The full principal exists.
	for sql, want := range map[string]int{
		`SELECT count(*) FROM users WHERE id = $1 AND guest_channel_id IS NOT NULL`: 1,
		`SELECT count(*) FROM ephemeral_guests WHERE user_id = $1`:                  1,
		`SELECT count(*) FROM channel_members cm JOIN users u ON u.id = cm.user_id
		  WHERE cm.user_id = $1 AND cm.role = 'member'`: 1,
		`SELECT count(*) FROM ephemeral_identity_keys WHERE user_id = $1`: 1,
		`SELECT count(*) FROM channel_keys WHERE recipient_id = $1`:       1,
		`SELECT count(*) FROM ephemeral_sessions WHERE user_id = $1`:      1,
		`SELECT count(*) FROM ephemeral_invites
		  WHERE guest_user_id = $1 AND redeemed_at IS NOT NULL`: 1,
	} {
		var n int
		if err := pool.QueryRow(ctx, sql, guestID).Scan(&n); err != nil {
			t.Errorf("%s: %v", sql, err)
			continue
		}
		if n != want {
			t.Errorf("%s = %d, want %d", sql, n, want)
		}
	}

	// Reuse: same identity, fresh session, freshest name.
	again, err := s.RedeemEphemeralInvite(ctx, RedeemInput{
		Lookup: lookup, DisplayName: "Bobby", SessionTTL: 24 * time.Hour,
	})
	if err != nil {
		t.Fatalf("second redeem: %v", err)
	}
	if again.UserID != guestID {
		t.Errorf("reuse minted a different identity: %s", again.UserID)
	}
	if string(again.SessionToken) == string(got.SessionToken) {
		t.Error("reuse must mint a fresh session token")
	}
	var name string
	var users, sessions int
	if err := pool.QueryRow(ctx,
		`SELECT display_name FROM users WHERE id = $1`, guestID).Scan(&name); err != nil {
		t.Fatal(err)
	}
	if name != "Bobby" {
		t.Errorf("display_name = %q, want the freshest typed name", name)
	}
	if err := pool.QueryRow(ctx,
		`SELECT (SELECT count(*) FROM users WHERE id = $1),
		        (SELECT count(*) FROM ephemeral_sessions WHERE user_id = $1)`,
		guestID).Scan(&users, &sessions); err != nil {
		t.Fatal(err)
	}
	if users != 1 || sessions != 2 {
		t.Errorf("reuse: %d users / %d sessions, want 1 / 2", users, sessions)
	}

	// Revoked: typed refusal.
	if err := s.RevokeEphemeralInvite(ctx, room.ID, lookup); err != nil {
		t.Fatal(err)
	}
	if _, err := s.RedeemEphemeralInvite(ctx, RedeemInput{
		Lookup: lookup, DisplayName: "Mallory", SessionTTL: time.Hour,
	}); !errors.Is(err, ErrInviteRevoked) {
		t.Errorf("revoked: want ErrInviteRevoked, got %v", err)
	}

	// Expired link on a live room: typed refusal.
	expired := EphemeralInvite{
		Lookup: keyBytes(0xBB, 16), ChannelID: room.ID, CreatedBy: creator,
		GuestUserID: uuid.New(),
		X25519Pub:   keyBytes(4, 32), Ed25519Pub: keyBytes(5, 32), SelfSig: keyBytes(6, 64),
		KeyVersion: 1, WrapSuite: 1, WrapBlob: []byte{8},
		ExpiresAt: time.Now().UTC().Add(time.Hour),
	}
	if err := s.MintEphemeralInvite(ctx, expired, 0); err != nil {
		t.Fatal(err)
	}
	if _, err := pool.Exec(ctx,
		`UPDATE ephemeral_invites SET expires_at = now() - interval '1 minute' WHERE lookup = $1`,
		expired.Lookup); err != nil {
		t.Fatal(err)
	}
	if _, err := s.RedeemEphemeralInvite(ctx, RedeemInput{
		Lookup: expired.Lookup, DisplayName: "Late", SessionTTL: time.Hour,
	}); !errors.Is(err, ErrInviteExpired) {
		t.Errorf("expired: want ErrInviteExpired, got %v", err)
	}

	// Unknown lookup: ErrNotFound.
	if _, err := s.RedeemEphemeralInvite(ctx, RedeemInput{
		Lookup: keyBytes(0xCC, 16), DisplayName: "Ghost", SessionTTL: time.Hour,
	}); !errors.Is(err, ErrNotFound) {
		t.Errorf("unknown: want ErrNotFound, got %v", err)
	}
}
