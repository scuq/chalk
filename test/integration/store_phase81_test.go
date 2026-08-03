package integration

import (
	"bytes"
	"errors"
	"testing"
	"time"

	"github.com/google/uuid"

	"github.com/scuq/chalk/internal/store"
)

// Phase 81-1 store-layer tests: session revocation on credential change and
// the absolute session lifetime cap.
//
// Backdating created_at via direct SQL stands in for the passage of 90 days;
// the queries under test only ever compare against now().

// newAuthUser creates a throwaway user with a minimal user_auth row (the
// credential-change paths require one to exist) and registers cleanup.
func newAuthUser(t *testing.T, st *store.Store) uuid.UUID {
	t.Helper()
	c := ctx(t)
	uid := uuid.New()
	if _, err := st.CreateUser(c, uid, "p81_"+uid.String()[:8]); err != nil {
		t.Fatalf("CreateUser: %v", err)
	}
	t.Cleanup(func() {
		_, _ = st.Pool.Exec(ctx(t), `DELETE FROM users WHERE id = $1`, uid)
	})
	if _, err := st.Pool.Exec(c,
		`INSERT INTO user_auth
		     (user_id, auth_proof_hash, auth_salt, kdf_mem_kib, kdf_iters, kdf_par)
		   VALUES ($1, $2, $3, 262144, 3, 1)`,
		uid, bytes.Repeat([]byte{1}, 32), bytes.Repeat([]byte{2}, 16),
	); err != nil {
		t.Fatalf("insert user_auth: %v", err)
	}
	return uid
}

func backdateSession(t *testing.T, st *store.Store, token []byte, age time.Duration) {
	t.Helper()
	if _, err := st.Pool.Exec(ctx(t),
		`UPDATE sessions SET created_at = now() - $1::interval WHERE token = $2`,
		age.String(), token,
	); err != nil {
		t.Fatalf("backdate session: %v", err)
	}
}

func TestChangePasswordAuthRevokesOtherSessions(t *testing.T) {
	st := openStore(t)
	c := ctx(t)
	uid := newAuthUser(t, st)

	keep, err := st.CreateSession(c, uid, "keeper", nil)
	if err != nil {
		t.Fatalf("CreateSession keep: %v", err)
	}
	other, err := st.CreateSession(c, uid, "stolen", nil)
	if err != nil {
		t.Fatalf("CreateSession other: %v", err)
	}

	if err := st.ChangePasswordAuth(c, uid,
		bytes.Repeat([]byte{5}, 32), bytes.Repeat([]byte{6}, 16),
		1, 262144, 3, 1, 1, 1, []byte("wrap"), keep.Token,
	); err != nil {
		t.Fatalf("ChangePasswordAuth: %v", err)
	}

	if _, err := st.GetSession(c, keep.Token); err != nil {
		t.Errorf("caller's own session should survive a password change: %v", err)
	}
	if _, err := st.GetSession(c, other.Token); !errors.Is(err, store.ErrNotFound) {
		t.Errorf("other session after password change: got %v, want ErrNotFound", err)
	}
}

func TestChangePasswordAuthNilKeepTokenRevokesAll(t *testing.T) {
	st := openStore(t)
	c := ctx(t)
	uid := newAuthUser(t, st)

	sess, err := st.CreateSession(c, uid, "", nil)
	if err != nil {
		t.Fatalf("CreateSession: %v", err)
	}

	if err := st.ChangePasswordAuth(c, uid,
		bytes.Repeat([]byte{5}, 32), bytes.Repeat([]byte{6}, 16),
		1, 262144, 3, 1, 1, 1, []byte("wrap"), nil,
	); err != nil {
		t.Fatalf("ChangePasswordAuth: %v", err)
	}
	if _, err := st.GetSession(c, sess.Token); !errors.Is(err, store.ErrNotFound) {
		t.Errorf("session after nil-keepToken change: got %v, want ErrNotFound", err)
	}
}

func TestResetAuthViaRecoveryRevokesAllSessions(t *testing.T) {
	st := openStore(t)
	c := ctx(t)
	uid := newAuthUser(t, st)

	s1, err := st.CreateSession(c, uid, "", nil)
	if err != nil {
		t.Fatalf("CreateSession 1: %v", err)
	}
	s2, err := st.CreateSession(c, uid, "", nil)
	if err != nil {
		t.Fatalf("CreateSession 2: %v", err)
	}

	if err := st.ResetAuthViaRecovery(c, uid,
		bytes.Repeat([]byte{7}, 32), bytes.Repeat([]byte{8}, 16),
		1, 262144, 3, 1, false,
	); err != nil {
		t.Fatalf("ResetAuthViaRecovery: %v", err)
	}

	for i, tok := range [][]byte{s1.Token, s2.Token} {
		if _, err := st.GetSession(c, tok); !errors.Is(err, store.ErrNotFound) {
			t.Errorf("session %d after recovery reset: got %v, want ErrNotFound", i+1, err)
		}
	}
}

func TestSessionAbsoluteLifetime(t *testing.T) {
	st := openStore(t)
	c := ctx(t)
	uid := newAuthUser(t, st)

	sess, err := st.CreateSession(c, uid, "", nil)
	if err != nil {
		t.Fatalf("CreateSession: %v", err)
	}
	t.Cleanup(func() { _ = st.DeleteSession(c, sess.Token) })

	// Older than the cap but with expires_at still in the future — the shape
	// of a pre-cap row that kept sliding. It must read as gone everywhere.
	backdateSession(t, st, sess.Token, store.SessionMaxLifetime+24*time.Hour)

	if _, err := st.GetSession(c, sess.Token); !errors.Is(err, store.ErrNotFound) {
		t.Errorf("GetSession on over-age session: got %v, want ErrNotFound", err)
	}
	if err := st.TouchSession(c, sess.Token); !errors.Is(err, store.ErrNotFound) {
		t.Errorf("TouchSession on over-age session: got %v, want ErrNotFound", err)
	}
	if _, err := st.DeleteExpiredSessions(c); err != nil {
		t.Fatalf("DeleteExpiredSessions: %v", err)
	}
	var n int
	if err := st.Pool.QueryRow(c,
		`SELECT count(*) FROM sessions WHERE token = $1`, sess.Token,
	).Scan(&n); err != nil {
		t.Fatalf("count: %v", err)
	}
	if n != 0 {
		t.Error("janitor left the over-age session row behind")
	}
}

func TestSessionTouchCapsAtMaxLifetime(t *testing.T) {
	st := openStore(t)
	c := ctx(t)
	uid := newAuthUser(t, st)

	sess, err := st.CreateSession(c, uid, "", nil)
	if err != nil {
		t.Fatalf("CreateSession: %v", err)
	}
	t.Cleanup(func() { _ = st.DeleteSession(c, sess.Token) })

	// One day short of the cap: still touchable, but the slide must be
	// clamped to created_at + max, not now() + 30d.
	backdateSession(t, st, sess.Token, store.SessionMaxLifetime-24*time.Hour)

	if err := st.TouchSession(c, sess.Token); err != nil {
		t.Fatalf("TouchSession: %v", err)
	}
	got, err := st.GetSession(c, sess.Token)
	if err != nil {
		t.Fatalf("GetSession: %v", err)
	}
	ceiling := got.CreatedAt.Add(store.SessionMaxLifetime)
	if got.ExpiresAt.After(ceiling.Add(time.Minute)) {
		t.Errorf("touch slid expires_at to %v, past the ceiling %v",
			got.ExpiresAt, ceiling)
	}
	if !got.ExpiresAt.After(time.Now()) {
		t.Errorf("clamped expires_at %v is not in the future", got.ExpiresAt)
	}
}
