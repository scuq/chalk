// Package giphy is a minimal server-side client for Giphy's search API
// (att-4). It exists so chalkd can proxy the GIF picker's search: the API
// key stays server-side and Giphy sees only chalkd's IP during SEARCH,
// never the end user.
//
// Scope: this package performs ONLY search. It never fetches GIF bytes --
// the chosen GIF is sent as a URL inside the normal E2E-encrypted message
// body, and each recipient's client decides (per their own opt-in pref,
// behind a host allowlist) whether to render it. The privacy leak inherent
// to URL-reference GIFs is thus confined to the client RENDER fetch, and
// only for users who consented; chalkd's involvement ends at search.
package giphy

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"strconv"
	"strings"
	"time"
)

// defaultBaseURL is Giphy's API origin. Overridable via WithBaseURL for tests.
const defaultBaseURL = "https://api.giphy.com"

// maxQueryLen bounds the search term we forward upstream. Giphy caps this
// itself; we pre-trim to keep the request small and predictable.
const maxQueryLen = 100

// maxBodyBytes bounds the upstream response we read. Giphy search responses
// are small JSON; this is a defensive ceiling, not a tuning knob.
const maxBodyBytes = 4 << 20 // 4 MiB

// ErrEmptyQuery is returned when Search is called with a blank query.
var ErrEmptyQuery = errors.New("giphy: empty query")

// Result is the trimmed, client-facing shape of one GIF. We deliberately
// do NOT forward Giphy's full payload -- only what the picker needs to
// render a tile and, on pick, send the chosen URL. All URLs point at
// Giphy's CDN; the client applies a host allowlist before rendering.
type Result struct {
	ID            string `json:"id"`
	Title         string `json:"title"`
	PreviewURL    string `json:"preview_url"` // small rendition for the picker grid
	PreviewWidth  int    `json:"preview_width"`
	PreviewHeight int    `json:"preview_height"`
	FullURL       string `json:"full_url"` // rendition actually sent in a message
	FullWidth     int    `json:"full_width"`
	FullHeight    int    `json:"full_height"`
}

// Client is a Giphy search-proxy client. Construct with New.
type Client struct {
	apiKey  string
	baseURL string
	limit   int
	rating  string
	hc      *http.Client
}

// Option customizes a Client (used by tests to point at an httptest server).
type Option func(*Client)

// WithBaseURL overrides the Giphy API origin (tests).
func WithBaseURL(u string) Option {
	return func(c *Client) { c.baseURL = strings.TrimRight(u, "/") }
}

// WithHTTPClient overrides the HTTP client (tests / custom transport).
func WithHTTPClient(hc *http.Client) Option {
	return func(c *Client) { c.hc = hc }
}

// New builds a Client. apiKey must be non-empty (callers gate on
// GiphyConfig.Enabled() first). limit/rating come from config; timeout
// sets the HTTP client deadline.
func New(apiKey string, limit int, rating string, timeout time.Duration, opts ...Option) *Client {
	c := &Client{
		apiKey:  apiKey,
		baseURL: defaultBaseURL,
		limit:   limit,
		rating:  rating,
		hc:      &http.Client{Timeout: timeout},
	}
	for _, o := range opts {
		o(c)
	}
	return c
}

// giphyResponse mirrors only the fields we consume from Giphy's search JSON.
// Giphy reports image dimensions as strings (e.g. "200"); see atoiSafe.
type giphyResponse struct {
	Data []struct {
		ID     string `json:"id"`
		Title  string `json:"title"`
		Images struct {
			FixedWidth            rendition `json:"fixed_width"`
			FixedWidthDownsampled rendition `json:"fixed_width_downsampled"`
			Original              rendition `json:"original"`
		} `json:"images"`
	} `json:"data"`
	Meta struct {
		Status int    `json:"status"`
		Msg    string `json:"msg"`
	} `json:"meta"`
}

type rendition struct {
	URL    string `json:"url"`
	Width  string `json:"width"`
	Height string `json:"height"`
}

// Search queries Giphy and returns trimmed results. The query is trimmed
// and length-capped. Network/HTTP/decoding failures are wrapped; a non-2xx
// upstream status surfaces as an error (the handler maps it to 502).
func (c *Client) Search(ctx context.Context, query string) ([]Result, error) {
	q := strings.TrimSpace(query)
	if q == "" {
		return nil, ErrEmptyQuery
	}
	if len(q) > maxQueryLen {
		q = q[:maxQueryLen]
	}

	params := url.Values{}
	params.Set("api_key", c.apiKey)
	params.Set("q", q)
	params.Set("limit", strconv.Itoa(c.limit))
	if c.rating != "" {
		params.Set("rating", c.rating)
	}
	// messaging_non_clips trims Giphy's payload to renditions suited to chat
	// and excludes video "clips" we can't render as a plain <img>.
	params.Set("bundle", "messaging_non_clips")
	endpoint := c.baseURL + "/v1/gifs/search?" + params.Encode()

	req, err := http.NewRequestWithContext(ctx, http.MethodGet, endpoint, nil)
	if err != nil {
		return nil, fmt.Errorf("giphy: build request: %w", err)
	}
	resp, err := c.hc.Do(req)
	if err != nil {
		return nil, fmt.Errorf("giphy: request: %w", err)
	}
	defer resp.Body.Close()

	body, err := io.ReadAll(io.LimitReader(resp.Body, maxBodyBytes))
	if err != nil {
		return nil, fmt.Errorf("giphy: read body: %w", err)
	}
	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		return nil, fmt.Errorf("giphy: upstream status %d", resp.StatusCode)
	}

	var gr giphyResponse
	if err := json.Unmarshal(body, &gr); err != nil {
		return nil, fmt.Errorf("giphy: decode: %w", err)
	}

	out := make([]Result, 0, len(gr.Data))
	for _, d := range gr.Data {
		// Preview prefers the lighter downsampled rendition; full prefers
		// fixed_width and falls back to original. Entries missing the
		// renditions we rely on are skipped rather than sent half-formed.
		preview := d.Images.FixedWidthDownsampled
		if preview.URL == "" {
			preview = d.Images.FixedWidth
		}
		full := d.Images.FixedWidth
		if full.URL == "" {
			full = d.Images.Original
		}
		if preview.URL == "" || full.URL == "" {
			continue
		}
		out = append(out, Result{
			ID:            d.ID,
			Title:         d.Title,
			PreviewURL:    preview.URL,
			PreviewWidth:  atoiSafe(preview.Width),
			PreviewHeight: atoiSafe(preview.Height),
			FullURL:       full.URL,
			FullWidth:     atoiSafe(full.Width),
			FullHeight:    atoiSafe(full.Height),
		})
	}
	return out, nil
}

// atoiSafe parses Giphy's string-typed dimensions, returning 0 on failure.
func atoiSafe(s string) int {
	n, err := strconv.Atoi(strings.TrimSpace(s))
	if err != nil {
		return 0
	}
	return n
}
