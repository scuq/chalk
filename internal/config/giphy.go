package config

import (
	"fmt"
	"os"
	"strconv"
	"strings"
	"time"
)

// GiphyConfig holds the server-side Giphy search-proxy settings (att-4).
//
// The picker is OFF unless CHALK_GIPHY_API_KEY is set: the key is a
// server-only secret so the SPA never holds it and Giphy sees only
// chalkd's IP during SEARCH (never the end user). All knobs are env-only
// (CHALK_GIPHY_*), mirroring AttachmentConfig: a struct seeded by
// defaultGiphyConfig(), overlaid by applyEnv(), and fenced by Validate().
// The wider Config embeds this as Config.Giphy and forwards the three
// lifecycle calls (default/env/validate) to it.
//
// What each knob bounds:
//
//	APIKey          Giphy API key. Empty => feature disabled (Enabled()==false).
//	                The search route is still mounted but answers 503, and
//	                /api/auth/config reports giphy_enabled=false so the SPA
//	                hides the picker. CHALK_GIPHY_API_KEY.
//	SearchLimit     how many results one search returns (Giphy 'limit').
//	                Bounded 1..50 by Validate. CHALK_GIPHY_SEARCH_LIMIT.
//	Rating          Giphy content-rating cap (g, pg, pg-13, r), lower-cased.
//	                CHALK_GIPHY_RATING.
//	TimeoutSeconds  upstream HTTP timeout for one search call (1..60).
//	                CHALK_GIPHY_TIMEOUT_SECONDS.
type GiphyConfig struct {
	APIKey         string
	SearchLimit    int
	Rating         string
	TimeoutSeconds int
}

// Giphy knob defaults. Named so the value appears once and is referenced
// by both Default and the doc comments above.
const (
	defaultGiphySearchLimit    = 24
	defaultGiphyRating         = "pg-13"
	defaultGiphyTimeoutSeconds = 8
)

// validGiphyRatings is the set Giphy accepts for the 'rating' filter.
var validGiphyRatings = map[string]bool{
	"g": true, "pg": true, "pg-13": true, "r": true,
}

func defaultGiphyConfig() GiphyConfig {
	return GiphyConfig{
		APIKey:         "",
		SearchLimit:    defaultGiphySearchLimit,
		Rating:         defaultGiphyRating,
		TimeoutSeconds: defaultGiphyTimeoutSeconds,
	}
}

// Enabled reports whether the Giphy picker is available (API key present).
// Callers gate both the search proxy and the giphy_enabled config flag on
// this.
func (g GiphyConfig) Enabled() bool {
	return strings.TrimSpace(g.APIKey) != ""
}

// Timeout is the upstream search timeout as a duration.
func (g GiphyConfig) Timeout() time.Duration {
	return time.Duration(g.TimeoutSeconds) * time.Second
}

// applyEnv overlays CHALK_GIPHY_* env vars onto g. Unset/unparseable vars
// leave the existing (default) value untouched, the same contract as
// AttachmentConfig.applyEnv.
func (g *GiphyConfig) applyEnv() {
	if v := strings.TrimSpace(os.Getenv("CHALK_GIPHY_API_KEY")); v != "" {
		g.APIKey = v
	}
	if v := strings.TrimSpace(os.Getenv("CHALK_GIPHY_RATING")); v != "" {
		g.Rating = strings.ToLower(v)
	}
	if n, ok := giphyEnvInt("CHALK_GIPHY_SEARCH_LIMIT"); ok {
		g.SearchLimit = n
	}
	if n, ok := giphyEnvInt("CHALK_GIPHY_TIMEOUT_SECONDS"); ok {
		g.TimeoutSeconds = n
	}
}

// Validate fails loudly on nonsensical knobs. NOTE: an empty APIKey is
// NOT an error -- it simply disables the feature. The other knobs are
// validated unconditionally so a typo'd CHALK_GIPHY_* is caught even
// before a key is added.
func (g GiphyConfig) Validate() error {
	if g.SearchLimit < 1 || g.SearchLimit > 50 {
		return fmt.Errorf("CHALK_GIPHY_SEARCH_LIMIT must be in 1..50 (got %d)", g.SearchLimit)
	}
	if !validGiphyRatings[g.Rating] {
		return fmt.Errorf("CHALK_GIPHY_RATING must be one of g, pg, pg-13, r (got %q)", g.Rating)
	}
	if g.TimeoutSeconds < 1 || g.TimeoutSeconds > 60 {
		return fmt.Errorf("CHALK_GIPHY_TIMEOUT_SECONDS must be in 1..60 (got %d)", g.TimeoutSeconds)
	}
	return nil
}

// giphyEnvInt mirrors config.envInt but is kept local so GiphyConfig is a
// self-contained unit (its own file added by att-4, with no edits to the
// envInt definition in config.go), matching attachEnvInt in attachments.go.
func giphyEnvInt(key string) (int, bool) {
	v := strings.TrimSpace(os.Getenv(key))
	if v == "" {
		return 0, false
	}
	n, err := strconv.Atoi(v)
	if err != nil {
		return 0, false
	}
	return n, true
}
