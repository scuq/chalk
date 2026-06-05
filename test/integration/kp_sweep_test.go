package integration

// Phase 11c-10: orphaned KeyPackage sweep. Covers the four cases from
// the design doc's build checklist using a dedicated throwaway user.

import (
	"strings"
	"testing"
	"time"

	"github.com/google/uuid"

	"github.com/scuq/chalk/internal/store"
)

func TestPhase11c10_KpSweep(t *testing.T) {
	st, _, _, _ := setupPhase11c1(t)
	c := ctx(t)

	userID := uuid.New()
	// Unique per-run handle (<=32 chars) derived from the random id, so
	// re-runs never collide on handle -- UpsertUser's
	// ON CONFLICT (handle) DO UPDATE SET id would otherwise try to
	// re-point an existing handle's user to a new id while a device
	// still references the old one (devices_user_id_fkey, 23503).
	// uuid hex without dashes (handle/username regex is ^[a-z0-9_]{3,32}$,
	// no hyphens). 12 hex chars + "p11c10_" prefix = 19 chars, under 32.
	handle := "p11c10_" + strings.ReplaceAll(userID.String(), "-", "")[:12]
	if _, err := st.UpsertUser(c, userID, handle); err != nil {
		t.Fatalf("upsert user: %v", err)
	}
	devID := uuid.New()
	if _, err := st.Pool.Exec(c,
		`INSERT INTO devices (id, user_id, device_label)
		 VALUES ($1, $2, $3)`,
		devID, userID, "phase-11c10-test-device",
	); err != nil {
		t.Fatalf("insert device: %v", err)
	}
	const suite = 1
	clientID := userID.String() + ":" + devID.String()

	insN := func(n int) {
		rows := make([]store.KeyPackageRow, 0, n)
		for i := 0; i < n; i++ {
			rows = append(rows, store.KeyPackageRow{
				Ciphersuite:     suite,
				CredentialType:  1,
				ClientIDClaimed: clientID,
				KeyPackageData:  []byte{byte(i), 0xAB, 0xCD},
			})
		}
		if got, err := st.InsertKeyPackages(c, devID, rows); err != nil || got != n {
			t.Fatalf("insert %d kps: got=%d err=%v", n, got, err)
		}
	}
	// Helper: backdate created_at for ALL this device's unused KPs.
	backdateUnused := func(d time.Duration) {
		if _, err := st.Pool.Exec(c,
			`UPDATE key_packages SET created_at = NOW() - make_interval(secs => $2)
			  WHERE device_id = $1 AND used_at IS NULL`,
			devID, d.Seconds(),
		); err != nil {
			t.Fatalf("backdate: %v", err)
		}
	}
	countUnused := func() int {
		n, err := st.CountUnusedKeyPackages(c, devID, suite)
		if err != nil {
			t.Fatalf("count unused: %v", err)
		}
		return n
	}

	keepN := 5
	minAge := time.Hour
	usedRet := 24 * time.Hour

	// Case 1: a fresh batch younger than minAge is NEVER swept, even
	// beyond keepN.
	insN(10) // 10 unused, created NOW
	sup, used, err := st.SweepOrphanedKeyPackages(c, keepN, minAge, usedRet)
	if err != nil {
		t.Fatalf("sweep (fresh): %v", err)
	}
	if sup != 0 || used != 0 {
		t.Fatalf("fresh batch should be untouched, got sup=%d used=%d", sup, used)
	}
	if got := countUnused(); got != 10 {
		t.Fatalf("expected 10 unused after fresh sweep, got %d", got)
	}

	// Case 2: backdate them past minAge; now superseded (rank > keepN)
	// ones are swept, newest keepN preserved.
	backdateUnused(2 * time.Hour) // older than minAge=1h
	sup, used, err = st.SweepOrphanedKeyPackages(c, keepN, minAge, usedRet)
	if err != nil {
		t.Fatalf("sweep (aged): %v", err)
	}
	if sup != 5 { // 10 - keepN(5) = 5 deleted
		t.Fatalf("expected 5 superseded deleted, got %d", sup)
	}
	if used != 0 {
		t.Fatalf("expected 0 consumed deleted, got %d", used)
	}
	if got := countUnused(); got != keepN {
		t.Fatalf("expected %d unused preserved, got %d", keepN, got)
	}

	// Case 3: a device with <= keepN unused KPs is fully preserved even
	// when aged.
	backdateUnused(2 * time.Hour)
	sup, _, err = st.SweepOrphanedKeyPackages(c, keepN, minAge, usedRet)
	if err != nil {
		t.Fatalf("sweep (<=keepN): %v", err)
	}
	if sup != 0 {
		t.Fatalf("device with <=keepN should be preserved, deleted %d", sup)
	}
	if got := countUnused(); got != keepN {
		t.Fatalf("expected %d still preserved, got %d", keepN, got)
	}

	// Case 4: consumed KP older than usedRetention is reclaimed; a
	// recently-consumed one is kept. Claim 2 (marks used_at=NOW), then
	// backdate one of them past retention.
	for i := 0; i < 2; i++ {
		if _, err := st.ClaimKeyPackagesForUsers(c, []uuid.UUID{userID}, suite); err != nil {
			t.Fatalf("claim %d: %v", i, err)
		}
	}
	// Backdate exactly one consumed row past usedRetention.
	if _, err := st.Pool.Exec(c,
		`UPDATE key_packages SET used_at = NOW() - make_interval(secs => $2)
		  WHERE id = (SELECT id FROM key_packages
		               WHERE device_id = $1 AND used_at IS NOT NULL
		               ORDER BY id ASC LIMIT 1)`,
		devID, (48 * time.Hour).Seconds(),
	); err != nil {
		t.Fatalf("backdate consumed: %v", err)
	}
	_, used, err = st.SweepOrphanedKeyPackages(c, keepN, minAge, usedRet)
	if err != nil {
		t.Fatalf("sweep (consumed): %v", err)
	}
	if used != 1 {
		t.Fatalf("expected 1 consumed reclaimed, got %d", used)
	}
}
