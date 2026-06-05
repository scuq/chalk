package integration

// Phase 11c-5: the low-stock detection threshold logic. We test the
// store-level invariant the push relies on -- that CountUnusedKeyPackages
// reflects claims down past the low-water mark -- without standing up a
// full WS server (push delivery is covered by the hub tests).

import (
	"testing"

	"github.com/google/uuid"

	"github.com/scuq/chalk/internal/store"
)

func TestPhase11c5_KpLow_CountReflectsClaims(t *testing.T) {
	st, _, _, _ := setupPhase11c1(t)
	c := ctx(t)

	carolID := uuid.MustParse(phase11c1CarolID)
	if _, err := st.UpsertUser(c, carolID, "phase11c5_carol"); err != nil {
		t.Fatalf("upsert carol: %v", err)
	}
	// Device row (same idiom as mls_commits_test.go).
	devID := uuid.New()
	if _, err := st.Pool.Exec(c,
		`INSERT INTO devices (id, user_id, device_label)
		 VALUES ($1, $2, $3)`,
		devID, carolID, "phase-11c5-test-device",
	); err != nil {
		t.Fatalf("insert device: %v", err)
	}

	const suite = 1
	clientID := carolID.String() + ":" + devID.String()
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

	// Claim 6 (one per call), so remaining = 4 (<= the low-water mark 5).
	for i := 0; i < 6; i++ {
		claimed, err := st.ClaimKeyPackagesForUsers(c, []uuid.UUID{carolID}, suite)
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
