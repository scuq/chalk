package store

// 80-3: THE security test for the guest fence (docs/phases/PHASE-80-EPHEMERAL.md).
//
// It builds a scratch database, applies every migration, and then checks the
// chalk_guest role against reality:
//
//   1. Grant matrix: every table is enumerated from the CATALOG, not a
//      hand-written list, and every table not explicitly allowed below must
//      answer `permission denied`. A future migration that adds a shared
//      table lands in the forbidden set automatically -- if the guest path
//      needs it, this test forces that to be a deliberate policy decision.
//   2. Fail closed: a transaction WITHOUT the SET LOCALs reads zero rows
//      from every RLS-protected table.
//   3. Scope: with the SET LOCALs, the guest sees exactly its one channel,
//      its co-members (not outsiders), and only its own key wrap; it can
//      send as its own device and NOT as anyone else's.
//
// Needs a live Postgres; skips without CHALK_TEST_PGURL (the integration
// convention), e.g. CHALK_TEST_PGURL=postgres://chalk:chalk@localhost:5432/chalk
// against the dev container. The chalk_guest role is entered via SET ROLE on
// a scratch-database pool -- privilege checks and RLS use the current role,
// so this is equivalent to a chalk_guest login without mutating the shared
// cluster's roles.

import (
	"bytes"
	"context"
	"errors"
	"fmt"
	"strings"
	"testing"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"
	"github.com/jackc/pgx/v5/pgxpool"
)

const grantsProbeDB = "chalk_grants_probe"

// Fixed IDs so failures read well.
var (
	gAlice   = uuid.MustParse("11111111-1111-1111-1111-111111111111")
	gBob     = uuid.MustParse("22222222-2222-2222-2222-222222222222") // outsider
	gGuest   = uuid.MustParse("33333333-3333-3333-3333-333333333333")
	gRoom    = uuid.MustParse("aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa")
	gOther   = uuid.MustParse("bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb")
	gDevA    = uuid.MustParse("dddddddd-dddd-dddd-dddd-dddddddd0001")
	gDevG    = uuid.MustParse("dddddddd-dddd-dddd-dddd-dddddddd0003")
	gInvite  = []byte("0123456789abcdef") // 16 bytes
	gSession = bytes.Repeat([]byte{7}, 32)
)

// guestReadable enumerates every table chalk_guest may SELECT at all. This is
// the ONE hand-written list, asserted in both directions: tables in it must
// be readable (empty or not), tables outside it must be permission-denied.
var guestReadable = map[string]bool{
	"ephemeral_invites":       true,
	"ephemeral_guests":        true,
	"ephemeral_identity_keys": true,
	"ephemeral_sessions":      true,
	"users":                   true, // columns id, handle, display_name only
	"identity_keys":           true,
	"channels":                true,
	"channel_members":         true,
	"channel_keys":            true,
	"channel_seq":             true,
	"channel_reads":           true,
	"messages":                true,
	"channel_activity":        true,
	"voice_participants":      true,
	"voice_signal_spool":      true,
	"devices":                 true,
}

// rlsScoped are the shared tables whose guest policies hang off the SET
// LOCALs; each must return ZERO rows in a transaction that did not set them.
var rlsScoped = []string{
	"users", "identity_keys", "channels", "channel_members", "channel_keys",
	"channel_seq", "channel_reads", "messages", "channel_activity",
	"voice_participants", "voice_signal_spool", "devices",
}

// guestSelect is the widest SELECT the guest column grants permit per table.
func guestSelect(table string) string {
	if table == "users" {
		return "SELECT id, handle, display_name FROM users"
	}
	return "SELECT * FROM " + table
}

func setupGrantsDB(t *testing.T) (owner *pgxpool.Pool, guest *Guest) {
	t.Helper()
	ctx := context.Background()
	owner = openProbeDB(t, grantsProbeDB)
	seed(t, owner)

	// The guest pool: same database, every connection dropped to chalk_guest.
	// Privilege checks and RLS use the CURRENT role, so SET ROLE is
	// equivalent to a chalk_guest login without mutating cluster roles.
	gcfg := owner.Config().Copy()
	gcfg.AfterConnect = func(ctx context.Context, c *pgx.Conn) error {
		_, err := c.Exec(ctx, "SET ROLE chalk_guest")
		return err
	}
	gpool, err := pgxpool.NewWithConfig(ctx, gcfg)
	if err != nil {
		t.Fatalf("create guest pool: %v", err)
	}
	t.Cleanup(gpool.Close)
	return owner, &Guest{pool: gpool}
}

func seed(t *testing.T, pool *pgxpool.Pool) {
	t.Helper()
	ctx := context.Background()
	stmts := []struct {
		sql  string
		args []any
	}{
		{`INSERT INTO users (id, handle, username, display_name, email) VALUES
		    ($1,'alice','alice','Alice','alice@x.test'),
		    ($2,'bob','bob','Bob','bob@x.test'),
		    ($3,'guest_a3f9','guest_a3f9','Gustl','guest_a3f9@guest.invalid')`,
			[]any{gAlice, gBob, gGuest}},
		{`INSERT INTO channels (id, name, channel_type, expires_at) VALUES
		    ($1,'room','voice', now() + interval '1 hour'),
		    ($2,'other','voice', NULL)`, []any{gRoom, gOther}},
		{`UPDATE users SET guest_channel_id = $2 WHERE id = $1`, []any{gGuest, gRoom}},
		{`INSERT INTO channel_members (channel_id, user_id) VALUES
		    ($1,$2),($1,$3),($4,$5)`, []any{gRoom, gAlice, gGuest, gOther, gBob}},
		{`INSERT INTO channel_seq (channel_id) VALUES ($1),($2)`, []any{gRoom, gOther}},
		{`INSERT INTO devices (id, user_id) VALUES ($1,$2),($3,$4)`,
			[]any{gDevA, gAlice, gDevG, gGuest}},
		{`INSERT INTO identity_keys (user_id, x25519_pub, ed25519_pub, self_sig) VALUES
		    ($1,$3,$4,$5),($2,$3,$4,$5)`,
			[]any{gAlice, gBob, bytes.Repeat([]byte{1}, 32), bytes.Repeat([]byte{2}, 32), bytes.Repeat([]byte{3}, 64)}},
		{`INSERT INTO channel_keys (channel_id, key_version, recipient_id, wrap_suite, wrap_blob) VALUES
		    ($1,1,$2,1,'\x01'),($1,1,$3,1,'\x02')`, []any{gRoom, gAlice, gGuest}},
		{`INSERT INTO messages (id, channel_id, sender_device_id, seq, ts, body) VALUES
		    ($1,$2,$3,1,now(),'\x01')`,
			[]any{uuid.New(), gRoom, gDevA}},
		{`INSERT INTO ephemeral_invites
		    (lookup, channel_id, created_by, guest_user_id, x25519_pub, ed25519_pub, self_sig,
		     key_version, wrap_suite, wrap_blob, expires_at) VALUES
		    ($1,$2,$3,$4,$5,$6,$7,1,1,'\x03', now() + interval '1 hour')`,
			[]any{gInvite, gRoom, gAlice, gGuest,
				bytes.Repeat([]byte{4}, 32), bytes.Repeat([]byte{5}, 32), bytes.Repeat([]byte{6}, 64)}},
		{`INSERT INTO ephemeral_guests (user_id, channel_id, invite_lookup) VALUES ($1,$2,$3)`,
			[]any{gGuest, gRoom, gInvite}},
		{`INSERT INTO ephemeral_identity_keys (user_id, x25519_pub, ed25519_pub, self_sig) VALUES
		    ($1,$2,$3,$4)`,
			[]any{gGuest, bytes.Repeat([]byte{4}, 32), bytes.Repeat([]byte{5}, 32), bytes.Repeat([]byte{6}, 64)}},
		{`INSERT INTO ephemeral_sessions (token, user_id, expires_at) VALUES
		    ($1,$2, now() + interval '1 hour')`, []any{gSession, gGuest}},
	}
	for _, st := range stmts {
		if _, err := pool.Exec(ctx, st.sql, st.args...); err != nil {
			t.Fatalf("seed %q: %v", st.sql[:40], err)
		}
	}
}

func isPermissionDenied(err error) bool {
	var pgErr *pgconn.PgError
	return errors.As(err, &pgErr) && pgErr.Code == "42501"
}

func isRLSViolation(err error) bool {
	var pgErr *pgconn.PgError
	return errors.As(err, &pgErr) && pgErr.Code == "42501" &&
		strings.Contains(pgErr.Message, "row-level security")
}

func TestGuestGrantMatrix(t *testing.T) {
	owner, g := setupGrantsDB(t)
	ctx := context.Background()

	// Enumerate reality: every ordinary + partitioned table in public,
	// partitions included (they must be unreachable directly; the guest only
	// ever queries through the parent).
	rows, err := owner.Query(ctx,
		`SELECT c.relname, c.relispartition
		   FROM pg_class c
		   JOIN pg_namespace n ON n.oid = c.relnamespace
		  WHERE n.nspname = 'public' AND c.relkind IN ('r','p')
		  ORDER BY c.relname`)
	if err != nil {
		t.Fatal(err)
	}
	type tbl struct {
		name        string
		isPartition bool
	}
	var tables []tbl
	for rows.Next() {
		var tb tbl
		if err := rows.Scan(&tb.name, &tb.isPartition); err != nil {
			t.Fatal(err)
		}
		tables = append(tables, tb)
	}
	if err := rows.Err(); err != nil {
		t.Fatal(err)
	}
	if len(tables) < 30 {
		t.Fatalf("catalog enumeration looks broken: only %d tables", len(tables))
	}

	for _, tb := range tables {
		allowed := guestReadable[tb.name] && !tb.isPartition
		_, err := g.pool.Exec(ctx, guestSelect(tb.name)+" LIMIT 0")
		if allowed && err != nil {
			t.Errorf("%s: guest SELECT should be granted, got: %v", tb.name, err)
		}
		if !allowed && !isPermissionDenied(err) {
			t.Errorf("%s: guest SELECT must be `permission denied`, got: %v", tb.name, err)
		}
	}

	// Column fence on users: anything beyond (id, handle, display_name).
	for _, col := range []string{"email", "username", "role", "created_at", "blocked_at"} {
		_, err := g.pool.Exec(ctx, fmt.Sprintf("SELECT %s FROM users LIMIT 0", col))
		if !isPermissionDenied(err) {
			t.Errorf("users.%s: guest SELECT must be `permission denied`, got: %v", col, err)
		}
	}

	// Writes the fence must refuse regardless of any SET LOCALs: forging
	// principals and touching membership.
	for _, sql := range []string{
		"INSERT INTO ephemeral_sessions (token, user_id, expires_at) VALUES ('\\x09', '" + gGuest.String() + "', now())",
		"INSERT INTO ephemeral_invites (lookup, channel_id, created_by, guest_user_id, x25519_pub, ed25519_pub, self_sig, key_version, wrap_suite, wrap_blob, expires_at) SELECT lookup, channel_id, created_by, gen_random_uuid(), x25519_pub, ed25519_pub, self_sig, 1, 1, wrap_blob, now() FROM ephemeral_invites",
		"INSERT INTO channel_members (channel_id, user_id) VALUES ('" + gRoom.String() + "','" + gBob.String() + "')",
		"DELETE FROM messages",
		"UPDATE users SET display_name = 'x'",
	} {
		if _, err := g.pool.Exec(ctx, sql); !isPermissionDenied(err) {
			t.Errorf("guest write must be `permission denied`: %.60s -> %v", sql, err)
		}
	}
}

func TestGuestFailsClosedWithoutSetLocals(t *testing.T) {
	_, g := setupGrantsDB(t)
	ctx := context.Background()

	for _, table := range rlsScoped {
		var n int
		if err := g.pool.QueryRow(ctx, "SELECT count(*) FROM "+table).Scan(&n); err != nil {
			t.Errorf("%s: count as guest failed: %v", table, err)
			continue
		}
		if n != 0 {
			t.Errorf("%s: %d rows visible WITHOUT SET LOCALs; must fail closed to zero", table, n)
		}
	}
}

func TestGuestScopedView(t *testing.T) {
	_, g := setupGrantsDB(t)
	ctx := context.Background()

	count := func(tx pgx.Tx, sql string) int {
		t.Helper()
		var n int
		if err := tx.QueryRow(ctx, sql).Scan(&n); err != nil {
			t.Fatalf("%s: %v", sql, err)
		}
		return n
	}

	err := g.withTx(ctx, gGuest, gRoom, func(tx pgx.Tx) error {
		for sql, want := range map[string]int{
			"SELECT count(*) FROM channels":                                 1, // the room, not gOther
			"SELECT count(*) FROM users":                                    2, // alice + guest, not bob
			"SELECT count(*) FROM identity_keys":                            1, // alice's; bob invisible
			"SELECT count(*) FROM channel_members":                          2,
			"SELECT count(*) FROM channel_keys":                             1, // own wrap only
			"SELECT count(*) FROM messages":                                 1,
			"SELECT count(*) FROM devices":                                  2,
			"SELECT count(*) FROM channel_seq":                              1,
			"SELECT count(*) FROM users WHERE id = '" + gBob.String() + "'": 0,
		} {
			if got := count(tx, sql); got != want {
				t.Errorf("%s = %d, want %d", sql, got, want)
			}
		}
		// Send as own device: allowed.
		if _, err := tx.Exec(ctx,
			`INSERT INTO messages (id, channel_id, sender_device_id, seq, ts, body)
			 VALUES ($1,$2,$3,2,now(),'\x02')`, uuid.New(), gRoom, gDevG); err != nil {
			t.Errorf("guest send as own device refused: %v", err)
		}
		// Cross-channel writes silently touch nothing.
		ct, err := tx.Exec(ctx, `UPDATE channel_seq SET next_seq = 99 WHERE channel_id = $1`, gOther)
		if err != nil {
			t.Errorf("cross-channel update errored (want 0 rows): %v", err)
		} else if ct.RowsAffected() != 0 {
			t.Errorf("cross-channel channel_seq update affected %d rows", ct.RowsAffected())
		}
		return nil
	})
	if err != nil {
		t.Fatalf("withTx: %v", err)
	}

	// Sending as ALICE's device is an RLS violation, in its own tx (the
	// failed insert poisons the transaction).
	err = g.withTx(ctx, gGuest, gRoom, func(tx pgx.Tx) error {
		_, err := tx.Exec(ctx,
			`INSERT INTO messages (id, channel_id, sender_device_id, seq, ts, body)
			 VALUES ($1,$2,$3,3,now(),'\x03')`, uuid.New(), gRoom, gDevA)
		return err
	})
	if !isRLSViolation(err) {
		t.Errorf("guest send as another user's device: want RLS violation, got: %v", err)
	}

	// withTx refuses a nil identity outright.
	if err := g.withTx(ctx, uuid.Nil, gRoom, func(pgx.Tx) error { return nil }); err == nil {
		t.Error("withTx with nil guest user must refuse")
	}
}
