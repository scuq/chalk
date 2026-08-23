package store

// 83-5: the atomic first-responder rotation. Asserts: a shrink marks the
// channel due from its current version; rotation requires exactly the
// roster, signed wraps, and the expected version; it clears the mark; a
// 2-person channel rotates with a single wrap; and two concurrent
// responders cannot produce a mixed key generation -- exactly one wins and
// every wrap at the new version is the winner's.
//
// Needs a live Postgres (openProbeDB): skips without CHALK_TEST_PGURL.

import (
	"bytes"
	"context"
	"errors"
	"sync"
	"testing"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgxpool"
)

var (
	rtAlice = uuid.MustParse("33333333-4444-5555-6666-000000000001")
	rtBob   = uuid.MustParse("33333333-4444-5555-6666-000000000002")
	rtCarol = uuid.MustParse("33333333-4444-5555-6666-000000000003")
	rtChan  = uuid.MustParse("33333333-4444-5555-6666-0000000000cc")
)

func seedRotation(t *testing.T, pool *pgxpool.Pool) {
	t.Helper()
	ctx := context.Background()
	for _, st := range []struct {
		sql  string
		args []any
	}{
		{`INSERT INTO users (id, handle, username, display_name, email) VALUES
		    ($1,'rt_a','rt_a','A','rt_a@x.test'),($2,'rt_b','rt_b','B','rt_b@x.test'),($3,'rt_c','rt_c','C','rt_c@x.test')`,
			[]any{rtAlice, rtBob, rtCarol}},
		{`INSERT INTO channels (id, name, created_by) VALUES ($1,'rt-chan',$2)`, []any{rtChan, rtAlice}},
		{`INSERT INTO channel_members (channel_id, user_id, role) VALUES ($1,$2,'owner'),($1,$3,'member'),($1,$4,'member')`,
			[]any{rtChan, rtAlice, rtBob, rtCarol}},
	} {
		if _, err := pool.Exec(ctx, st.sql, st.args...); err != nil {
			t.Fatalf("seed: %v (%s)", err, st.sql)
		}
	}
}

func wrap(rid uuid.UUID, tag byte) RotationWrap {
	return RotationWrap{RecipientID: rid, WrapSuite: 2, Blob: bytes.Repeat([]byte{tag}, 188)}
}

func TestRotateChannelKeyAtomic(t *testing.T) {
	pool := openProbeDB(t, "chalk_probe_rotation")
	s := &Store{Pool: pool}
	ctx := context.Background()
	seedRotation(t, pool)

	// a shrink marks due FROM the current version
	if err := s.RemoveMember(ctx, rtChan, rtCarol); err != nil {
		t.Fatalf("remove: %v", err)
	}
	cur, due, err := s.ChannelKeyState(ctx, rtChan)
	if err != nil || cur != 1 || due == nil || *due != 1 {
		t.Fatalf("after shrink: cur=%d due=%v err=%v", cur, due, err)
	}

	// roster must be exact: carol is gone, bob is missing here
	_, err = s.RotateChannelKeyAtomic(ctx, rtChan, rtBob, 1, []RotationWrap{wrap(rtAlice, 1)}, 4096)
	if !errors.Is(err, ErrRosterMismatch) {
		t.Fatalf("missing member: want ErrRosterMismatch, got %v", err)
	}
	_, err = s.RotateChannelKeyAtomic(ctx, rtChan, rtBob, 1, []RotationWrap{wrap(rtAlice, 1), wrap(rtBob, 1), wrap(rtCarol, 1)}, 4096)
	if !errors.Is(err, ErrRosterMismatch) {
		t.Fatalf("removed member wrapped: want ErrRosterMismatch, got %v", err)
	}
	// wraps must be signed
	_, err = s.RotateChannelKeyAtomic(ctx, rtChan, rtBob, 1, []RotationWrap{wrap(rtAlice, 1), {RecipientID: rtBob, WrapSuite: 1, Blob: []byte{1}}}, 4096)
	if !errors.Is(err, ErrWrapUnsigned) {
		t.Fatalf("unsigned: want ErrWrapUnsigned, got %v", err)
	}
	// a non-member cannot rotate
	if _, err = s.RotateChannelKeyAtomic(ctx, rtChan, rtCarol, 1, []RotationWrap{wrap(rtAlice, 1), wrap(rtBob, 1)}, 4096); !errors.Is(err, ErrNotAMember) {
		t.Fatalf("non-member: want ErrNotAMember, got %v", err)
	}

	// bob -- not the creator -- is the first responder
	v, err := s.RotateChannelKeyAtomic(ctx, rtChan, rtBob, 1, []RotationWrap{wrap(rtAlice, 7), wrap(rtBob, 7)}, 4096)
	if err != nil || v != 2 {
		t.Fatalf("rotate: v=%d err=%v", v, err)
	}
	cur, due, _ = s.ChannelKeyState(ctx, rtChan)
	if cur != 2 || due != nil {
		t.Fatalf("after rotate: cur=%d due=%v", cur, due)
	}
	// the stale responder learns the current version
	_, err = s.RotateChannelKeyAtomic(ctx, rtChan, rtAlice, 1, []RotationWrap{wrap(rtAlice, 8), wrap(rtBob, 8)}, 4096)
	var stale *StaleRotationError
	if !errors.As(err, &stale) || stale.Current != 2 {
		t.Fatalf("stale: want StaleRotationError{2}, got %v", err)
	}

	// the race: two responders from version 2, exactly one wins, no mixing
	var wg sync.WaitGroup
	results := make([]error, 2)
	for i, tag := range []byte{0xA0, 0xB0} {
		wg.Add(1)
		go func(i int, tag byte) {
			defer wg.Done()
			_, results[i] = s.RotateChannelKeyAtomic(ctx, rtChan, rtAlice, 2, []RotationWrap{wrap(rtAlice, tag), wrap(rtBob, tag)}, 4096)
		}(i, tag)
	}
	wg.Wait()
	wins := 0
	for _, e := range results {
		if e == nil {
			wins++
		} else if !errors.As(e, &stale) {
			t.Fatalf("race: unexpected error %v", e)
		}
	}
	if wins != 1 {
		t.Fatalf("race: want exactly one winner, got %d", wins)
	}
	rows, err := pool.Query(ctx, `SELECT wrap_blob FROM channel_keys WHERE channel_id = $1 AND key_version = 3`, rtChan)
	if err != nil {
		t.Fatalf("query wraps: %v", err)
	}
	defer rows.Close()
	var first byte
	n := 0
	for rows.Next() {
		var blob []byte
		if err := rows.Scan(&blob); err != nil {
			t.Fatal(err)
		}
		if n == 0 {
			first = blob[0]
		} else if blob[0] != first {
			t.Fatalf("mixed key generation at v3: %x vs %x", first, blob[0])
		}
		n++
	}
	if n != 2 {
		t.Fatalf("want 2 wraps at v3, got %d", n)
	}

	// 2-person channel: remove bob, alice rotates alone with her single wrap
	if err := s.RemoveMember(ctx, rtChan, rtBob); err != nil {
		t.Fatalf("remove bob: %v", err)
	}
	if v, err := s.RotateChannelKeyAtomic(ctx, rtChan, rtAlice, 3, []RotationWrap{wrap(rtAlice, 9)}, 4096); err != nil || v != 4 {
		t.Fatalf("solo rotate: v=%d err=%v", v, err)
	}
}
