package config

import (
	"fmt"
	"os"
	"strconv"
	"strings"
	"time"
)

// LinkPreviewConfig holds the server-side link-preview fetcher settings
// (phase 57, docs/phases/PHASE-57-LINKPREVIEW.md).
//
// The fetcher lets the SENDER's client ask chalkd for a page's OpenGraph
// metadata; the resulting preview travels inside the E2E-encrypted body, so
// recipients never fetch anything. All knobs are env-only (CHALK_LINKPREVIEW_*),
// mirroring GiphyConfig: a struct seeded by defaultLinkPreviewConfig(),
// overlaid by applyEnv(), and fenced by Validate(). Config embeds this as
// Config.LinkPreview and forwards the three lifecycle calls.
//
// What each knob does:
//
//	Enabled         master switch. false => routes answer 503 and
//	                /api/auth/config reports linkpreview_enabled=false so the
//	                SPA hides the feature. CHALK_LINKPREVIEW_ENABLED.
//	Domains         the default whitelist served to clients as the set of
//	                hosts a pasted link auto-offers a preview for (an entry
//	                matches itself and subdomains). This is a consent/UX
//	                control, NOT the SSRF boundary -- users may extend it
//	                client-side, so the fetcher hardens against arbitrary
//	                URLs regardless. CHALK_LINKPREVIEW_DOMAINS
//	                (comma-separated, replaces the default list).
//	TimeoutSeconds  upstream HTTP timeout for one fetch (1..60).
//	                CHALK_LINKPREVIEW_TIMEOUT_SECONDS.
type LinkPreviewConfig struct {
	Enabled        bool
	Domains        []string
	TimeoutSeconds int
}

// defaultLinkPreviewDomains is the whitelist chalk ships: YouTube, Steam,
// Twitch and the Amazon storefronts people here actually paste. An entry
// matches itself and subdomains on the client, so bare domains cover www.
var defaultLinkPreviewDomains = []string{
	"youtube.com",
	"www.youtube.com",
	"m.youtube.com",
	"youtu.be",
	"store.steampowered.com",
	"steamcommunity.com",
	"twitch.tv",
	"amazon.at",
	"amazon.de",
	"amazon.com",
}

const defaultLinkPreviewTimeoutSeconds = 8

func defaultLinkPreviewConfig() LinkPreviewConfig {
	return LinkPreviewConfig{
		Enabled:        true,
		Domains:        append([]string(nil), defaultLinkPreviewDomains...),
		TimeoutSeconds: defaultLinkPreviewTimeoutSeconds,
	}
}

// Timeout is the upstream fetch timeout as a duration.
func (l LinkPreviewConfig) Timeout() time.Duration {
	return time.Duration(l.TimeoutSeconds) * time.Second
}

// applyEnv overlays CHALK_LINKPREVIEW_* env vars onto l. Unset/unparseable
// vars leave the existing (default) value untouched, the same contract as
// GiphyConfig.applyEnv.
func (l *LinkPreviewConfig) applyEnv() {
	if v := strings.TrimSpace(os.Getenv("CHALK_LINKPREVIEW_ENABLED")); v != "" {
		if b, err := strconv.ParseBool(v); err == nil {
			l.Enabled = b
		}
	}
	if v := strings.TrimSpace(os.Getenv("CHALK_LINKPREVIEW_DOMAINS")); v != "" {
		var domains []string
		for _, d := range strings.Split(v, ",") {
			d = strings.ToLower(strings.TrimSpace(d))
			if d != "" {
				domains = append(domains, d)
			}
		}
		if len(domains) > 0 {
			l.Domains = domains
		}
	}
	if v := strings.TrimSpace(os.Getenv("CHALK_LINKPREVIEW_TIMEOUT_SECONDS")); v != "" {
		if n, err := strconv.Atoi(v); err == nil {
			l.TimeoutSeconds = n
		}
	}
}

// Validate fails loudly on nonsensical knobs. Domains are checked for
// host-shape (no scheme, path, port, or spaces) so a pasted URL instead of a
// hostname is caught at boot, not silently never matched.
func (l LinkPreviewConfig) Validate() error {
	if l.TimeoutSeconds < 1 || l.TimeoutSeconds > 60 {
		return fmt.Errorf("CHALK_LINKPREVIEW_TIMEOUT_SECONDS must be in 1..60 (got %d)", l.TimeoutSeconds)
	}
	for _, d := range l.Domains {
		if d == "" || strings.ContainsAny(d, " /:@?#") {
			return fmt.Errorf("CHALK_LINKPREVIEW_DOMAINS entry %q is not a bare hostname", d)
		}
	}
	return nil
}
