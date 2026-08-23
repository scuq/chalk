package store

// Phase-83 stress: the concurrency properties under real contention, meant
// to run with -race. Needs a live Postgres; skips without CHALK_TEST_PGURL.

import (
	"bytes"
	"context"
	"errors"
	"sync"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgxpool"
)

var (
	stUserA = uuid.MustParse("55555555-6666-7777-8888-000000000001")
	stUserB = uuid.MustParse("55555555-6666-7777-8888-000000000002")
	stChan  = uuid.MustParse("55555555-6666-7777-8888-0000000000cc")
	stDev   = uuid.MustParse("55555555-6666-7777-8888-0000000000dd")
	stMsg   = uuid.MustParse("55555555-6666-7777-8888-0000000000e1")
)

func seedStress(t *testing.T, pool *pgxpool.Pool) {
	t.Helper()
	ctx := context.Background()
	for _, st := range []struct {
		sql  string
		args []any
	}{
		{`INSERT INTO users (id, handle, username, display_name, email) VALUES
		    ($1,'st_a','st_a','A','st_a@x.test'),($2,'st_b','st_b','B','st_b@x.test')`, []any{stUserA, stUserB}},
		{`INSERT INTO channels (id, name, created_by) VALUES ($1,'st-chan',$2)`, []any{stChan, stUserA}},
		{`INSERT INTO channel_members (channel_id, user_id, role) VALUES ($1,$2,'owner'),($1,$3,'member')`,
			[]any{stChan, stUserA, stUserB}},
		{`INSERT INTO devices (id, user_id) VALUES ($1,$2)`, []any{stDev, stUserA}},
		{`INSERT INTO messages (id, channel_id, sender_device_id, seq, ts, body, key_version)
		    VALUES ($1,$2,$3,1,now(),'v0',1)`, []any{stMsg, stChan, stDev}},
	} {
		if _, err := pool.Exec(ctx, st.sql, st.args...); err != nil {
			t.Fatalf("seed: %v", err)
		}
	}
}

// TestRotationStorm: five rounds, eight concurrent responders each. Every
// round exactly one wins, the version advances by exactly one, and every
// wrap stored at the new version carries ONE responder's tag -- a mixed key
// generation must be impossible in any interleaving (R16-2).
func TestRotationStorm(t *testing.T) {
	pool := openProbeDB(t, "chalk_probe_rotstorm")
	s := &Store{Pool: pool}
	ctx := context.Background()
	seedStress(t, pool)

	const responders = 8
	const rounds = 5
	for round := 0; round < rounds; round++ {
		expected := round + 1
		if _, err := pool.Exec(ctx,
			`UPDATE channels SET rotation_pending = TRUE, rotation_due_from = current_key_version WHERE id = $1`,
			stChan); err != nil {
			t.Fatal(err)
		}
		var wg sync.WaitGroup
		results := make([]error, responders)
		for i := 0; i < responders; i++ {
			wg.Add(1)
			go func(i int) {
				defer wg.Done()
				tag := byte(16*round + i + 1)
				caller := stUserA
				if i%2 == 1 {
					caller = stUserB // both members respond; nobody is special
				}
				wraps := []RotationWrap{
					{RecipientID: stUserA, WrapSuite: 2, Blob: bytes.Repeat([]byte{tag}, 188)},
					{RecipientID: stUserB, WrapSuite: 2, Blob: bytes.Repeat([]byte{tag}, 188)},
				}
				_, results[i] = s.RotateChannelKeyAtomic(ctx, stChan, caller, expected, wraps, 4096)
			}(i)
		}
		wg.Wait()

		wins := 0
		for _, err := range results {
			if err == nil {
				wins++
				continue
			}
			var stale *StaleRotationError
			if !errors.As(err, &stale) {
				t.Fatalf("round %d: unexpected error %v", round, err)
			}
			if stale.Current != expected+1 {
				t.Fatalf("round %d: loser told current=%d, want %d", round, stale.Current, expected+1)
			}
		}
		if wins != 1 {
			t.Fatalf("round %d: %d winners", round, wins)
		}
		cur, due, err := s.ChannelKeyState(ctx, stChan)
		if err != nil || cur != expected+1 || due != nil {
			t.Fatalf("round %d: cur=%d due=%v err=%v", round, cur, due, err)
		}
		// every wrap at the new version carries one tag
		rows, err := pool.Query(ctx,
			`SELECT wrap_blob FROM channel_keys WHERE channel_id = $1 AND key_version = $2`, stChan, expected+1)
		if err != nil {
			t.Fatal(err)
		}
		var tags []byte
		for rows.Next() {
			var blob []byte
			if err := rows.Scan(&blob); err != nil {
				t.Fatal(err)
			}
			tags = append(tags, blob[0])
		}
		rows.Close()
		if len(tags) != 2 || tags[0] != tags[1] {
			t.Fatalf("round %d: mixed generation at v%d: %v", round, expected+1, tags)
		}
	}
}

// TestConcurrentEditStorm: ten goroutines edit the same message at once,
// repeatedly. The FOR UPDATE serializes displacement, so afterwards the
// revisions are DENSE (rev_seq 1..N with no gaps or duplicates), revision 1
// is the original body, and every displaced body is one of the writes.
func TestConcurrentEditStorm(t *testing.T) {
	pool := openProbeDB(t, "chalk_probe_editstorm")
	s := &Store{Pool: pool}
	ctx := context.Background()
	seedStress(t, pool)

	var ts time.Time
	if err := pool.QueryRow(ctx, `SELECT ts FROM messages WHERE id = $1`, stMsg).Scan(&ts); err != nil {
		t.Fatal(err)
	}
	wireTS := time.UnixMilli(ts.UnixMilli())

	const writers = 10
	const perWriter = 3
	var wg sync.WaitGroup
	for w := 0; w < writers; w++ {
		wg.Add(1)
		go func(w int) {
			defer wg.Done()
			for k := 0; k < perWriter; k++ {
				body := []byte{byte('A' + w), byte('0' + k)}
				if _, err := s.EditMessage(ctx, wireTS, stMsg, stChan, body, 1); err != nil {
					t.Errorf("edit w%d k%d: %v", w, k, err)
					return
				}
			}
		}(w)
	}
	wg.Wait()

	revs, err := s.ListRevisions(ctx, wireTS, stMsg, stChan)
	if err != nil {
		t.Fatal(err)
	}
	want := writers * perWriter
	if len(revs) != want {
		t.Fatalf("want %d revisions, got %d", want, len(revs))
	}
	for i, r := range revs {
		if r.RevSeq != i+1 {
			t.Fatalf("revisions not dense: index %d has rev_seq %d", i, r.RevSeq)
		}
	}
	if string(revs[0].Body) != "v0" {
		t.Fatalf("revision 1 must be the original, got %q", revs[0].Body)
	}
	// every displaced body is unique (each write displaced exactly once)
	seen := map[string]bool{}
	for _, r := range revs {
		if seen[string(r.Body)] {
			t.Fatalf("body %q displaced twice", r.Body)
		}
		seen[string(r.Body)] = true
	}
}
