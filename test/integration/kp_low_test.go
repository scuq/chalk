package integration

// Phase 11c-5: the low-stock detection threshold logic. We assert the
// store-level invariant the push relies on -- that CountUnusedKeyPackages
// reflects claims down past the low-water mark -- without standing up a
// full WS server (push delivery is covered by the hub tests).
//
// Uses a dedicated throwaway user (fresh UUID + unique handle) so it
// never collides with the shared phase11c1 fixtures that setupPhase11c1
// seeds.

import (
	"strings"
	"testing"

	"github.com/google/uuid"

	"github.com/scuq/chalk/internal/store"
)

func TestPhase11c5_KpLow_CountReflectsClaims(t *testing.T) {
	st, _, _, _ := setupPhase11c1(t)
	c := ctx(t)

	// Dedicated user for this test; fresh id avoids any fixture clash.
	userID := uuid.New()
	// Unique per-run handle (hyphens stripped; regex ^[a-z0-9_]{3,32}$),
	// so re-runs never collide on handle -- UpsertUser's
	// ON CONFLICT (handle) DO UPDATE SET id would otherwise re-point an
	// existing handle to a new id while a device still references the old
	// one (devices_user_id_fkey, 23503).
	handle := "p11c5_" + strings.ReplaceAll(userID.String(), "-", "")[:12]
	if _, err := st.UpsertUser(c, userID, handle); err != nil {
		t.Fatalf("upsert test user: %v", err)
	}
	devID := uuid.New()
	if _, err := st.Pool.Exec(c,
		`INSERT INTO devices (id, user_id, device_label)
		 VALUES ($1, $2, $3)`,
		devID, userID, "phase-11c5-test-device",
	); err != nil {
		t.Fatalf("insert device: %v", err)
	}

	const suite = 1
	clientID := userID.String() + ":" + devID.String()
	rows := make([]store.KeyPackageRow, 0, 10)
	for i := 0; i < 10; i++ {
		rows = append(rows, store.KeyPackageRow{
			Ciphersuite:     suite,
			CredentialType:  1,
			ClientIDClaimed: clientID,
			KeyPackageData:  []byte{byte(i), 0x01, 0x02, 0x03}, // opaque, unique-ish
		})
	}
	if n, err := st.InsertKeyPackages(c, devID, rows); err != nil || n != 10 {
		t.Fatalf("insert kps: n=%d err=%v", n, err)
	}

	n, err := st.CountUnusedKeyPackages(c, devID, suite)
	if err != nil {
		t.Fatalf("count: %v", err)
	}
	if n != 10 {
		t.Fatalf("expected 10 unused, got %d", n)
	}

	// Claim 6 (one per call) for this user, so remaining = 4 (<= 5).
	for i := 0; i < 6; i++ {
		claimed, err := st.ClaimKeyPackagesForUsers(c, []uuid.UUID{userID}, suite)
		if err != nil {
			t.Fatalf("claim %d: %v", i, err)
		}
		if len(claimed) != 1 {
			t.Fatalf("claim %d: expected 1, got %d", i, len(claimed))
		}
		if claimed[0].DeviceID != devID {
			t.Fatalf("claim %d: wrong device %s", i, claimed[0].DeviceID)
		}
	}
	n, err = st.CountUnusedKeyPackages(c, devID, suite)
	if err != nil {
		t.Fatalf("count after claims: %v", err)
	}
	if n != 4 {
		t.Fatalf("expected 4 unused after 6 claims, got %d", n)
	}
	// 4 <= 5: a real server pushes kp_low on the claim that crosses the
	// mark. This asserts the store-level signal maybeNotifyKeyPackageLow
	// reads is correct.
	if n > 5 {
		t.Fatalf("count %d should be at/below the low-water mark (5)", n)
	}
}
