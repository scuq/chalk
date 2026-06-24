package auth

import (
	"encoding/json"
	"errors"
	"fmt"
	"log"
	"net/http"
	"strings"

	"github.com/scuq/chalk/internal/giphy"
)

// MountGiphy registers the Giphy search-proxy endpoint (att-4).
//
// The route is always mounted when called. If no API key is configured
// (d.GiphyClient == nil) it answers 503 so a misconfigured client gets a
// clear signal; GET /api/auth/config separately reports giphy_enabled so
// the SPA hides the picker entirely in that case and never calls here.
//
// Route:
//
//	GET /api/giphy/search?q=...   → { "results": [ ... ] }   (session required)
//
// Why proxy at all: the API key is a server-only secret, and proxying means
// Giphy sees only chalkd's IP during SEARCH, never the end user. The render
// fetch (the unavoidable URL-reference leak) happens client-side and only
// for users who opted in.
func (d *HTTPDeps) MountGiphy(mux *http.ServeMux) error {
	if d.Store == nil {
		return fmt.Errorf("auth: MountGiphy requires Store")
	}
	if d.Logger == nil {
		d.Logger = log.Default()
	}
	mux.HandleFunc("GET /api/giphy/search", RequireSession(d.Store, d.handleGiphySearch))
	return nil
}

// giphySearchResponse is the trimmed payload the SPA picker consumes.
type giphySearchResponse struct {
	Results []giphy.Result `json:"results"`
}

// handleGiphySearch proxies a Giphy search. The API key lives only in
// d.GiphyClient; the SPA never sees it. Session-gated like every other
// /api endpoint, so anonymous callers can't burn the server's quota.
func (d *HTTPDeps) handleGiphySearch(w http.ResponseWriter, r *http.Request, _ *SessionUser) {
	if d.GiphyClient == nil {
		writeError(w, http.StatusServiceUnavailable, "giphy_disabled",
			"giphy search is not configured on this server")
		return
	}
	q := strings.TrimSpace(r.URL.Query().Get("q"))
	if q == "" {
		writeError(w, http.StatusBadRequest, "missing_query", "q is required")
		return
	}
	results, err := d.GiphyClient.Search(r.Context(), q)
	if err != nil {
		if errors.Is(err, giphy.ErrEmptyQuery) {
			writeError(w, http.StatusBadRequest, "missing_query", "q is required")
			return
		}
		// Upstream/network failure: log server-side, return an opaque 502 so
		// we don't leak Giphy internals or the key to the client.
		d.Logger.Printf("giphy search %q: %v", q, err)
		writeError(w, http.StatusBadGateway, "giphy_upstream", "giphy search failed")
		return
	}
	w.Header().Set("Content-Type", "application/json")
	_ = json.NewEncoder(w).Encode(giphySearchResponse{Results: results})
}
