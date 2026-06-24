package config

import (
	"testing"
	"time"
)

func TestGiphyConfig_Defaults(t *testing.T) {
	g := defaultGiphyConfig()
	if g.APIKey != "" {
		t.Errorf("default APIKey = %q, want empty", g.APIKey)
	}
	if g.Enabled() {
		t.Error("default config must be disabled (no key)")
	}
	if g.SearchLimit != defaultGiphySearchLimit {
		t.Errorf("SearchLimit = %d", g.SearchLimit)
	}
	if g.Rating != defaultGiphyRating {
		t.Errorf("Rating = %q", g.Rating)
	}
	if g.Timeout() != time.Duration(defaultGiphyTimeoutSeconds)*time.Second {
		t.Errorf("Timeout = %v", g.Timeout())
	}
}

func TestGiphyConfig_Enabled(t *testing.T) {
	if (GiphyConfig{APIKey: ""}).Enabled() {
		t.Error("empty key => disabled")
	}
	if (GiphyConfig{APIKey: "   "}).Enabled() {
		t.Error("whitespace key => disabled")
	}
	if !(GiphyConfig{APIKey: "abc"}).Enabled() {
		t.Error("set key => enabled")
	}
}

func TestGiphyConfig_ApplyEnv(t *testing.T) {
	t.Setenv("CHALK_GIPHY_API_KEY", "live-key")
	t.Setenv("CHALK_GIPHY_RATING", "PG") // upper -> lower-cased
	t.Setenv("CHALK_GIPHY_SEARCH_LIMIT", "10")
	t.Setenv("CHALK_GIPHY_TIMEOUT_SECONDS", "3")

	g := defaultGiphyConfig()
	g.applyEnv()

	if g.APIKey != "live-key" {
		t.Errorf("APIKey = %q", g.APIKey)
	}
	if !g.Enabled() {
		t.Error("key set => enabled")
	}
	if g.Rating != "pg" {
		t.Errorf("Rating = %q, want lower-cased 'pg'", g.Rating)
	}
	if g.SearchLimit != 10 {
		t.Errorf("SearchLimit = %d", g.SearchLimit)
	}
	if g.TimeoutSeconds != 3 {
		t.Errorf("TimeoutSeconds = %d", g.TimeoutSeconds)
	}
}

func TestGiphyConfig_ApplyEnv_UnsetLeavesDefaults(t *testing.T) {
	// No CHALK_GIPHY_* set: applyEnv must be a no-op over defaults.
	g := defaultGiphyConfig()
	g.applyEnv()
	if g.SearchLimit != defaultGiphySearchLimit || g.Rating != defaultGiphyRating {
		t.Errorf("unset env mutated defaults: %+v", g)
	}
}

func TestGiphyConfig_Validate(t *testing.T) {
	ok := defaultGiphyConfig()
	if err := ok.Validate(); err != nil {
		t.Errorf("default config should validate: %v", err)
	}
	// Empty key is valid (feature simply disabled).
	if err := (GiphyConfig{SearchLimit: 24, Rating: "pg-13", TimeoutSeconds: 8}).Validate(); err != nil {
		t.Errorf("empty key should validate: %v", err)
	}

	bad := []GiphyConfig{
		{SearchLimit: 0, Rating: "pg-13", TimeoutSeconds: 8},
		{SearchLimit: 51, Rating: "pg-13", TimeoutSeconds: 8},
		{SearchLimit: 24, Rating: "nc-17", TimeoutSeconds: 8},
		{SearchLimit: 24, Rating: "pg-13", TimeoutSeconds: 0},
		{SearchLimit: 24, Rating: "pg-13", TimeoutSeconds: 61},
	}
	for i, g := range bad {
		if err := g.Validate(); err == nil {
			t.Errorf("bad[%d] %+v should fail validation", i, g)
		}
	}
}
