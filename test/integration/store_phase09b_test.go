package integration

import (
	"bytes"
	"errors"
	"net"
	"strings"
	"testing"
	"time"

	"github.com/google/uuid"

	"github.com/scuq/chalk/internal/store"
)

// Phase 09b store-layer integration tests. These exercise the new
// columns/tables added by migrations 0011-0015 and 0017: the auth
// columns on users, sessions, passkeys, recovery_codes, and
// admin_bootstrap_tokens.
//
// The fixture users (alice/bob/carol) all share the .invalid email
// suffix the migration backfilled. New tests below create throwaway
// users where needed via CreateUser, which now seeds the auth
// columns automatically.

// ---- users: 09b auth columns ------------------------------------------

func TestUsersFixtureHas09bColumns(t *testing.T) {
	st := openStore(t)
	c := ctx(t)

	got, err := st.GetUserByID(c, aliceID)
	if err != nil {
		t.Fatalf("GetUserByID: %v", err)
	}
	if got.Username != "alice" {
		t.Errorf("Username = %q, want alice", got.Username)
	}
	if got.DisplayName != "alice" {
		t.Errorf("DisplayName = %q, want alice", got.DisplayName)
	}
	if got.Email != "alice@localhost.invalid" {
		t.Errorf("Email = %q, want alice@localhost.invalid", got.Email)
	}
	if got.Role != "user" {
		t.Errorf("Role = %q, want user", got.Role)
	}
	if got.EmailVerifiedAt.IsZero() {
		t.Error("EmailVerifiedAt should be non-zero for fixture user")
	}
	if got.HasPendingEmail() {
		t.Error("fresh fixture user shouldn't have pending email change")
	}
}

func TestUsersGetByUsername(t *testing.T) {
	st := openStore(t)
	c := ctx(t)

	got, err := st.GetUserByUsername(c, "alice")
	if err != nil {
		t.Fatalf("GetUserByUsername: %v", err)
	}
	if got.ID != aliceID {
		t.Errorf("got %s, want %s", got.ID, aliceID)
	}

	// Case insensitive via citext.
	got2, err := st.GetUserByUsername(c, "ALICE")
	if err != nil {
		t.Fatalf("GetUserByUsername(ALICE): %v", err)
	}
	if got2.ID != aliceID {
		t.Errorf("ALICE -> %s, want %s", got2.ID, aliceID)
	}

	_, err = st.GetUserByUsername(c, "ghost")
	if !errors.Is(err, store.ErrNotFound) {
		t.Errorf("missing user: got %v, want ErrNotFound", err)
	}
}

func TestUsersGetByEmail(t *testing.T) {
	st := openStore(t)
	c := ctx(t)

	got, err := st.GetUserByEmail(c, "alice@localhost.invalid")
	if err != nil {
		t.Fatalf("GetUserByEmail: %v", err)
	}
	if got.ID != aliceID {
		t.Errorf("got %s, want %s", got.ID, aliceID)
	}

	_, err = st.GetUserByEmail(c, "nobody@nowhere.invalid")
	if !errors.Is(err, store.ErrNotFound) {
		t.Errorf("missing email: got %v, want ErrNotFound", err)
	}
}

func TestUsersUpdateDisplayName(t *testing.T) {
	st := openStore(t)
	c := ctx(t)

	// Create a throwaway user so we don't disturb the fixtures.
	uid := uuid.New()
	if _, err := st.CreateUser(c, uid, "throwaway_"+uid.String()[:8]); err != nil {
		t.Fatalf("CreateUser: %v", err)
	}

	if err := st.UpdateDisplayName(c, uid, "Throwaway User"); err != nil {
		t.Fatalf("UpdateDisplayName: %v", err)
	}

	got, err := st.GetUserByID(c, uid)
	if err != nil {
		t.Fatalf("GetUserByID: %v", err)
	}
	if got.DisplayName != "Throwaway User" {
		t.Errorf("DisplayName = %q, want %q", got.DisplayName, "Throwaway User")
	}
	// Phase 09b transitional: handle is kept in sync.
	if got.Handle != "Throwaway User" {
		t.Errorf("Handle (transitional) = %q, want %q", got.Handle, "Throwaway User")
	}

	// Non-existent user.
	if err := st.UpdateDisplayName(c, uuid.New(), "ghost"); !errors.Is(err, store.ErrNotFound) {
		t.Errorf("update ghost: got %v, want ErrNotFound", err)
	}
}

func TestUsersRoleAndAdminInvariants(t *testing.T) {
	st := openStore(t)
	c := ctx(t)

	// Fixture users default to role='user'.
	got, err := st.GetUserByID(c, aliceID)
	if err != nil {
		t.Fatalf("GetUserByID: %v", err)
	}
	if got.IsAdmin() {
		t.Error("fixture alice should not be admin")
	}

	// Promote a throwaway user to admin manually (no service layer yet).
	adminID := uuid.New()
	if _, err := st.CreateUser(c, adminID, "thr_admin_"+adminID.String()[:6]); err != nil {
		t.Fatalf("CreateUser: %v", err)
	}
	if _, err := st.Pool.Exec(c,
		`UPDATE users SET role = 'admin' WHERE id = $1`, adminID,
	); err != nil {
		t.Fatalf("promote to admin: %v", err)
	}

	got, err = st.GetUserByID(c, adminID)
	if err != nil {
		t.Fatalf("GetUserByID: %v", err)
	}
	if !got.IsAdmin() {
		t.Error("after promote, IsAdmin should be true")
	}

	// Admin singleton invariant: promoting a second user must fail.
	otherID := uuid.New()
	if _, err := st.CreateUser(c, otherID, "thr_other_"+otherID.String()[:6]); err != nil {
		t.Fatalf("CreateUser: %v", err)
	}
	_, err = st.Pool.Exec(c,
		`UPDATE users SET role = 'admin' WHERE id = $1`, otherID,
	)
	if err == nil {
		t.Fatal("promoting a second admin should fail the singleton invariant")
	}
	if !strings.Contains(strings.ToLower(err.Error()), "users_single_admin_idx") &&
		!strings.Contains(strings.ToLower(err.Error()), "unique") {
		t.Errorf("expected unique-constraint error, got: %v", err)
	}

	// Refuse-admin-delete trigger.
	_, err = st.Pool.Exec(c, `DELETE FROM users WHERE id = $1`, adminID)
	if err == nil {
		t.Fatal("DELETE on admin row should be refused by trigger")
	}
	if !strings.Contains(err.Error(), "cannot delete admin user") {
		t.Errorf("expected trigger refusal, got: %v", err)
	}

	// Cleanup: demote and delete.
	if _, err := st.Pool.Exec(c,
		`UPDATE users SET role = 'user' WHERE id = $1`, adminID,
	); err != nil {
		t.Fatalf("demote: %v", err)
	}
	if _, err := st.Pool.Exec(c, `DELETE FROM users WHERE id IN ($1, $2)`, adminID, otherID); err != nil {
		t.Fatalf("cleanup: %v", err)
	}
}

// ---- sessions ---------------------------------------------------------

func TestSessionsCreateAndGet(t *testing.T) {
	st := openStore(t)
	c := ctx(t)

	sess, err := st.CreateSession(c, aliceID, "test-agent", net.ParseIP("127.0.0.1"))
	if err != nil {
		t.Fatalf("CreateSession: %v", err)
	}
	if len(sess.Token) != 32 {
		t.Errorf("Token length = %d, want 32", len(sess.Token))
	}
	if sess.UserID != aliceID {
		t.Errorf("UserID = %s, want %s", sess.UserID, aliceID)
	}
	if sess.UserAgent != "test-agent" {
		t.Errorf("UserAgent = %q", sess.UserAgent)
	}
	if sess.IPAddress == nil || sess.IPAddress.String() != "127.0.0.1" {
		t.Errorf("IPAddress = %v, want 127.0.0.1", sess.IPAddress)
	}

	got, err := st.GetSession(c, sess.Token)
	if err != nil {
		t.Fatalf("GetSession: %v", err)
	}
	if got.UserID != aliceID {
		t.Errorf("retrieved UserID = %s, want %s", got.UserID, aliceID)
	}
	if !bytes.Equal(got.Token, sess.Token) {
		t.Error("retrieved Token doesn't match")
	}

	// Cleanup.
	if err := st.DeleteSession(c, sess.Token); err != nil {
		t.Fatalf("DeleteSession: %v", err)
	}
}

func TestSessionsGetMissing(t *testing.T) {
	st := openStore(t)
	c := ctx(t)
	_, err := st.GetSession(c, []byte("not-a-real-token-32-bytes-padding"))
	if !errors.Is(err, store.ErrNotFound) {
		t.Errorf("got %v, want ErrNotFound", err)
	}
}

func TestSessionsTouchExtendsTTL(t *testing.T) {
	st := openStore(t)
	c := ctx(t)

	sess, err := st.CreateSession(c, aliceID, "", nil)
	if err != nil {
		t.Fatalf("CreateSession: %v", err)
	}
	t.Cleanup(func() { _ = st.DeleteSession(c, sess.Token) })

	originalExpiry := sess.ExpiresAt
	// Sleep so the new last_used_at and expires_at are observably later.
	time.Sleep(20 * time.Millisecond)

	if err := st.TouchSession(c, sess.Token); err != nil {
		t.Fatalf("TouchSession: %v", err)
	}

	got, err := st.GetSession(c, sess.Token)
	if err != nil {
		t.Fatalf("GetSession after touch: %v", err)
	}
	if !got.ExpiresAt.After(originalExpiry) {
		t.Errorf("ExpiresAt didn't advance: original=%v new=%v", originalExpiry, got.ExpiresAt)
	}
	if !got.LastUsedAt.After(sess.CreatedAt) {
		t.Errorf("LastUsedAt didn't advance: created=%v last_used=%v", sess.CreatedAt, got.LastUsedAt)
	}
}

func TestSessionsDeleteAllForUser(t *testing.T) {
	st := openStore(t)
	c := ctx(t)

	// Create three sessions for alice.
	for i := 0; i < 3; i++ {
		if _, err := st.CreateSession(c, aliceID, "", nil); err != nil {
			t.Fatalf("CreateSession #%d: %v", i, err)
		}
	}

	n, err := st.DeleteAllSessionsForUser(c, aliceID)
	if err != nil {
		t.Fatalf("DeleteAllSessionsForUser: %v", err)
	}
	if n < 3 {
		t.Errorf("deleted %d, want >= 3", n)
	}

	sessions, err := st.ListSessionsForUser(c, aliceID)
	if err != nil {
		t.Fatalf("ListSessionsForUser: %v", err)
	}
	if len(sessions) != 0 {
		t.Errorf("alice has %d sessions after delete-all", len(sessions))
	}
}

func TestSessionsListReturnsActiveOnly(t *testing.T) {
	st := openStore(t)
	c := ctx(t)

	sess1, err := st.CreateSession(c, aliceID, "ua1", nil)
	if err != nil {
		t.Fatalf("CreateSession 1: %v", err)
	}
	sess2, err := st.CreateSession(c, aliceID, "ua2", nil)
	if err != nil {
		t.Fatalf("CreateSession 2: %v", err)
	}
	t.Cleanup(func() {
		_ = st.DeleteSession(c, sess1.Token)
		_ = st.DeleteSession(c, sess2.Token)
	})

	sessions, err := st.ListSessionsForUser(c, aliceID)
	if err != nil {
		t.Fatalf("ListSessionsForUser: %v", err)
	}
	if len(sessions) < 2 {
		t.Fatalf("want at least 2 sessions, got %d", len(sessions))
	}
	// List must NOT include the raw token.
	for _, s := range sessions {
		if s.Token != nil {
			t.Error("ListSessionsForUser must not leak the raw Token")
		}
	}
}

// ---- passkeys ---------------------------------------------------------

func TestPasskeysAddGetRevoke(t *testing.T) {
	st := openStore(t)
	c := ctx(t)

	credID := []byte("test-credential-id-bytes-1234")
	pubKey := []byte("fake-cose-cbor-key")

	pk, err := st.AddPasskey(c, credID, aliceID, pubKey, 0, []string{"internal", "hybrid"}, "alice's iPhone")
	if err != nil {
		t.Fatalf("AddPasskey: %v", err)
	}
	t.Cleanup(func() { _ = st.DeletePasskey(c, credID) })
	if pk.UserID != aliceID {
		t.Errorf("UserID = %s, want %s", pk.UserID, aliceID)
	}
	if pk.SignCount != 0 {
		t.Errorf("SignCount = %d, want 0", pk.SignCount)
	}

	got, err := st.GetPasskeyByCredentialID(c, credID)
	if err != nil {
		t.Fatalf("GetPasskeyByCredentialID: %v", err)
	}
	if !bytes.Equal(got.PublicKey, pubKey) {
		t.Error("PublicKey round-trip mismatch")
	}
	if got.Name != "alice's iPhone" {
		t.Errorf("Name = %q", got.Name)
	}
	if len(got.Transports) != 2 {
		t.Errorf("Transports = %v", got.Transports)
	}

	// Bump sign count.
	if err := st.UpdateSignCount(c, credID, 5); err != nil {
		t.Fatalf("UpdateSignCount: %v", err)
	}
	got, err = st.GetPasskeyByCredentialID(c, credID)
	if err != nil {
		t.Fatalf("GetPasskeyByCredentialID after bump: %v", err)
	}
	if got.SignCount != 5 {
		t.Errorf("SignCount after bump = %d, want 5", got.SignCount)
	}
	if got.LastUsedAt.IsZero() {
		t.Error("LastUsedAt should be set after UpdateSignCount")
	}

	// Rename.
	if err := st.RenamePasskey(c, credID, "renamed device"); err != nil {
		t.Fatalf("RenamePasskey: %v", err)
	}
	got, err = st.GetPasskeyByCredentialID(c, credID)
	if err != nil {
		t.Fatalf("GetPasskeyByCredentialID after rename: %v", err)
	}
	if got.Name != "renamed device" {
		t.Errorf("Name after rename = %q", got.Name)
	}

	// Delete.
	if err := st.DeletePasskey(c, credID); err != nil {
		t.Fatalf("DeletePasskey: %v", err)
	}
	_, err = st.GetPasskeyByCredentialID(c, credID)
	if !errors.Is(err, store.ErrNotFound) {
		t.Errorf("get after delete: got %v, want ErrNotFound", err)
	}
}

func TestPasskeysListAndCount(t *testing.T) {
	st := openStore(t)
	c := ctx(t)

	creds := [][]byte{
		[]byte("multi-test-passkey-1"),
		[]byte("multi-test-passkey-2"),
		[]byte("multi-test-passkey-3"),
	}
	for _, cid := range creds {
		if _, err := st.AddPasskey(c, cid, aliceID, []byte("pk"), 0, nil, ""); err != nil {
			t.Fatalf("AddPasskey: %v", err)
		}
		t.Cleanup(func() { _ = st.DeletePasskey(c, cid) })
	}

	got, err := st.GetPasskeysForUser(c, aliceID)
	if err != nil {
		t.Fatalf("GetPasskeysForUser: %v", err)
	}
	if len(got) < 3 {
		t.Errorf("got %d passkeys, want >= 3", len(got))
	}

	n, err := st.CountPasskeysForUser(c, aliceID)
	if err != nil {
		t.Fatalf("CountPasskeysForUser: %v", err)
	}
	if n < 3 {
		t.Errorf("count = %d, want >= 3", n)
	}
}

// ---- recovery codes ---------------------------------------------------

func TestRecoveryCodeRoundTrip(t *testing.T) {
	st := openStore(t)
	c := ctx(t)

	// Use a throwaway user so we don't conflict with the fixture
	// (other tests might also exercise recovery codes for alice).
	uid := uuid.New()
	if _, err := st.CreateUser(c, uid, "rc_"+uid.String()[:8]); err != nil {
		t.Fatalf("CreateUser: %v", err)
	}
	t.Cleanup(func() {
		_, _ = st.Pool.Exec(c, `DELETE FROM users WHERE id = $1`, uid)
	})

	// No row yet.
	_, err := st.GetRecoveryCode(c, uid)
	if !errors.Is(err, store.ErrNotFound) {
		t.Errorf("get before set: got %v, want ErrNotFound", err)
	}

	// Set.
	if err := st.SetRecoveryCode(c, uid, []byte("fake-argon2id-hash")); err != nil {
		t.Fatalf("SetRecoveryCode: %v", err)
	}
	got, err := st.GetRecoveryCode(c, uid)
	if err != nil {
		t.Fatalf("GetRecoveryCode: %v", err)
	}
	if got.HasBeenUsed() {
		t.Error("fresh code should not be marked used")
	}

	// Mark used.
	if err := st.MarkRecoveryCodeUsed(c, uid); err != nil {
		t.Fatalf("MarkRecoveryCodeUsed: %v", err)
	}
	got, err = st.GetRecoveryCode(c, uid)
	if err != nil {
		t.Fatalf("GetRecoveryCode after use: %v", err)
	}
	if !got.HasBeenUsed() {
		t.Error("used code should be marked used")
	}

	// Double-use is refused.
	err = st.MarkRecoveryCodeUsed(c, uid)
	if !errors.Is(err, store.ErrRecoveryCodeAlreadyUsed) {
		t.Errorf("double-use: got %v, want ErrRecoveryCodeAlreadyUsed", err)
	}

	// Regenerate clears used_at.
	if err := st.SetRecoveryCode(c, uid, []byte("new-hash")); err != nil {
		t.Fatalf("SetRecoveryCode (regen): %v", err)
	}
	got, err = st.GetRecoveryCode(c, uid)
	if err != nil {
		t.Fatalf("GetRecoveryCode after regen: %v", err)
	}
	if got.HasBeenUsed() {
		t.Error("regen should reset used_at to NULL")
	}
}

// ---- admin bootstrap tokens ------------------------------------------

func TestAdminBootstrapTokenLifecycle(t *testing.T) {
	st := openStore(t)
	c := ctx(t)

	// Sweep any pre-existing tokens so this test is isolated. Other
	// tests might leak state.
	if _, err := st.Pool.Exec(c, `DELETE FROM admin_bootstrap_tokens`); err != nil {
		t.Fatalf("sweep: %v", err)
	}
	t.Cleanup(func() {
		_, _ = st.Pool.Exec(c, `DELETE FROM admin_bootstrap_tokens`)
	})

	// No active token initially.
	_, err := st.GetActiveAdminBootstrapToken(c)
	if !errors.Is(err, store.ErrNotFound) {
		t.Errorf("initial: got %v, want ErrNotFound", err)
	}

	// Create one.
	tok, err := st.CreateAdminBootstrapToken(c)
	if err != nil {
		t.Fatalf("CreateAdminBootstrapToken: %v", err)
	}
	if len(tok.Token) != 32 {
		t.Errorf("Token length = %d, want 32", len(tok.Token))
	}
	if !tok.IsActive() {
		t.Error("fresh token should be active")
	}

	// Fetch active.
	got, err := st.GetActiveAdminBootstrapToken(c)
	if err != nil {
		t.Fatalf("GetActiveAdminBootstrapToken: %v", err)
	}
	if !bytes.Equal(got.Token, tok.Token) {
		t.Error("active token doesn't match created")
	}

	// Creating a second concurrent token is refused.
	_, err = st.CreateAdminBootstrapToken(c)
	if !errors.Is(err, store.ErrAdminBootstrapActive) {
		t.Errorf("second create: got %v, want ErrAdminBootstrapActive", err)
	}

	// Rotate replaces the active token.
	rotated, err := st.RotateAdminBootstrapToken(c)
	if err != nil {
		t.Fatalf("RotateAdminBootstrapToken: %v", err)
	}
	if bytes.Equal(rotated.Token, tok.Token) {
		t.Error("rotation should produce a different token")
	}
	got, err = st.GetActiveAdminBootstrapToken(c)
	if err != nil {
		t.Fatalf("GetActive after rotate: %v", err)
	}
	if !bytes.Equal(got.Token, rotated.Token) {
		t.Error("active token after rotate should be the new one")
	}

	// Consume.
	if err := st.ConsumeAdminBootstrapToken(c, rotated.Token); err != nil {
		t.Fatalf("ConsumeAdminBootstrapToken: %v", err)
	}
	// Now no active token.
	_, err = st.GetActiveAdminBootstrapToken(c)
	if !errors.Is(err, store.ErrNotFound) {
		t.Errorf("after consume: got %v, want ErrNotFound", err)
	}
	// Double-consume is refused.
	err = st.ConsumeAdminBootstrapToken(c, rotated.Token)
	if !errors.Is(err, store.ErrNotFound) {
		t.Errorf("double-consume: got %v, want ErrNotFound", err)
	}
}
