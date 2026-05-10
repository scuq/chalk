package integration

import (
	"testing"

	chalk "github.com/scuq/chalk"
	"github.com/scuq/chalk/internal/migrate"
)

func TestMigrationsLoadAndOrder(t *testing.T) {
	migs, err := migrate.Load(chalk.Migrations, chalk.MigrationsDir)
	if err != nil {
		t.Fatalf("Load: %v", err)
	}
	if len(migs) == 0 {
		t.Fatal("no migrations found")
	}
	// Must be sorted by version.
	for i := 1; i < len(migs); i++ {
		if migs[i].Version <= migs[i-1].Version {
			t.Errorf("migrations out of order: %s before %s", migs[i-1].Version, migs[i].Version)
		}
	}
	// First migration must be 0001.
	if migs[0].Version != "0001" {
		t.Errorf("first migration version = %q, want 0001", migs[0].Version)
	}
}

func TestMigrationsAlreadyAppliedAreSkipped(t *testing.T) {
	st := openStore(t)
	c := ctx(t)
	migs, err := migrate.Load(chalk.Migrations, chalk.MigrationsDir)
	if err != nil {
		t.Fatalf("Load: %v", err)
	}

	// Second invocation -- the bootstrap already ran them once before
	// the test process started -- should report all skipped.
	results, err := migrate.Run(c, st.Pool, migs, nil)
	if err != nil {
		t.Fatalf("Run: %v", err)
	}
	if len(results) != len(migs) {
		t.Fatalf("expected %d results, got %d", len(migs), len(results))
	}
	for _, r := range results {
		if !r.Skipped {
			t.Errorf("migration %s was re-applied (not skipped) -- runner is not idempotent",
				r.Migration.FullName())
		}
	}
}

func TestSchemaMigrationsTableExists(t *testing.T) {
	st := openStore(t)
	c := ctx(t)
	var n int
	err := st.Pool.QueryRow(c, `SELECT count(*) FROM schema_migrations`).Scan(&n)
	if err != nil {
		t.Fatalf("query schema_migrations: %v", err)
	}
	if n < 1 {
		t.Fatalf("expected schema_migrations to have rows, got %d", n)
	}
}
