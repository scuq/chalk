package store

// 83-8 verification: the pre-83 -> 83 UPGRADE path, staged the way a real
// deployment experiences it. A database is built with migrations up to 0050
// (the last pre-phase-83 schema), populated with pre-83-shaped data -- a
// channel mid-"rotation pending" from an old removal, a generation-1
// identity, a sealed message, an in-place-edited message, a sealed-JSON
// reaction row -- and THEN migrations 0051..0053 run over it, exactly what
// `chalkctl update` does on upgrade day. Asserted: nothing is lost, the
// 0053 backfill converts rotation_pending into rotation_due_from, and the
// NEW code paths (append-only edit, atomic rotation, identity chain fetch)
// operate correctly on the OLD rows.
//
// Needs a live Postgres: skips without CHALK_TEST_PGURL.

import (
	"context"
	"net/url"
	"os"
	"strings"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"

	chalk "github.com/scuq/chalk"
	"github.com/scuq/chalk/internal/migrate"
)

var (
	mcUser = uuid.MustParse("44444444-5555-6666-7777-000000000001")
	mcPeer = uuid.MustParse("44444444-5555-6666-7777-000000000002")
	mcChan = uuid.MustParse("44444444-5555-6666-7777-0000000000cc")
	mcDev  = uuid.MustParse("44444444-5555-6666-7777-0000000000dd")
	mcMsg1 = uuid.MustParse("44444444-5555-6666-7777-0000000000e1")
	mcMsg2 = uuid.MustParse("44444444-5555-6666-7777-0000000000e2")
)

// openStagedDB creates a scratch database and applies only the migrations
// strictly below `upTo` (a version prefix like "0051"). Returns the pool and
// the remaining migrations for the second stage.
func openStagedDB(t *testing.T, name, upTo string) (*pgxpool.Pool, []migrate.Migration) {
	t.Helper()
	src := os.Getenv("CHALK_TEST_PGURL")
	if src == "" {
		t.Skip("CHALK_TEST_PGURL not set; test needs a live Postgres")
	}
	ctx := context.Background()
	u, err := url.Parse(src)
	if err != nil {
		t.Fatalf("parse CHALK_TEST_PGURL: %v", err)
	}
	admin := *u
	admin.Path = "/postgres"
	adminConn, err := pgx.Connect(ctx, admin.String())
	if err != nil {
		t.Fatalf("connect admin: %v", err)
	}
	if _, err := adminConn.Exec(ctx, "DROP DATABASE IF EXISTS "+name); err != nil {
		t.Fatalf("drop: %v", err)
	}
	if _, err := adminConn.Exec(ctx, "CREATE DATABASE "+name); err != nil {
		t.Fatalf("create: %v", err)
	}
	t.Cleanup(func() {
		_, _ = adminConn.Exec(context.Background(), "DROP DATABASE IF EXISTS "+name+" WITH (FORCE)")
		_ = adminConn.Close(context.Background())
	})
	probe := *u
	probe.Path = "/" + name
	pool, err := pgxpool.New(ctx, probe.String())
	if err != nil {
		t.Fatalf("connect probe: %v", err)
	}
	t.Cleanup(pool.Close)

	all, err := migrate.Load(chalk.Migrations, chalk.MigrationsDir)
	if err != nil {
		t.Fatalf("load migrations: %v", err)
	}
	cut := len(all)
	for i, m := range all {
		if strings.Compare(m.Version, upTo) >= 0 {
			cut = i
			break
		}
	}
	if _, err := migrate.Run(ctx, pool, all[:cut], func(string, ...any) {}); err != nil {
		t.Fatalf("apply pre-83 migrations: %v", err)
	}
	return pool, all[cut:]
}

func TestUpgradeFromPre83Schema(t *testing.T) {
	pool, rest := openStagedDB(t, "chalk_probe_upgrade83", "0051")
	ctx := context.Background()
	s := &Store{Pool: pool}
	if err := s.EnsureMessagePartitions(ctx, time.Now().UTC()); err != nil {
		t.Fatalf("partitions: %v", err)
	}

	// ---- pre-83 world -----------------------------------------------------
	for _, st := range []struct {
		sql  string
		args []any
	}{
		{`INSERT INTO users (id, handle, username, display_name, email) VALUES
		    ($1,'mc_a','mc_a','A','mc_a@x.test'),($2,'mc_b','mc_b','B','mc_b@x.test')`, []any{mcUser, mcPeer}},
		// a channel whose member removal predates the upgrade: the owner never
		// rotated, so rotation_pending is still TRUE at version 3
		{`INSERT INTO channels (id, name, created_by, current_key_version, rotation_pending)
		    VALUES ($1,'mc-chan',$2,3,TRUE)`, []any{mcChan, mcUser}},
		{`INSERT INTO channel_members (channel_id, user_id, role) VALUES ($1,$2,'owner'),($1,$3,'member')`,
			[]any{mcChan, mcUser, mcPeer}},
		{`INSERT INTO devices (id, user_id) VALUES ($1,$2)`, []any{mcDev, mcUser}},
		// a generation-1 identity, published long before certs existed
		{`INSERT INTO identity_keys (user_id, generation, x25519_pub, ed25519_pub, self_sig)
		    VALUES ($1,1,repeat('x',32)::bytea,repeat('e',32)::bytea,repeat('s',64)::bytea)`, []any{mcUser}},
		// a plain sealed message and one that was edited IN PLACE (0044 world)
		{`INSERT INTO messages (id, channel_id, sender_device_id, seq, ts, body, key_version)
		    VALUES ($1,$2,$3,1,now(),'legacy-sealed-body',2)`, []any{mcMsg1, mcChan, mcDev}},
		{`INSERT INTO messages (id, channel_id, sender_device_id, seq, ts, body, key_version, edited_at)
		    VALUES ($1,$2,$3,2,now(),'edited-in-place-body',3,now())`, []any{mcMsg2, mcChan, mcDev}},
		// a pre-83 sealed-JSON reaction row
		{`INSERT INTO message_reactions (message_id, message_ts, channel_id, user_id, body, key_version)
		    SELECT id, ts, channel_id, $2, 'sealed-json-reactions', 2 FROM messages WHERE id = $1`,
			[]any{mcMsg1, mcPeer}},
	} {
		if _, err := pool.Exec(ctx, st.sql, st.args...); err != nil {
			t.Fatalf("seed pre-83: %v (%s)", err, st.sql)
		}
	}

	// ---- upgrade day: 0051..0053 run over the populated database ----------
	if _, err := migrate.Run(ctx, pool, rest, func(string, ...any) {}); err != nil {
		t.Fatalf("apply 83 migrations: %v", err)
	}

	// 0053 backfill: the stale removal becomes rotation_due_from = current
	cur, due, err := s.ChannelKeyState(ctx, mcChan)
	if err != nil || cur != 3 || due == nil || *due != 3 {
		t.Fatalf("backfill: cur=%d due=%v err=%v", cur, due, err)
	}
	// nothing was lost
	var body []byte
	if err := pool.QueryRow(ctx, `SELECT body FROM messages WHERE id=$1`, mcMsg1).Scan(&body); err != nil || string(body) != "legacy-sealed-body" {
		t.Fatalf("legacy message: %q %v", body, err)
	}
	var rbody []byte
	if err := pool.QueryRow(ctx, `SELECT body FROM message_reactions WHERE message_id=$1`, mcMsg1).Scan(&rbody); err != nil || string(rbody) != "sealed-json-reactions" {
		t.Fatalf("legacy reaction: %q %v", rbody, err)
	}
	// the old identity row is a chain root: generation 1, no cert
	keys, err := s.ListIdentityKeys(ctx, mcUser)
	if err != nil || len(keys) != 1 || keys[0].Generation != 1 || keys[0].GenCert != nil {
		t.Fatalf("identity chain after upgrade: %+v err=%v", keys, err)
	}

	// ---- and the NEW code paths work on the OLD rows ----------------------
	// the send gate would now refuse; the first responder rotates from the
	// backfilled version and the channel unfreezes
	if _, err := s.RotateChannelKeyAtomic(ctx, mcChan, mcPeer, 3, []RotationWrap{
		{RecipientID: mcUser, WrapSuite: 2, Blob: []byte("wrapA")},
		{RecipientID: mcPeer, WrapSuite: 2, Blob: []byte("wrapB")},
	}, 4096); err != nil {
		t.Fatalf("post-upgrade rotation: %v", err)
	}
	cur, due, _ = s.ChannelKeyState(ctx, mcChan)
	if cur != 4 || due != nil {
		t.Fatalf("after rotation: cur=%d due=%v", cur, due)
	}
	// editing the PRE-83 message displaces its original body into revisions
	var ts time.Time
	if err := pool.QueryRow(ctx, `SELECT ts FROM messages WHERE id=$1`, mcMsg1).Scan(&ts); err != nil {
		t.Fatal(err)
	}
	if _, err := s.EditMessage(ctx, time.UnixMilli(ts.UnixMilli()), mcMsg1, mcChan, []byte("new-edit"), 4); err != nil {
		t.Fatalf("edit legacy message: %v", err)
	}
	revs, err := s.ListRevisions(ctx, time.UnixMilli(ts.UnixMilli()), mcMsg1, mcChan)
	if err != nil || len(revs) != 1 || string(revs[0].Body) != "legacy-sealed-body" {
		t.Fatalf("legacy body should be revision 1: %+v err=%v", revs, err)
	}
	if revs[0].KeyVersion == nil || *revs[0].KeyVersion != 2 {
		t.Fatalf("displaced key_version: %+v", revs[0].KeyVersion)
	}
}

// Found by the phase-83 stress run: a password-method seed wrap (nil
// CredentialID) must store as the EMPTY credential id, not NULL.
func TestPutIdentitySeedWrapPasswordMethod(t *testing.T) {
	pool := openProbeDB(t, "chalk_probe_seedwrap")
	s := &Store{Pool: pool}
	ctx := context.Background()
	if _, err := pool.Exec(ctx,
		`INSERT INTO users (id, handle, username, display_name, email)
		    VALUES ($1,'sw_a','sw_a','A','sw_a@x.test')`, mcUser); err != nil {
		t.Fatal(err)
	}
	if err := s.PutIdentitySeedWrap(ctx, IdentitySeedWrap{
		UserID: mcUser, Method: "password", Generation: 1, WrapSuite: 1, WrapBlob: []byte("wrap"),
	}); err != nil {
		t.Fatalf("password seed wrap must store: %v", err)
	}
	// idempotent upsert on the same (user, method, '', generation) key
	if err := s.PutIdentitySeedWrap(ctx, IdentitySeedWrap{
		UserID: mcUser, Method: "password", Generation: 1, WrapSuite: 1, WrapBlob: []byte("wrap2"),
	}); err != nil {
		t.Fatalf("re-put: %v", err)
	}
	var n int
	if err := pool.QueryRow(ctx,
		`SELECT count(*) FROM identity_seed_wrap WHERE user_id = $1 AND credential_id = ''::bytea`, mcUser).Scan(&n); err != nil {
		t.Fatal(err)
	}
	if n != 1 {
		t.Fatalf("want exactly one empty-credential row, got %d", n)
	}
}
