package store

// 80-4: PurgeChannel against a real Postgres (skips without CHALK_TEST_PGURL).
//
// Seeds an expired ephemeral voice channel populated with EVERY kind of row a
// room can accumulate -- messages, attachments + staged chunks, governance,
// thread reads, read cursors, live voice occupancy, signal spool, invites,
// a materialized guest with device/identity/session -- plus a bystander
// channel, then asserts the purge leaves ZERO survivors of the first and does
// not touch the second. The zero-survivor list is the point: cascade does not
// cover messages or attachments, so every row here is either explicitly
// deleted or deliberately cascaded, and this test is what notices when a new
// table joins the room without joining the purge.

import (
	"context"
	"errors"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgxpool"
)

var (
	pAlice   = uuid.MustParse("11111111-1111-1111-1111-111111111111")
	pGuest   = uuid.MustParse("33333333-3333-3333-3333-333333333333")
	pRoom    = uuid.MustParse("aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa")
	pOther   = uuid.MustParse("bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb")
	pDevA    = uuid.MustParse("dddddddd-dddd-dddd-dddd-dddddddd0001")
	pDevG    = uuid.MustParse("dddddddd-dddd-dddd-dddd-dddddddd0003")
	pMsg1    = uuid.MustParse("eeeeeeee-eeee-eeee-eeee-eeeeeeeeee01")
	pAttach  = uuid.MustParse("ffffffff-ffff-ffff-ffff-ffffffffff01")
	pLookup  = []byte("fedcba9876543210") // 16 bytes
	keyBytes = func(b byte, n int) []byte {
		out := make([]byte, n)
		for i := range out {
			out[i] = b
		}
		return out
	}
)

func seedPurge(t *testing.T, pool *pgxpool.Pool) {
	t.Helper()
	ctx := context.Background()
	for _, st := range []struct {
		sql  string
		args []any
	}{
		{`INSERT INTO users (id, handle, username, display_name, email) VALUES
		    ($1,'alice','alice','Alice','alice@x.test'),
		    ($2,'guest_p','guest_p','Gustl','guest_p@guest.invalid')`,
			[]any{pAlice, pGuest}},
		// The room expired an hour ago; the bystander channel never expires.
		{`INSERT INTO channels (id, name, channel_type, expires_at, created_at) VALUES
		    ($1,'room','voice', now() - interval '1 hour', now() - interval '2 hour'),
		    ($2,'keep','voice', NULL, now() - interval '2 hour')`,
			[]any{pRoom, pOther}},
		{`UPDATE users SET guest_channel_id = $2 WHERE id = $1`, []any{pGuest, pRoom}},
		{`INSERT INTO channel_members (channel_id, user_id) VALUES
		    ($1,$2),($1,$3),($4,$2)`, []any{pRoom, pAlice, pGuest, pOther}},
		{`INSERT INTO channel_seq (channel_id) VALUES ($1),($2)`, []any{pRoom, pOther}},
		{`INSERT INTO devices (id, user_id) VALUES ($1,$2),($3,$4)`,
			[]any{pDevA, pAlice, pDevG, pGuest}},
		{`INSERT INTO channel_keys (channel_id, key_version, recipient_id, wrap_suite, wrap_blob) VALUES
		    ($1,1,$2,1,'\x01'),($1,1,$3,1,'\x02')`, []any{pRoom, pAlice, pGuest}},
		{`INSERT INTO channel_reads (user_id, channel_id, last_read_seq) VALUES
		    ($1,$2,1),($3,$2,1)`, []any{pAlice, pRoom, pGuest}},
		{`INSERT INTO messages (id, channel_id, sender_device_id, seq, ts, body) VALUES
		    ($1,$2,$3,1,now(),'\x01'),($4,$2,$5,2,now(),'\x02')`,
			[]any{pMsg1, pRoom, pDevA, uuid.New(), pDevG}},
		{`INSERT INTO channel_activity (channel_id, last_msg_id, last_msg_ts, last_msg_seq, last_sender_id)
		    SELECT channel_id, id, ts, seq, $2 FROM messages WHERE id = $1`,
			[]any{pMsg1, pAlice}},
		{`INSERT INTO message_reactions (message_id, message_ts, channel_id, user_id, body)
		    SELECT id, ts, channel_id, $2, '\x0d' FROM messages WHERE id = $1`,
			[]any{pMsg1, pGuest}},
		{`INSERT INTO thread_activity (thread_id, channel_id, head_ts, head_seq,
		     last_reply_id, last_reply_ts, last_reply_seq, reply_count)
		    SELECT id, channel_id, ts, seq, id, ts, seq, 1 FROM messages WHERE id = $1`,
			[]any{pMsg1}},
		{`INSERT INTO thread_reads (user_id, thread_id, channel_id, last_read_seq) VALUES
		    ($1,$2,$3,1)`, []any{pAlice, pMsg1, pRoom}},
		{`INSERT INTO attachments (id, channel_id, uploader_device_id, key_version, byte_len, enc_meta) VALUES
		    ($1,$2,$3,1,4,'\x0a')`, []any{pAttach, pRoom, pDevA}},
		{`INSERT INTO attachment_chunks (attachment_id, seq, data) VALUES ($1,0,'\x0b')`,
			[]any{pAttach}},
		{`INSERT INTO proposals (channel_id, type, created_by, expires_at,
		     window_days, min_eligible, quorum_percent, pass_percent, supermajority_percent) VALUES
		    ($1,'remove_member',$2, now() + interval '1 day', 30, 3, 50, 50, 67)`,
			[]any{pRoom, pAlice}},
		{`INSERT INTO proposal_votes (proposal_id, voter_id, vote)
		    SELECT id, $2, 'yes' FROM proposals WHERE channel_id = $1`,
			[]any{pRoom, pAlice}},
		{`INSERT INTO proposal_eligibility (proposal_id, voter_id)
		    SELECT id, $2 FROM proposals WHERE channel_id = $1`,
			[]any{pRoom, pAlice}},
		{`INSERT INTO voice_participants (channel_id, user_id, device_id, conn_id) VALUES
		    ($1,$2,$3,'i:1')`, []any{pRoom, pGuest, pDevG}},
		{`INSERT INTO voice_signal_spool (channel_id, to_user, to_device, from_user, from_device, kind, payload) VALUES
		    ($1,$2,$3,$4,$5,'offer','\x0c')`, []any{pRoom, pAlice, pDevA, pGuest, pDevG}},
		{`INSERT INTO ephemeral_invites
		    (lookup, channel_id, created_by, guest_user_id, x25519_pub, ed25519_pub, self_sig,
		     key_version, wrap_suite, wrap_blob, expires_at) VALUES
		    ($1,$2,$3,$4,$5,$6,$7,1,1,'\x03', now() + interval '1 hour')`,
			[]any{pLookup, pRoom, pAlice, pGuest,
				keyBytes(4, 32), keyBytes(5, 32), keyBytes(6, 64)}},
		{`INSERT INTO ephemeral_guests (user_id, channel_id, invite_lookup) VALUES ($1,$2,$3)`,
			[]any{pGuest, pRoom, pLookup}},
		{`INSERT INTO ephemeral_identity_keys (user_id, x25519_pub, ed25519_pub, self_sig) VALUES
		    ($1,$2,$3,$4)`, []any{pGuest, keyBytes(4, 32), keyBytes(5, 32), keyBytes(6, 64)}},
		{`INSERT INTO ephemeral_sessions (token, user_id, expires_at) VALUES
		    ($1,$2, now() + interval '1 hour')`, []any{keyBytes(7, 32), pGuest}},
	} {
		if _, err := pool.Exec(ctx, st.sql, st.args...); err != nil {
			t.Fatalf("seed %.60q: %v", st.sql, err)
		}
	}
}

func TestPurgeChannel(t *testing.T) {
	pool := openProbeDB(t, "chalk_purge_probe")
	seedPurge(t, pool)
	ctx := context.Background()
	s := &Store{Pool: pool}

	// The expired room is listed; the bystander is not.
	expired, err := s.ListExpiredChannels(ctx, time.Now().UTC())
	if err != nil {
		t.Fatal(err)
	}
	if len(expired) != 1 || expired[0] != pRoom {
		t.Fatalf("ListExpiredChannels = %v, want [%s]", expired, pRoom)
	}

	stats, err := s.PurgeChannel(ctx, pRoom)
	if err != nil {
		t.Fatalf("PurgeChannel: %v", err)
	}
	if stats.Messages != 2 || stats.Attachments != 1 || stats.Guests != 1 {
		t.Errorf("stats = %+v, want 2 messages / 1 attachment / 1 guest", stats)
	}

	// Zero survivors, table by table.
	zero := map[string]string{
		"channels":                `id = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa'`,
		"messages":                `channel_id = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa'`,
		"attachments":             `channel_id = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa'`,
		"attachment_chunks":       `attachment_id = 'ffffffff-ffff-ffff-ffff-ffffffffff01'`,
		"channel_members":         `channel_id = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa'`,
		"channel_keys":            `channel_id = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa'`,
		"channel_seq":             `channel_id = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa'`,
		"channel_reads":           `channel_id = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa'`,
		"channel_activity":        `channel_id = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa'`,
		"message_reactions":       `channel_id = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa'`,
		"thread_activity":         `channel_id = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa'`,
		"thread_reads":            `channel_id = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa'`,
		"proposals":               `channel_id = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa'`,
		"proposal_votes":          `true`, // only the room had proposals
		"proposal_eligibility":    `true`,
		"voice_participants":      `channel_id = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa'`,
		"voice_signal_spool":      `channel_id = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa'`,
		"ephemeral_invites":       `true`,
		"ephemeral_guests":        `true`,
		"ephemeral_identity_keys": `true`,
		"ephemeral_sessions":      `true`,
		"users":                   `id = '33333333-3333-3333-3333-333333333333'`, // the guest
		"devices":                 `user_id = '33333333-3333-3333-3333-333333333333'`,
	}
	for table, where := range zero {
		var n int
		if err := pool.QueryRow(ctx,
			"SELECT count(*) FROM "+table+" WHERE "+where).Scan(&n); err != nil {
			t.Errorf("%s: %v", table, err)
			continue
		}
		if n != 0 {
			t.Errorf("%s: %d row(s) survived the purge (WHERE %s)", table, n, where)
		}
	}

	// The bystander channel, its member, and the real user are untouched.
	for sql, want := range map[string]int{
		`SELECT count(*) FROM channels WHERE id = 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb'`:                1,
		`SELECT count(*) FROM channel_members WHERE channel_id = 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb'`: 1,
		`SELECT count(*) FROM users WHERE id = '11111111-1111-1111-1111-111111111111'`:                   1,
		`SELECT count(*) FROM devices WHERE user_id = '11111111-1111-1111-1111-111111111111'`:            1,
	} {
		var n int
		if err := pool.QueryRow(ctx, sql).Scan(&n); err != nil {
			t.Errorf("%s: %v", sql, err)
			continue
		}
		if n != want {
			t.Errorf("%s = %d, want %d", sql, n, want)
		}
	}

	// Idempotent from the janitor's point of view: a second purge (or a
	// racing instance) reports ErrNotFound rather than failing.
	if _, err := s.PurgeChannel(ctx, pRoom); !errors.Is(err, ErrNotFound) {
		t.Errorf("second purge: want ErrNotFound, got %v", err)
	}
	// And the expiry listing is now empty.
	expired, err = s.ListExpiredChannels(ctx, time.Now().UTC())
	if err != nil {
		t.Fatal(err)
	}
	if len(expired) != 0 {
		t.Errorf("ListExpiredChannels after purge = %v, want empty", expired)
	}
}
