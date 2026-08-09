package store

// 83-3: append-only message revisions. Asserts the properties the signed
// revision chain stands on: every edit displaces the previous body into
// message_revisions atomically and in order, the cap refuses (never drops)
// the 65th edit, the tombstone purges the revisions with the body, and
// ListRevisions returns them oldest-first with channel authz in the WHERE.
//
// Needs a live Postgres (openProbeDB): skips without CHALK_TEST_PGURL.

import (
	"context"
	"errors"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgxpool"
)

var (
	rvUser = uuid.MustParse("11111111-2222-3333-4444-000000000001")
	rvChan = uuid.MustParse("11111111-2222-3333-4444-000000000002")
	rvDev  = uuid.MustParse("11111111-2222-3333-4444-000000000003")
	rvMsg  = uuid.MustParse("11111111-2222-3333-4444-000000000004")
)

func seedRevisions(t *testing.T, pool *pgxpool.Pool) time.Time {
	t.Helper()
	ctx := context.Background()
	for _, st := range []struct {
		sql  string
		args []any
	}{
		{`INSERT INTO users (id, handle, username, display_name, email)
		    VALUES ($1,'rev_alice','rev_alice','Alice','rev_alice@x.test')`, []any{rvUser}},
		{`INSERT INTO channels (id, name) VALUES ($1,'rev-chan')`, []any{rvChan}},
		{`INSERT INTO channel_members (channel_id, user_id) VALUES ($1,$2)`, []any{rvChan, rvUser}},
		{`INSERT INTO devices (id, user_id) VALUES ($1,$2)`, []any{rvDev, rvUser}},
		{`INSERT INTO messages (id, channel_id, sender_device_id, seq, ts, body, key_version)
		    VALUES ($1,$2,$3,1,now(),'original-v0',1)`, []any{rvMsg, rvChan, rvDev}},
	} {
		if _, err := pool.Exec(ctx, st.sql, st.args...); err != nil {
			t.Fatalf("seed: %v (%s)", err, st.sql)
		}
	}
	var ts time.Time
	if err := pool.QueryRow(ctx, `SELECT ts FROM messages WHERE id = $1`, rvMsg).Scan(&ts); err != nil {
		t.Fatalf("read ts: %v", err)
	}
	return ts
}

// wireTS mirrors the handler: the wire carries unix-millis, and the store
// matches with the half-open 1ms window.
func wireTS(ts time.Time) time.Time { return time.UnixMilli(ts.UnixMilli()) }

func TestEditDisplacesRevisionsInOrder(t *testing.T) {
	pool := openProbeDB(t, "chalk_probe_revisions")
	s := &Store{Pool: pool}
	ts := wireTS(seedRevisions(t, pool))
	ctx := context.Background()

	if _, err := s.EditMessage(ctx, ts, rvMsg, rvChan, []byte("edit-v1"), 1); err != nil {
		t.Fatalf("edit 1: %v", err)
	}
	if _, err := s.EditMessage(ctx, ts, rvMsg, rvChan, []byte("edit-v2"), 1); err != nil {
		t.Fatalf("edit 2: %v", err)
	}

	revs, err := s.ListRevisions(ctx, ts, rvMsg, rvChan)
	if err != nil {
		t.Fatalf("list: %v", err)
	}
	if len(revs) != 2 {
		t.Fatalf("want 2 revisions, got %d", len(revs))
	}
	if revs[0].RevSeq != 1 || string(revs[0].Body) != "original-v0" {
		t.Fatalf("rev 1 should hold the original body, got seq=%d body=%q", revs[0].RevSeq, revs[0].Body)
	}
	if revs[1].RevSeq != 2 || string(revs[1].Body) != "edit-v1" {
		t.Fatalf("rev 2 should hold the first edit, got seq=%d body=%q", revs[1].RevSeq, revs[1].Body)
	}
	if revs[0].KeyVersion == nil || *revs[0].KeyVersion != 1 {
		t.Fatalf("rev 1 should carry the displaced key_version")
	}

	// the current body is the latest edit
	var body []byte
	if err := pool.QueryRow(ctx, `SELECT body FROM messages WHERE id = $1`, rvMsg).Scan(&body); err != nil {
		t.Fatalf("read body: %v", err)
	}
	if string(body) != "edit-v2" {
		t.Fatalf("current body should be edit-v2, got %q", body)
	}

	// authz shape: a wrong channel returns nothing, not an error
	other, err := s.ListRevisions(ctx, ts, rvMsg, uuid.New())
	if err != nil || len(other) != 0 {
		t.Fatalf("wrong-channel list should be empty, got %d rows err=%v", len(other), err)
	}
}

func TestEditRevisionCapRefuses(t *testing.T) {
	pool := openProbeDB(t, "chalk_probe_revcap")
	s := &Store{Pool: pool}
	ts := wireTS(seedRevisions(t, pool))
	ctx := context.Background()

	// Seed the revision table to the cap directly (64 real edits would work
	// too, just slowly); then the next edit must refuse without displacing.
	var fullTS time.Time
	if err := pool.QueryRow(ctx, `SELECT ts FROM messages WHERE id = $1`, rvMsg).Scan(&fullTS); err != nil {
		t.Fatalf("read ts: %v", err)
	}
	for i := 1; i <= MaxMessageRevisions; i++ {
		if _, err := pool.Exec(ctx,
			`INSERT INTO message_revisions (message_id, message_ts, rev_seq, channel_id, body, key_version)
			 VALUES ($1,$2,$3,$4,'x',1)`, rvMsg, fullTS, i, rvChan); err != nil {
			t.Fatalf("seed revision %d: %v", i, err)
		}
	}

	_, err := s.EditMessage(ctx, ts, rvMsg, rvChan, []byte("one too many"), 1)
	if !errors.Is(err, ErrTooManyRevisions) {
		t.Fatalf("want ErrTooManyRevisions, got %v", err)
	}
	// refused atomically: no 65th row, body unchanged
	var n int
	if err := pool.QueryRow(ctx, `SELECT count(*) FROM message_revisions WHERE message_id = $1`, rvMsg).Scan(&n); err != nil {
		t.Fatalf("count: %v", err)
	}
	if n != MaxMessageRevisions {
		t.Fatalf("cap breached: %d revisions", n)
	}
	var body []byte
	if err := pool.QueryRow(ctx, `SELECT body FROM messages WHERE id = $1`, rvMsg).Scan(&body); err != nil {
		t.Fatalf("read body: %v", err)
	}
	if string(body) != "original-v0" {
		t.Fatalf("refused edit must not change the body, got %q", body)
	}
}

func TestTombstonePurgesRevisions(t *testing.T) {
	pool := openProbeDB(t, "chalk_probe_revpurge")
	s := &Store{Pool: pool}
	ts := wireTS(seedRevisions(t, pool))
	ctx := context.Background()

	if _, err := s.EditMessage(ctx, ts, rvMsg, rvChan, []byte("edit-v1"), 1); err != nil {
		t.Fatalf("edit: %v", err)
	}
	if _, err := s.DeleteMessage(ctx, ts, rvMsg, rvChan, rvUser); err != nil {
		t.Fatalf("delete: %v", err)
	}
	var n int
	if err := pool.QueryRow(ctx, `SELECT count(*) FROM message_revisions WHERE message_id = $1`, rvMsg).Scan(&n); err != nil {
		t.Fatalf("count: %v", err)
	}
	if n != 0 {
		t.Fatalf("tombstone must purge revisions, %d left", n)
	}
	// and an edit after the tombstone still refuses
	if _, err := s.EditMessage(ctx, ts, rvMsg, rvChan, []byte("resurrect"), 1); !errors.Is(err, ErrAlreadyDeleted) {
		t.Fatalf("want ErrAlreadyDeleted after tombstone, got %v", err)
	}
}
