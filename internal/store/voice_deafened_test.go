package store

// 109-1: the deafened flag against a real Postgres (skips without
// CHALK_TEST_PGURL).
//
// The voice occupancy path had no test at all, so adding a fourth media flag
// to it was four SELECT lists, a RETURNING, a scan and an UPDATE that `go
// build` cannot check: a column named in the query but missing from the scan
// (or the other way round) compiles and fails at runtime. That is the
// SELECT/scan three-site rule, and this is what enforces it.
//
// The rejoin case is the one worth writing down: media flags reset on the
// join upsert, so someone who reconnects while deafened comes back into the
// room shown as hearing it, and their client's first voice_state is what
// corrects that. The test asserts the reset rather than the correction --
// the reset is the server's promise, the correction is the client's.

import (
	"context"
	"testing"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgxpool"
)

var (
	vdAlice = uuid.MustParse("77777777-1111-2222-3333-000000000001")
	vdBob   = uuid.MustParse("77777777-1111-2222-3333-000000000002")
	vdRoom  = uuid.MustParse("77777777-1111-2222-3333-0000000000cc")
	vdDevA  = uuid.MustParse("77777777-dddd-2222-3333-000000000001")
	vdDevB  = uuid.MustParse("77777777-dddd-2222-3333-000000000002")
)

func seedVoiceDeafened(t *testing.T, pool *pgxpool.Pool) {
	t.Helper()
	ctx := context.Background()
	for _, st := range []struct {
		sql  string
		args []any
	}{
		{`INSERT INTO users (id, handle, username, display_name, email) VALUES
		    ($1,'vd_a','vd_a','A','vd_a@x.test'),($2,'vd_b','vd_b','B','vd_b@x.test')`,
			[]any{vdAlice, vdBob}},
		{`INSERT INTO channels (id, name, channel_type, created_by)
		    VALUES ($1,'vd-room','voice',$2)`, []any{vdRoom, vdAlice}},
		{`INSERT INTO channel_members (channel_id, user_id, role)
		    VALUES ($1,$2,'owner'),($1,$3,'member')`, []any{vdRoom, vdAlice, vdBob}},
	} {
		if _, err := pool.Exec(ctx, st.sql, st.args...); err != nil {
			t.Fatalf("seed: %v (%s)", err, st.sql)
		}
	}
}

// find returns the roster entry for one device, or fails.
func find(t *testing.T, roster []VoiceParticipant, device uuid.UUID) VoiceParticipant {
	t.Helper()
	for _, p := range roster {
		if p.DeviceID == device {
			return p
		}
	}
	t.Fatalf("device %s not in roster of %d", device, len(roster))
	return VoiceParticipant{}
}

func TestVoiceDeafenedRoundTrips(t *testing.T) {
	pool := openProbeDB(t, "chalk_probe_voice_deafened")
	s := &Store{Pool: pool}
	ctx := context.Background()
	seedVoiceDeafened(t, pool)

	if _, err := s.JoinVoice(ctx, vdRoom, vdAlice, vdDevA, "conn-a", 8); err != nil {
		t.Fatalf("alice join: %v", err)
	}
	roster, err := s.JoinVoice(ctx, vdRoom, vdBob, vdDevB, "conn-b", 8)
	if err != nil {
		t.Fatalf("bob join: %v", err)
	}
	// A fresh room hears everything: the column's default has to be false, or
	// every joiner arrives wearing somebody else's state.
	for _, p := range roster {
		if p.Deafened {
			t.Fatalf("fresh joiner %s is deafened", p.UserID)
		}
	}

	// Deafening broadcasts muted with it -- that pairing is the client's, but
	// the row has to be able to hold both.
	if ok, err := s.UpdateVoiceState(ctx, vdRoom, vdBob, vdDevB, true, false, false, true); err != nil || !ok {
		t.Fatalf("bob deafen: ok=%v err=%v", ok, err)
	}
	// ...and it must not leak onto anyone else's row.
	if ok, err := s.UpdateVoiceState(ctx, vdRoom, vdAlice, vdDevA, true, true, false, false); err != nil || !ok {
		t.Fatalf("alice mute+camera: ok=%v err=%v", ok, err)
	}

	roster, err = s.VoiceRoster(ctx, vdRoom)
	if err != nil {
		t.Fatalf("roster: %v", err)
	}
	bob := find(t, roster, vdDevB)
	if !bob.Deafened || !bob.Muted || bob.VideoOn || bob.ScreenOn {
		t.Fatalf("bob: %+v", bob)
	}
	alice := find(t, roster, vdDevA)
	if alice.Deafened || !alice.Muted || !alice.VideoOn {
		t.Fatalf("alice: %+v", alice)
	}

	// A rejoin is the reconnect path: the row is refreshed and every media
	// flag resets, deafened along with the other three.
	roster, err = s.JoinVoice(ctx, vdRoom, vdBob, vdDevB, "conn-b2", 8)
	if err != nil {
		t.Fatalf("bob rejoin: %v", err)
	}
	if bob = find(t, roster, vdDevB); bob.Deafened || bob.Muted {
		t.Fatalf("rejoin kept media flags: %+v", bob)
	}

	// The delete paths RETURN the same column list they scan; an eviction that
	// forgot the new column would fail here and nowhere else.
	gone, err := s.EvictVoiceByUser(ctx, vdRoom, vdBob)
	if err != nil {
		t.Fatalf("evict: %v", err)
	}
	if len(gone) != 1 || gone[0].DeviceID != vdDevB {
		t.Fatalf("evict returned %+v", gone)
	}

	left, err := s.DeleteVoiceParticipantsByConn(ctx, "conn-a")
	if err != nil {
		t.Fatalf("delete by conn: %v", err)
	}
	if len(left) != 1 || !left[0].Muted || left[0].Deafened {
		t.Fatalf("delete by conn returned %+v", left)
	}
}
