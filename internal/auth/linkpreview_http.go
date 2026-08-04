package auth

import (
	"encoding/json"
	"errors"
	"fmt"
	"log"
	"net/http"
	"strconv"
	"time"

	"github.com/scuq/chalk/internal/linkpreview"
	"github.com/scuq/chalk/internal/ratelimit"
)

// linkPreviewRateLimit bounds preview fetches per user per minute so an
// authed user can't turn chalkd into a crawling proxy. One pasted link costs
// two fetches (page + thumbnail), so 20 ≈ 10 previews/min.
const (
	linkPreviewRateLimit  = 20
	linkPreviewRateWindow = time.Minute
)

// MountLinkPreview registers the link-preview fetch endpoints (57-1).
//
// The routes are always mounted when called. If the feature is disabled
// (d.LinkPreview == nil) they answer 503; GET /api/auth/config separately
// reports linkpreview_enabled so the SPA never offers previews in that case.
//
// Routes (session required):
//
//	GET /api/linkpreview?url=...        → Preview JSON (OpenGraph metadata)
//	GET /api/linkpreview/image?url=...  → thumbnail bytes
//
// Why the server fetches at all: the SENDER's client calls these for a URL
// it is about to send, embeds the result in the E2E-encrypted body, and
// recipients render without any network fetch. The linked site sees only
// chalkd's IP; chalkd sees the URL and the requesting user, never the
// channel. See docs/phases/PHASE-57-LINKPREVIEW.md.
func (d *HTTPDeps) MountLinkPreview(mux *http.ServeMux) error {
	if d.Store == nil {
		return fmt.Errorf("auth: MountLinkPreview requires Store")
	}
	if d.Logger == nil {
		d.Logger = log.Default()
	}
	if d.linkPreviewLimiter == nil {
		d.linkPreviewLimiter = ratelimit.New(linkPreviewRateLimit, linkPreviewRateWindow)
	}
	mux.HandleFunc("GET /api/linkpreview", RequireSession(d.Store, d.handleLinkPreview))
	mux.HandleFunc("GET /api/linkpreview/image", RequireSession(d.Store, d.handleLinkPreviewImage))
	return nil
}

// linkPreviewGate runs the shared checks (enabled, url param, rate limit)
// and returns the URL to fetch, or "" after writing the error response.
func (d *HTTPDeps) linkPreviewGate(w http.ResponseWriter, r *http.Request, su *SessionUser) string {
	if d.LinkPreview == nil {
		writeError(w, http.StatusServiceUnavailable, "linkpreview_disabled",
			"link previews are not enabled on this server")
		return ""
	}
	u := r.URL.Query().Get("url")
	if u == "" {
		writeError(w, http.StatusBadRequest, "missing_url", "url is required")
		return ""
	}
	if !d.linkPreviewLimiter.Allow(su.UserID.String()) {
		writeError(w, http.StatusTooManyRequests, "rate_limited",
			"too many preview fetches; try again in a minute")
		return ""
	}
	return u
}

func (d *HTTPDeps) handleLinkPreview(w http.ResponseWriter, r *http.Request, su *SessionUser) {
	u := d.linkPreviewGate(w, r, su)
	if u == "" {
		return
	}
	p, err := d.LinkPreview.Fetch(r.Context(), u)
	if err != nil {
		if errors.Is(err, linkpreview.ErrBadURL) {
			writeError(w, http.StatusBadRequest, "invalid_url", "url must be a plain https url")
			return
		}
		// Upstream/network failure: log server-side, return an opaque 502.
		// The log line is the only place the URL appears server-side.
		d.Logger.Printf("linkpreview fetch %q: %v", u, err)
		writeError(w, http.StatusBadGateway, "linkpreview_upstream", "could not fetch a preview")
		return
	}
	w.Header().Set("Content-Type", "application/json")
	_ = json.NewEncoder(w).Encode(p)
}

func (d *HTTPDeps) handleLinkPreviewImage(w http.ResponseWriter, r *http.Request, su *SessionUser) {
	u := d.linkPreviewGate(w, r, su)
	if u == "" {
		return
	}
	data, ct, err := d.LinkPreview.FetchImage(r.Context(), u)
	if err != nil {
		if errors.Is(err, linkpreview.ErrBadURL) {
			writeError(w, http.StatusBadRequest, "invalid_url", "url must be a plain https url")
			return
		}
		d.Logger.Printf("linkpreview image %q: %v", u, err)
		writeError(w, http.StatusBadGateway, "linkpreview_upstream", "could not fetch the image")
		return
	}
	w.Header().Set("Content-Type", ct)
	w.Header().Set("Content-Length", strconv.Itoa(len(data)))
	// The client immediately encrypts these bytes into an attachment; the
	// plaintext image must never land in the HTTP cache.
	w.Header().Set("Cache-Control", "no-store")
	_, _ = w.Write(data)
}
