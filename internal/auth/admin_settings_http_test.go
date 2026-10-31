package auth_test

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/scuq/chalk/internal/auth"
	"github.com/scuq/chalk/internal/store"
)

// 129-2: the administrator's run-time switches, end to end against a
// database, plus the no-database shape of the public config endpoint.

type settingsBody struct {
	SeasonalDecorations bool `json:"seasonal_decorations"`
}

func configSeasonal(t *testing.T, baseURL string) bool {
	t.Helper()
	resp, err := http.Get(baseURL + "/api/auth/config")
	if err != nil {
		t.Fatalf("GET /api/auth/config: %v", err)
	}
	defer resp.Body.Close()
	var body settingsBody
	if err := json.NewDecoder(resp.Body).Decode(&body); err != nil {
		t.Fatalf("decode config: %v", err)
	}
	return body.SeasonalDecorations
}

func TestConfigSeasonalDefaultsOnWithoutStore(t *testing.T) {
	t.Setenv("CHALK_OPEN_REGISTRATION", "1")
	deps := &auth.HTTPDeps{
		Service: newTestService(t),
		Cache:   auth.NewCeremonyCache(0),
		Store:   &store.Store{}, // no pool: the loader must answer with the default
	}
	mux := http.NewServeMux()
	if err := deps.MountRegistration(mux); err != nil {
		t.Fatalf("MountRegistration: %v", err)
	}
	srv := httptest.NewServer(mux)
	defer srv.Close()
	if !configSeasonal(t, srv.URL) {
		t.Error("seasonal_decorations must default to true without a stored row")
	}
}

func TestAdminSettingsRoundTrip(t *testing.T) {
	env := setupAdminEnv(t)
	ctx := context.Background()
	clear := func() {
		_, _ = env.pool.Exec(ctx, `DELETE FROM instance_settings WHERE key = 'seasonal_decorations'`)
	}
	clear()
	t.Cleanup(clear)

	// No row: on by default, for the admin endpoint and the public config.
	status, raw := env.doJSON("GET", "/api/admin/settings", env.admin, nil)
	if status != http.StatusOK {
		t.Fatalf("GET settings: status %d body %s", status, raw)
	}
	var got settingsBody
	if err := json.Unmarshal(raw, &got); err != nil {
		t.Fatalf("decode: %v", err)
	}
	if !got.SeasonalDecorations {
		t.Error("absent row must read as true")
	}
	if !configSeasonal(t, env.server.URL) {
		t.Error("config must say true with no row")
	}

	// A regular user may neither read nor write.
	if status, _ := env.doJSON("GET", "/api/admin/settings", env.user, nil); status != http.StatusForbidden {
		t.Errorf("non-admin GET: status %d, want 403", status)
	}
	if status, _ := env.doJSON("PUT", "/api/admin/settings", env.user,
		map[string]any{"seasonal_decorations": false}); status != http.StatusForbidden {
		t.Errorf("non-admin PUT: status %d, want 403", status)
	}
	if !configSeasonal(t, env.server.URL) {
		t.Error("a refused PUT must not change the setting")
	}

	// The admin turns it off: the answer, a re-read and the config agree.
	status, raw = env.doJSON("PUT", "/api/admin/settings", env.admin,
		map[string]any{"seasonal_decorations": false})
	if status != http.StatusOK {
		t.Fatalf("PUT settings: status %d body %s", status, raw)
	}
	if err := json.Unmarshal(raw, &got); err != nil {
		t.Fatalf("decode: %v", err)
	}
	if got.SeasonalDecorations {
		t.Error("PUT false must answer false")
	}
	_, raw = env.doJSON("GET", "/api/admin/settings", env.admin, nil)
	_ = json.Unmarshal(raw, &got)
	if got.SeasonalDecorations {
		t.Error("GET after PUT false must read false")
	}
	if configSeasonal(t, env.server.URL) {
		t.Error("config must say false after the admin turned it off")
	}

	// An empty body changes nothing.
	status, raw = env.doJSON("PUT", "/api/admin/settings", env.admin, map[string]any{})
	if status != http.StatusOK {
		t.Fatalf("PUT empty: status %d body %s", status, raw)
	}
	_ = json.Unmarshal(raw, &got)
	if got.SeasonalDecorations {
		t.Error("an empty PUT must leave false in place")
	}

	// An unknown key is refused, and the stored value stays.
	if status, _ := env.doJSON("PUT", "/api/admin/settings", env.admin,
		map[string]any{"no_such_switch": true}); status != http.StatusBadRequest {
		t.Errorf("unknown key: status %d, want 400", status)
	}

	// And back on.
	status, _ = env.doJSON("PUT", "/api/admin/settings", env.admin,
		map[string]any{"seasonal_decorations": true})
	if status != http.StatusOK {
		t.Fatalf("PUT true: status %d", status)
	}
	if !configSeasonal(t, env.server.URL) {
		t.Error("config must say true after the admin turned it back on")
	}
}
