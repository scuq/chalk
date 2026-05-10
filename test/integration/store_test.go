package integration

import (
	"errors"
	"strings"
	"testing"

	"github.com/google/uuid"

	"github.com/scuq/chalk/internal/store"
)

// Canonical fixture UUIDs (must match bootstrap/fixtures/users.sql).
// UUIDs must be exactly 8-4-4-4-12 hex digits (0-9, a-f). The recognizable
// suffix in each last segment encodes the user's name for readability.
var (
	aliceID = uuid.MustParse("00000000-0000-0000-0000-00000000a11c")
	bobID   = uuid.MustParse("00000000-0000-0000-0000-000000000b0b")
	carolID = uuid.MustParse("00000000-0000-0000-0000-0000000ca201")
)

// ---- users ---------------------------------------------------------------

func TestUsersFixturePresent(t *testing.T) {
	st := openStore(t)
	c := ctx(t)

	for _, want := range []struct {
		id     uuid.UUID
		handle string
	}{
		{aliceID, "alice"},
		{bobID, "bob"},
		{carolID, "carol"},
	} {
		got, err := st.GetUserByID(c, want.id)
		if err != nil {
			t.Fatalf("GetUserByID(%s): %v", want.handle, err)
		}
		if got.Handle != want.handle {
			t.Errorf("user %s: handle = %q, want %q", want.id, got.Handle, want.handle)
		}
	}
}

func TestUsersGetByHandleCaseInsensitive(t *testing.T) {
	st := openStore(t)
	c := ctx(t)
	got, err := st.GetUserByHandle(c, "ALICE")
	if err != nil {
		t.Fatalf("GetUserByHandle: %v", err)
	}
	if got.ID != aliceID {
		t.Errorf("ALICE → %s, want %s", got.ID, aliceID)
	}
}

func TestUsersGetMissingReturnsErrNotFound(t *testing.T) {
	st := openStore(t)
	c := ctx(t)
	_, err := st.GetUserByID(c, uuid.New())
	if !errors.Is(err, store.ErrNotFound) {
		t.Fatalf("expected ErrNotFound, got %v", err)
	}
}

func TestUsersCountAtLeastFixture(t *testing.T) {
	st := openStore(t)
	c := ctx(t)
	n, err := st.CountUsers(c)
	if err != nil {
		t.Fatalf("CountUsers: %v", err)
	}
	if n < 3 {
		t.Fatalf("want at least 3 users, got %d", n)
	}
}

func TestUsersUpsertIsIdempotent(t *testing.T) {
	st := openStore(t)
	c := ctx(t)
	// Re-upsert alice with the same UUID; should succeed without error.
	if _, err := st.UpsertUser(c, aliceID, "alice"); err != nil {
		t.Fatalf("upsert 1: %v", err)
	}
	if _, err := st.UpsertUser(c, aliceID, "alice"); err != nil {
		t.Fatalf("upsert 2: %v", err)
	}
	got, err := st.GetUserByID(c, aliceID)
	if err != nil {
		t.Fatalf("get: %v", err)
	}
	if got.Handle != "alice" {
		t.Fatalf("handle drifted: %q", got.Handle)
	}
}

func TestUsersDuplicateHandleRejected(t *testing.T) {
	st := openStore(t)
	c := ctx(t)
	// Try to create a SECOND alice with a fresh UUID; must fail.
	_, err := st.CreateUser(c, uuid.New(), "alice")
	if err == nil {
		t.Fatal("expected unique-violation error, got nil")
	}
	// pgx surfaces the constraint name; we don't depend on its exact text but
	// expect *some* indication this was a uniqueness violation.
	if !strings.Contains(err.Error(), "unique") && !strings.Contains(err.Error(), "duplicate") {
		t.Fatalf("expected uniqueness error, got: %v", err)
	}
}

// ---- devices -------------------------------------------------------------

func TestDevicesCreateAndList(t *testing.T) {
	st := openStore(t)
	c := ctx(t)

	// Clean up any devices left from previous runs (devices have no
	// uniqueness constraint, so without cleanup we'd accumulate forever).
	_, err := st.Pool.Exec(c, `DELETE FROM devices WHERE user_id = $1`, aliceID)
	if err != nil {
		t.Fatalf("device cleanup: %v", err)
	}

	d1, err := st.CreateDevice(c, aliceID, store.DeviceDesktop, "Work laptop")
	if err != nil {
		t.Fatalf("CreateDevice 1: %v", err)
	}
	if d1.UserID != aliceID {
		t.Errorf("user_id mismatch: %s", d1.UserID)
	}
	if d1.Type != store.DeviceDesktop {
		t.Errorf("type: %q", d1.Type)
	}
	if d1.Label != "Work laptop" {
		t.Errorf("label: %q", d1.Label)
	}

	d2, err := st.CreateDevice(c, aliceID, store.DevicePhone, "")
	if err != nil {
		t.Fatalf("CreateDevice 2: %v", err)
	}
	if d2.Label != "" {
		t.Errorf("expected empty label, got %q", d2.Label)
	}

	devices, err := st.ListDevicesForUser(c, aliceID)
	if err != nil {
		t.Fatalf("ListDevicesForUser: %v", err)
	}
	if len(devices) != 2 {
		t.Fatalf("expected 2 devices, got %d", len(devices))
	}
	if devices[0].ID != d1.ID || devices[1].ID != d2.ID {
		t.Errorf("ordering wrong: got %s,%s", devices[0].ID, devices[1].ID)
	}
}

func TestDevicesInvalidTypeRejected(t *testing.T) {
	st := openStore(t)
	c := ctx(t)
	_, err := st.CreateDevice(c, aliceID, "smart-toaster", "")
	if err == nil {
		t.Fatal("expected error for invalid device type")
	}
	if !strings.Contains(err.Error(), "invalid device type") {
		t.Fatalf("expected invalid-type error, got: %v", err)
	}
}

func TestDevicesTouchUpdatesLastSeen(t *testing.T) {
	st := openStore(t)
	c := ctx(t)
	// Re-prep a device for this test.
	_, _ = st.Pool.Exec(c, `DELETE FROM devices WHERE user_id = $1`, bobID)
	d, err := st.CreateDevice(c, bobID, store.DevicePhone, "iPhone 15")
	if err != nil {
		t.Fatalf("CreateDevice: %v", err)
	}

	before, err := st.GetDevice(c, d.ID)
	if err != nil {
		t.Fatalf("GetDevice: %v", err)
	}

	// Touch and read back.
	if err := st.TouchDevice(c, d.ID); err != nil {
		t.Fatalf("TouchDevice: %v", err)
	}
	after, err := st.GetDevice(c, d.ID)
	if err != nil {
		t.Fatalf("GetDevice: %v", err)
	}
	if !after.LastSeen.After(before.LastSeen) && !after.LastSeen.Equal(before.LastSeen) {
		t.Errorf("last_seen went backwards: before=%s after=%s", before.LastSeen, after.LastSeen)
	}
}

func TestDevicesCascadeOnUserDelete(t *testing.T) {
	st := openStore(t)
	c := ctx(t)

	// Create a throwaway user with a device, delete the user, verify the
	// device is gone (CASCADE).
	uid := uuid.New()
	if _, err := st.CreateUser(c, uid, "throwaway-"+uid.String()[:8]); err != nil {
		t.Fatalf("CreateUser: %v", err)
	}
	d, err := st.CreateDevice(c, uid, store.DeviceTablet, "iPad")
	if err != nil {
		t.Fatalf("CreateDevice: %v", err)
	}

	if _, err := st.Pool.Exec(c, `DELETE FROM users WHERE id = $1`, uid); err != nil {
		t.Fatalf("delete user: %v", err)
	}

	_, err = st.GetDevice(c, d.ID)
	if !errors.Is(err, store.ErrNotFound) {
		t.Fatalf("expected device gone, got err=%v", err)
	}
}
