package store

// 80-6: CreateChannel with ExpiresAt against a real Postgres (skips without
// CHALK_TEST_PGURL): the ephemeral shape is enforced (voice-only, no DM),
// governance is forced to dictator regardless of the server-wide default,
// and expires_at survives the round trip through every channel read path.

import (
	"context"
	"errors"
	"testing"
	"time"

	"github.com/google/uuid"
)

func TestCreateEphemeralChannel(t *testing.T) {
	pool := openProbeDB(t, "chalk_ephchan_probe")
	ctx := context.Background()
	s := &Store{Pool: pool}
	// A democratic server-wide default proves the ephemeral override bites.
	s.GovDefaults = GovernanceConfig{Mode: "democratic"}

	creator, other := uuid.New(), uuid.New()
	if _, err := pool.Exec(ctx,
		`INSERT INTO users (id, handle, username, display_name, email) VALUES
		   ($1,'carol','carol','Carol','carol@x.test'),
		   ($2,'dave','dave','Dave','dave@x.test')`, creator, other); err != nil {
		t.Fatal(err)
	}

	expires := time.Now().UTC().Add(2 * time.Hour).Truncate(time.Millisecond)

	// Wrong shapes refuse with the typed error.
	for name, in := range map[string]CreateChannelInput{
		"text": {Name: "t", CreatedBy: creator, ChannelType: "text", ExpiresAt: &expires},
		"dm": {Name: "d", CreatedBy: creator, IsDM: true,
			MemberIDs: []uuid.UUID{other}, ExpiresAt: &expires},
	} {
		if _, err := s.CreateChannel(ctx, in); !errors.Is(err, ErrBadChannelType) {
			t.Errorf("%s: want ErrBadChannelType, got %v", name, err)
		}
	}

	created, err := s.CreateChannel(ctx, CreateChannelInput{
		Name: "quick call", CreatedBy: creator, ChannelType: "voice", ExpiresAt: &expires,
	})
	if err != nil {
		t.Fatalf("create ephemeral: %v", err)
	}
	if created.GovernanceMode != "dictator" {
		t.Errorf("governance = %q, want forced dictator", created.GovernanceMode)
	}
	if created.ExpiresAt == nil || !created.ExpiresAt.Equal(expires) {
		t.Errorf("create returned ExpiresAt = %v, want %v", created.ExpiresAt, expires)
	}

	got, err := s.GetChannel(ctx, created.ID)
	if err != nil {
		t.Fatal(err)
	}
	if got.ExpiresAt == nil || !got.ExpiresAt.Equal(expires) {
		t.Errorf("GetChannel ExpiresAt = %v, want %v", got.ExpiresAt, expires)
	}

	listed, err := s.ListChannelsForUser(ctx, creator)
	if err != nil {
		t.Fatal(err)
	}
	if len(listed) != 1 || listed[0].ExpiresAt == nil || !listed[0].ExpiresAt.Equal(expires) {
		t.Errorf("ListChannelsForUser did not carry ExpiresAt: %+v", listed)
	}

	// A permanent channel stays nil everywhere.
	perm, err := s.CreateChannel(ctx, CreateChannelInput{
		Name: "forever", CreatedBy: creator, ChannelType: "voice",
	})
	if err != nil {
		t.Fatal(err)
	}
	if perm.ExpiresAt != nil {
		t.Errorf("permanent channel got ExpiresAt = %v", perm.ExpiresAt)
	}
	if perm.GovernanceMode != "democratic" {
		t.Errorf("permanent channel governance = %q, want the server default", perm.GovernanceMode)
	}
}
