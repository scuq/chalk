package integration

import (
	"errors"
	"strings"
	"testing"
	"time"

	"github.com/google/uuid"

	"github.com/scuq/chalk/internal/store"
)

// Phase 09d-1 store-layer integration tests. Cover:
//
//   - BootstrapAdminUser (singleton, role='admin', no passkey yet)
//   - GetAdminUser (returns the singleton; ErrNotFound when absent)
//   - BlockUser / UnblockUser (idempotent, refuses admin)
//   - SoftDeleteUser (idempotent, refuses admin)
//   - PurgeUser (cascades, refuses admin, returns identity)
//   - ListUsers (pagination, search, status fields)
//   - ListBlacklist (pagination)
//
// The fixture users (alice/bob/carol) all have role='user'; admin
// state is set up per-test by inserting via raw SQL on a fresh
// connection to bypass the singleton index between test runs.
//
// Many tests need an isolated DB state. They are NOT parallel:
// they share a single Postgres instance via CHALK_TEST_PGURL and
// would race each other on the singleton admin row otherwise. The
// reset helper below wipes any admin / non-fixture rows before each
// test that needs a clean slate.

// resetAdminState removes any admin row and any non-fixture users
// so a test starts from a known state. The fixture rows
// (alice/bob/carol via aliceID/bobID/carolID) are preserved.
func resetAdminState(t *testing.T) {
	t.Helper()
	st := openStore(t)
	c := ctx(t)
	// Find and DELETE the admin row, if any. The refuse_admin_delete
	// trigger blocks ordinary DELETE; we temporarily disable it for
	// the test reset, then restore. This is test-only contagion;
	// production code never disables triggers.
	if _, err := st.Pool.Exec(c, `ALTER TABLE users DISABLE TRIGGER admin_delete_guard`); err != nil {
		t.Fatalf("disable trigger: %v", err)
	}
	defer func() {
		if _, err := st.Pool.Exec(c, `ALTER TABLE users ENABLE TRIGGER admin_delete_guard`); err != nil {
			t.Errorf("re-enable trigger: %v", err)
		}
	}()
	if _, err := st.Pool.Exec(c, `DELETE FROM users WHERE role = 'admin'`); err != nil {
		t.Fatalf("clear admin: %v", err)
	}
	// Clear any non-fixture user. Cascades through sessions etc.
	if _, err := st.Pool.Exec(c,
		`DELETE FROM users WHERE id NOT IN ($1, $2, $3)`,
		aliceID, bobID, carolID,
	); err != nil {
		t.Fatalf("clear non-fixture users: %v", err)
	}
	// Clear admin_bootstrap_tokens so a fresh bootstrap can run.
	if _, err := st.Pool.Exec(c, `DELETE FROM admin_bootstrap_tokens`); err != nil {
		t.Fatalf("clear bootstrap tokens: %v", err)
	}
	// Clear email_blacklist (so PurgeUser tests can re-add).
	if _, err := st.Pool.Exec(c, `DELETE FROM email_blacklist`); err != nil {
		t.Fatalf("clear blacklist: %v", err)
	}
	// Clear blocked_at and deleted_at on fixture rows so block/
	// soft-delete tests have a clean starting state.
	if _, err := st.Pool.Exec(c,
		`UPDATE users SET blocked_at = NULL, deleted_at = NULL
		   WHERE id IN ($1, $2, $3)`,
		aliceID, bobID, carolID,
	); err != nil {
		t.Fatalf("clear lifecycle: %v", err)
	}
}

// ---- BootstrapAdminUser -----------------------------------------------

func TestBootstrapAdminUserHappyPath(t *testing.T) {
	resetAdminState(t)
	st := openStore(t)
	c := ctx(t)

	u, err := st.BootstrapAdminUser(c, store.BootstrapAdminUserParams{
		Username:    "rootadmin",
		Email:       "root@example.invalid",
		DisplayName: "Root",
	})
	if err != nil {
		t.Fatalf("BootstrapAdminUser: %v", err)
	}
	if u.Role != "admin" {
		t.Errorf("Role = %q, want admin", u.Role)
	}
	if u.Username != "rootadmin" {
		t.Errorf("Username = %q, want rootadmin", u.Username)
	}
	if u.DisplayName != "Root" {
		t.Errorf("DisplayName = %q, want Root", u.DisplayName)
	}
	if u.Email != "root@example.invalid" {
		t.Errorf("Email = %q, want root@example.invalid", u.Email)
	}
	if u.EmailVerifiedAt.IsZero() {
		t.Error("EmailVerifiedAt should be set on bootstrap")
	}

	// Second call refuses with ErrAdminExists.
	_, err = st.BootstrapAdminUser(c, store.BootstrapAdminUserParams{
		Username: "otheradmin",
		Email:    "other@example.invalid",
	})
	if !errors.Is(err, store.ErrAdminExists) {
		t.Errorf("second BootstrapAdminUser err = %v, want ErrAdminExists", err)
	}
}

func TestBootstrapAdminUserDefaultsDisplayName(t *testing.T) {
	resetAdminState(t)
	st := openStore(t)
	c := ctx(t)
	u, err := st.BootstrapAdminUser(c, store.BootstrapAdminUserParams{
		Username: "thedmin",
		Email:    "thedmin@example.invalid",
		// DisplayName intentionally empty
	})
	if err != nil {
		t.Fatalf("BootstrapAdminUser: %v", err)
	}
	if u.DisplayName != "thedmin" {
		t.Errorf("DisplayName fallback = %q, want thedmin", u.DisplayName)
	}
}

func TestBootstrapAdminUserCollidesWithExistingUsername(t *testing.T) {
	resetAdminState(t)
	st := openStore(t)
	c := ctx(t)
	// alice is a fixture user; try to bootstrap with the same username.
	_, err := st.BootstrapAdminUser(c, store.BootstrapAdminUserParams{
		Username: "alice",
		Email:    "admin-alice@example.invalid",
	})
	if !errors.Is(err, store.ErrUsernameTaken) {
		t.Errorf("err = %v, want ErrUsernameTaken", err)
	}
}

func TestBootstrapAdminUserCollidesWithExistingEmail(t *testing.T) {
	resetAdminState(t)
	st := openStore(t)
	c := ctx(t)
	// alice has email alice@localhost.invalid
	_, err := st.BootstrapAdminUser(c, store.BootstrapAdminUserParams{
		Username: "freshname",
		Email:    "alice@localhost.invalid",
	})
	if !errors.Is(err, store.ErrEmailTaken) {
		t.Errorf("err = %v, want ErrEmailTaken", err)
	}
}

// ---- GetAdminUser ------------------------------------------------------

func TestGetAdminUserReturnsErrNotFoundWhenAbsent(t *testing.T) {
	resetAdminState(t)
	st := openStore(t)
	c := ctx(t)
	_, err := st.GetAdminUser(c)
	if !errors.Is(err, store.ErrNotFound) {
		t.Errorf("GetAdminUser err = %v, want ErrNotFound", err)
	}
}

func TestGetAdminUserReturnsSingleton(t *testing.T) {
	resetAdminState(t)
	st := openStore(t)
	c := ctx(t)
	want, err := st.BootstrapAdminUser(c, store.BootstrapAdminUserParams{
		Username: "singleadmin",
		Email:    "singleadmin@example.invalid",
	})
	if err != nil {
		t.Fatalf("BootstrapAdminUser: %v", err)
	}
	got, err := st.GetAdminUser(c)
	if err != nil {
		t.Fatalf("GetAdminUser: %v", err)
	}
	if got.ID != want.ID {
		t.Errorf("ID = %s, want %s", got.ID, want.ID)
	}
	if got.Username != "singleadmin" {
		t.Errorf("Username = %q", got.Username)
	}
}

// ---- BlockUser / UnblockUser -----------------------------------------

func TestBlockUserHappyPath(t *testing.T) {
	resetAdminState(t)
	st := openStore(t)
	c := ctx(t)

	if err := st.BlockUser(c, aliceID); err != nil {
		t.Fatalf("BlockUser: %v", err)
	}

	// Verify by reading the column directly; the User struct also
	// gains BlockedAt via the migration so we can re-read.
	var blockedAt *time.Time
	if err := st.Pool.QueryRow(c,
		`SELECT blocked_at FROM users WHERE id = $1`, aliceID,
	).Scan(&blockedAt); err != nil {
		t.Fatalf("read blocked_at: %v", err)
	}
	if blockedAt == nil {
		t.Fatal("blocked_at not set")
	}

	// Re-block: timestamp should NOT change (COALESCE preserves first).
	first := *blockedAt
	time.Sleep(20 * time.Millisecond)
	if err := st.BlockUser(c, aliceID); err != nil {
		t.Fatalf("re-block: %v", err)
	}
	if err := st.Pool.QueryRow(c,
		`SELECT blocked_at FROM users WHERE id = $1`, aliceID,
	).Scan(&blockedAt); err != nil {
		t.Fatalf("read blocked_at after re-block: %v", err)
	}
	if blockedAt == nil {
		t.Fatal("blocked_at cleared by re-block; want unchanged")
	}
	if !blockedAt.Equal(first) {
		t.Errorf("blocked_at changed on re-block: %v -> %v", first, *blockedAt)
	}
}

func TestBlockUserNotFound(t *testing.T) {
	st := openStore(t)
	c := ctx(t)
	bogus := uuid.New()
	err := st.BlockUser(c, bogus)
	if !errors.Is(err, store.ErrNotFound) {
		t.Errorf("err = %v, want ErrNotFound", err)
	}
}

func TestBlockUserRefusesAdmin(t *testing.T) {
	resetAdminState(t)
	st := openStore(t)
	c := ctx(t)
	admin, err := st.BootstrapAdminUser(c, store.BootstrapAdminUserParams{
		Username: "blockmenot",
		Email:    "blockmenot@example.invalid",
	})
	if err != nil {
		t.Fatalf("BootstrapAdminUser: %v", err)
	}
	err = st.BlockUser(c, admin.ID)
	if !errors.Is(err, store.ErrCannotModifyAdmin) {
		t.Errorf("err = %v, want ErrCannotModifyAdmin", err)
	}
}

func TestUnblockUserClears(t *testing.T) {
	resetAdminState(t)
	st := openStore(t)
	c := ctx(t)
	if err := st.BlockUser(c, bobID); err != nil {
		t.Fatalf("BlockUser: %v", err)
	}
	if err := st.UnblockUser(c, bobID); err != nil {
		t.Fatalf("UnblockUser: %v", err)
	}
	var blockedAt *time.Time
	if err := st.Pool.QueryRow(c,
		`SELECT blocked_at FROM users WHERE id = $1`, bobID,
	).Scan(&blockedAt); err != nil {
		t.Fatalf("read blocked_at: %v", err)
	}
	if blockedAt != nil {
		t.Errorf("blocked_at = %v, want nil", blockedAt)
	}
}

func TestUnblockUserIdempotent(t *testing.T) {
	resetAdminState(t)
	st := openStore(t)
	c := ctx(t)
	// carol is not blocked; unblock should be a no-op
	if err := st.UnblockUser(c, carolID); err != nil {
		t.Errorf("unblock of not-blocked: %v", err)
	}
}

// ---- SoftDeleteUser ---------------------------------------------------

func TestSoftDeleteUserHappyPath(t *testing.T) {
	resetAdminState(t)
	st := openStore(t)
	c := ctx(t)
	if err := st.SoftDeleteUser(c, aliceID); err != nil {
		t.Fatalf("SoftDeleteUser: %v", err)
	}
	var deletedAt *time.Time
	if err := st.Pool.QueryRow(c,
		`SELECT deleted_at FROM users WHERE id = $1`, aliceID,
	).Scan(&deletedAt); err != nil {
		t.Fatalf("read deleted_at: %v", err)
	}
	if deletedAt == nil {
		t.Error("deleted_at not set")
	}
}

func TestSoftDeleteUserRefusesAdmin(t *testing.T) {
	resetAdminState(t)
	st := openStore(t)
	c := ctx(t)
	admin, err := st.BootstrapAdminUser(c, store.BootstrapAdminUserParams{
		Username: "softpreserve",
		Email:    "softpreserve@example.invalid",
	})
	if err != nil {
		t.Fatalf("BootstrapAdminUser: %v", err)
	}
	err = st.SoftDeleteUser(c, admin.ID)
	if !errors.Is(err, store.ErrCannotModifyAdmin) {
		t.Errorf("err = %v, want ErrCannotModifyAdmin", err)
	}
}

// ---- PurgeUser --------------------------------------------------------

func TestPurgeUserHappyPath(t *testing.T) {
	resetAdminState(t)
	st := openStore(t)
	c := ctx(t)
	// Create a throwaway user so we can purge them without nuking
	// a fixture (fixtures are shared across tests).
	throwaway, err := st.CreateUser(c, uuid.New(), "purgevictim")
	if err != nil {
		t.Fatalf("CreateUser: %v", err)
	}
	pu, err := st.PurgeUser(c, throwaway.ID)
	if err != nil {
		t.Fatalf("PurgeUser: %v", err)
	}
	if pu.UserID != throwaway.ID {
		t.Errorf("UserID = %s, want %s", pu.UserID, throwaway.ID)
	}
	if pu.Username != "purgevictim" {
		t.Errorf("Username = %q, want purgevictim", pu.Username)
	}
	if !strings.Contains(pu.Email, "purgevictim") {
		t.Errorf("Email = %q, want substring purgevictim", pu.Email)
	}
	// Row really gone
	_, err = st.GetUserByID(c, throwaway.ID)
	if !errors.Is(err, store.ErrNotFound) {
		t.Errorf("GetUserByID after purge: err = %v, want ErrNotFound", err)
	}
}

func TestPurgeUserRefusesAdmin(t *testing.T) {
	resetAdminState(t)
	st := openStore(t)
	c := ctx(t)
	admin, err := st.BootstrapAdminUser(c, store.BootstrapAdminUserParams{
		Username: "purgeproof",
		Email:    "purgeproof@example.invalid",
	})
	if err != nil {
		t.Fatalf("BootstrapAdminUser: %v", err)
	}
	_, err = st.PurgeUser(c, admin.ID)
	if !errors.Is(err, store.ErrCannotModifyAdmin) {
		t.Errorf("err = %v, want ErrCannotModifyAdmin", err)
	}
}

func TestPurgeUserNotFound(t *testing.T) {
	st := openStore(t)
	c := ctx(t)
	_, err := st.PurgeUser(c, uuid.New())
	if !errors.Is(err, store.ErrNotFound) {
		t.Errorf("err = %v, want ErrNotFound", err)
	}
}

// ---- ListUsers --------------------------------------------------------

func TestListUsersPagination(t *testing.T) {
	resetAdminState(t)
	st := openStore(t)
	c := ctx(t)
	// Three fixture users exist (alice/bob/carol). With limit=2 the
	// first page returns 2; the second page returns 1.
	page1, err := st.ListUsers(c, store.ListUsersParams{Limit: 2, Offset: 0})
	if err != nil {
		t.Fatalf("ListUsers page 1: %v", err)
	}
	if got := len(page1.Users); got != 2 {
		t.Errorf("page1 len = %d, want 2", got)
	}
	if page1.Total < 3 {
		t.Errorf("Total = %d, want >= 3", page1.Total)
	}
	page2, err := st.ListUsers(c, store.ListUsersParams{Limit: 2, Offset: 2})
	if err != nil {
		t.Fatalf("ListUsers page 2: %v", err)
	}
	if got := len(page2.Users); got < 1 {
		t.Errorf("page2 len = %d, want >= 1", got)
	}
	// Pages must not overlap
	seen := map[uuid.UUID]bool{}
	for _, u := range page1.Users {
		seen[u.ID] = true
	}
	for _, u := range page2.Users {
		if seen[u.ID] {
			t.Errorf("user %s appears on both pages", u.ID)
		}
	}
}

func TestListUsersSearchByUsername(t *testing.T) {
	resetAdminState(t)
	st := openStore(t)
	c := ctx(t)
	res, err := st.ListUsers(c, store.ListUsersParams{Search: "alice"})
	if err != nil {
		t.Fatalf("ListUsers: %v", err)
	}
	// alice should match; bob/carol should not.
	found := false
	for _, u := range res.Users {
		if u.Username == "alice" {
			found = true
		}
		if u.Username == "bob" || u.Username == "carol" {
			t.Errorf("search 'alice' matched %q", u.Username)
		}
	}
	if !found {
		t.Error("search 'alice' did not match alice")
	}
}

func TestListUsersSearchByEmail(t *testing.T) {
	resetAdminState(t)
	st := openStore(t)
	c := ctx(t)
	res, err := st.ListUsers(c, store.ListUsersParams{Search: "bob@localhost"})
	if err != nil {
		t.Fatalf("ListUsers: %v", err)
	}
	if len(res.Users) != 1 || res.Users[0].Username != "bob" {
		t.Errorf("search by email: got %d results, want bob", len(res.Users))
	}
}

func TestListUsersSearchEscapesWildcards(t *testing.T) {
	resetAdminState(t)
	st := openStore(t)
	c := ctx(t)
	// "%" is a SQL wildcard; user input containing it must not match
	// everything. None of the fixtures have % in their username; an
	// unescaped LIKE would return all rows.
	res, err := st.ListUsers(c, store.ListUsersParams{Search: "%"})
	if err != nil {
		t.Fatalf("ListUsers: %v", err)
	}
	if len(res.Users) > 0 {
		t.Errorf("search '%%' returned %d, want 0 (wildcard must be escaped)", len(res.Users))
	}
}

func TestListUsersStatusFields(t *testing.T) {
	resetAdminState(t)
	st := openStore(t)
	c := ctx(t)
	if err := st.BlockUser(c, aliceID); err != nil {
		t.Fatalf("BlockUser: %v", err)
	}
	if err := st.SoftDeleteUser(c, bobID); err != nil {
		t.Fatalf("SoftDeleteUser: %v", err)
	}
	res, err := st.ListUsers(c, store.ListUsersParams{})
	if err != nil {
		t.Fatalf("ListUsers: %v", err)
	}
	statuses := map[uuid.UUID]struct {
		blocked, deleted bool
	}{}
	for _, u := range res.Users {
		statuses[u.ID] = struct{ blocked, deleted bool }{u.IsBlocked(), u.IsDeleted()}
	}
	if !statuses[aliceID].blocked {
		t.Error("alice should be blocked")
	}
	if statuses[aliceID].deleted {
		t.Error("alice should not be deleted")
	}
	if !statuses[bobID].deleted {
		t.Error("bob should be soft-deleted")
	}
	if statuses[carolID].blocked || statuses[carolID].deleted {
		t.Error("carol should be active")
	}
}

// ---- ListBlacklist ----------------------------------------------------

func TestListBlacklistPagination(t *testing.T) {
	resetAdminState(t)
	st := openStore(t)
	c := ctx(t)
	// Seed three entries.
	for i, email := range []string{
		"one@example.invalid",
		"two@example.invalid",
		"three@example.invalid",
	} {
		if err := st.AddToBlacklist(c, store.AddToBlacklistParams{
			Email:  email,
			Reason: "test",
		}); err != nil {
			t.Fatalf("AddToBlacklist[%d]: %v", i, err)
		}
	}
	res, err := st.ListBlacklist(c, store.ListBlacklistParams{Limit: 2})
	if err != nil {
		t.Fatalf("ListBlacklist: %v", err)
	}
	if len(res.Entries) != 2 {
		t.Errorf("entries len = %d, want 2", len(res.Entries))
	}
	if res.Total != 3 {
		t.Errorf("Total = %d, want 3", res.Total)
	}
}

func TestListBlacklistEmpty(t *testing.T) {
	resetAdminState(t)
	st := openStore(t)
	c := ctx(t)
	res, err := st.ListBlacklist(c, store.ListBlacklistParams{})
	if err != nil {
		t.Fatalf("ListBlacklist: %v", err)
	}
	if len(res.Entries) != 0 {
		t.Errorf("entries len = %d, want 0", len(res.Entries))
	}
	if res.Total != 0 {
		t.Errorf("Total = %d, want 0", res.Total)
	}
	// Must be a non-nil empty slice for JSON []
	if res.Entries == nil {
		t.Error("entries should be empty slice, not nil")
	}
}
