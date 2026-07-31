// Package linkpreview is chalkd's server-side page fetcher for sender-built
// link previews (phase 57, docs/PHASE-57-LINKPREVIEW.md).
//
// Privacy model: the SENDER's client asks chalkd to fetch a page they are
// about to link, chalkd returns OpenGraph metadata (and, separately, the
// thumbnail bytes), and the client embeds the preview inside the normal
// E2E-encrypted body. Recipients render from ciphertext and never fetch
// anything. chalkd learns the URL and the requesting user -- the same trust
// carve-out as Giphy search -- and never the channel or recipients.
//
// Security model: users can whitelist arbitrary domains client-side, so this
// fetcher must survive arbitrary URLs. The SSRF boundary is IP vetting at
// DIAL time (net.Dialer.Control): the vetted address is the exact one being
// connected to, which covers DNS rebinding, and every redirect hop re-dials
// through the same guard. Plus: https only, bounded redirects, bounded
// response sizes, content-type enforcement, no cookies, a generic UA.
package linkpreview

import (
	"context"
	"errors"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/netip"
	"net/url"
	"strings"
	"syscall"
	"time"
)

const (
	maxRedirects = 3
	// 2 MiB: og tags live in <head>, but YouTube watch pages put them around
	// byte 686k of a ~1.2 MB document -- a 1 MiB cap sat one fat head away
	// from silently truncating every og tag and landing in the wrong-fallback
	// path.
	maxHTMLBytes   = 2 << 20
	maxImageBytes  = 5 << 20
	maxOEmbedBytes = 64 << 10
	userAgent      = "chalkd-linkpreview/1.0"

	// Rune caps applied to extracted fields; a preview is a summary, not a
	// mirror. The client re-caps on receive (payloads are sender-asserted).
	maxTitleRunes = 300
	maxDescRunes  = 500
	maxSiteRunes  = 100
)

// ErrBadURL marks a request the client formed wrong (not https, no host,
// userinfo present, unparseable). Handlers map it to 400; everything else
// from Fetch/FetchImage is an upstream problem and maps to 502.
var ErrBadURL = errors.New("linkpreview: invalid url")

// errDisallowedAddr is returned by the dial guard for non-public addresses.
// It surfaces wrapped inside url.Error like any dial failure.
var errDisallowedAddr = errors.New("linkpreview: address not allowed")

// Preview is the metadata handed back to the sender's client. All fields may
// be empty (the composer then offers nothing). ImageURL is absolute https or
// empty; the client fetches it through FetchImage's endpoint, encrypts the
// bytes, and ships them as a normal attachment.
type Preview struct {
	URL         string `json:"url"` // final URL after redirects
	Title       string `json:"title"`
	Description string `json:"description"`
	SiteName    string `json:"site_name"`
	ImageURL    string `json:"image_url"`
}

// Client fetches pages and thumbnails with the guards above. Construct with
// New.
type Client struct {
	hc           *http.Client
	oembedBase   string // YouTube oEmbed endpoint; overridden in tests
	allowPrivate bool   // tests only: httptest servers are loopback
}

// Option customizes a Client.
type Option func(*Client)

// WithAllowPrivateAddrs disables the dial-time address guard. TESTS ONLY --
// httptest servers listen on loopback, which production must reject.
func WithAllowPrivateAddrs() Option {
	return func(c *Client) { c.allowPrivate = true }
}

// WithHTTPClient replaces the guarded HTTP client wholesale (tests). The
// dial guard, redirect policy, and timeout all live in the default client,
// so production callers must never use this.
func WithHTTPClient(hc *http.Client) Option {
	return func(c *Client) { c.hc = hc }
}

// New builds a Client with the given per-fetch timeout.
func New(timeout time.Duration, opts ...Option) *Client {
	c := &Client{oembedBase: youtubeOEmbedBase}
	for _, o := range opts {
		o(c)
	}
	if c.hc != nil {
		return c
	}
	dialer := &net.Dialer{
		Timeout: timeout,
		Control: func(network, address string, _ syscall.RawConn) error {
			if c.allowPrivate {
				return nil
			}
			return vetDialAddr(address)
		},
	}
	c.hc = &http.Client{
		Timeout: timeout,
		Transport: &http.Transport{
			DialContext:       dialer.DialContext,
			DisableKeepAlives: true, // one-shot fetches; hold no sockets to strangers
		},
		CheckRedirect: func(req *http.Request, via []*http.Request) error {
			if len(via) >= maxRedirects {
				return fmt.Errorf("linkpreview: more than %d redirects", maxRedirects)
			}
			if req.URL.Scheme != "https" {
				return fmt.Errorf("linkpreview: redirect to non-https url")
			}
			return nil
		},
	}
	return c
}

// Fetch retrieves rawURL and extracts its OpenGraph metadata. YouTube video
// URLs bypass the HTML path entirely and go through oEmbed (see oembed.go).
func (c *Client) Fetch(ctx context.Context, rawURL string) (*Preview, error) {
	u, err := parsePreviewURL(rawURL)
	if err != nil {
		return nil, err
	}
	if isYouTubeVideoURL(u) {
		return c.fetchYouTubeOEmbed(ctx, u)
	}
	resp, err := c.get(ctx, rawURL, "text/html")
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()

	ct := resp.Header.Get("Content-Type")
	if !strings.HasPrefix(strings.ToLower(ct), "text/html") {
		return nil, fmt.Errorf("linkpreview: not an html page (%s)", ct)
	}
	body, err := io.ReadAll(io.LimitReader(resp.Body, maxHTMLBytes))
	if err != nil {
		return nil, fmt.Errorf("linkpreview: read body: %w", err)
	}

	m := extractMeta(body)
	final := resp.Request.URL
	p := &Preview{
		URL:         final.String(),
		Title:       capRunes(firstNonEmpty(m.ogTitle, m.title), maxTitleRunes),
		Description: capRunes(firstNonEmpty(m.ogDesc, m.metaDesc), maxDescRunes),
		SiteName:    capRunes(m.ogSite, maxSiteRunes),
		ImageURL:    resolveImageURL(final, m.ogImage),
	}
	return p, nil
}

// FetchImage retrieves a thumbnail (typically the og:image from Fetch).
// Returns the raw bytes and their content type; the caller re-serves them to
// the sender's client, which encrypts them into an attachment.
func (c *Client) FetchImage(ctx context.Context, rawURL string) ([]byte, string, error) {
	resp, err := c.get(ctx, rawURL, "image/*")
	if err != nil {
		return nil, "", err
	}
	defer resp.Body.Close()

	ct := strings.ToLower(strings.TrimSpace(strings.SplitN(resp.Header.Get("Content-Type"), ";", 2)[0]))
	// svg excluded: it is markup, not pixels, and can embed scripts.
	if !strings.HasPrefix(ct, "image/") || ct == "image/svg+xml" {
		return nil, "", fmt.Errorf("linkpreview: not an image (%s)", ct)
	}
	body, err := io.ReadAll(io.LimitReader(resp.Body, maxImageBytes+1))
	if err != nil {
		return nil, "", fmt.Errorf("linkpreview: read image: %w", err)
	}
	if len(body) > maxImageBytes {
		return nil, "", fmt.Errorf("linkpreview: image exceeds %d bytes", maxImageBytes)
	}
	return body, ct, nil
}

// parsePreviewURL is the single https-only/no-userinfo URL gate shared by
// Fetch and get.
func parsePreviewURL(rawURL string) (*url.URL, error) {
	u, err := url.Parse(strings.TrimSpace(rawURL))
	if err != nil || u.Scheme != "https" || u.Host == "" || u.User != nil {
		return nil, ErrBadURL
	}
	return u, nil
}

// get validates rawURL and performs the guarded GET.
func (c *Client) get(ctx context.Context, rawURL, accept string) (*http.Response, error) {
	u, err := parsePreviewURL(rawURL)
	if err != nil {
		return nil, err
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, u.String(), nil)
	if err != nil {
		return nil, ErrBadURL
	}
	req.Header.Set("User-Agent", userAgent)
	req.Header.Set("Accept", accept)
	// Without this, upstreams localize by the server's IP geolocation and the
	// server's location leaks into E2E-embedded preview text.
	req.Header.Set("Accept-Language", "en")
	resp, err := c.hc.Do(req)
	if err != nil {
		return nil, fmt.Errorf("linkpreview: fetch failed: %w", err)
	}
	if resp.StatusCode < 200 || resp.StatusCode > 299 {
		resp.Body.Close()
		return nil, fmt.Errorf("linkpreview: upstream status %d", resp.StatusCode)
	}
	return resp, nil
}

// resolveImageURL makes an og:image absolute against the final page URL and
// drops anything that doesn't end up a plain https URL.
func resolveImageURL(page *url.URL, img string) string {
	img = strings.TrimSpace(img)
	if img == "" {
		return ""
	}
	u, err := page.Parse(img)
	if err != nil || u.Scheme != "https" || u.Host == "" || u.User != nil {
		return ""
	}
	return u.String()
}

func firstNonEmpty(a, b string) string {
	if strings.TrimSpace(a) != "" {
		return strings.TrimSpace(a)
	}
	return strings.TrimSpace(b)
}

func capRunes(s string, n int) string {
	r := []rune(s)
	if len(r) <= n {
		return s
	}
	return string(r[:n])
}

// ---- dial-time address guard (the SSRF boundary) -----------------------

// deniedV4 are special-purpose IPv4 ranges beyond what the netip.Addr
// Is* predicates already cover.
var deniedV4 = []netip.Prefix{
	netip.MustParsePrefix("100.64.0.0/10"),   // CGNAT
	netip.MustParsePrefix("192.0.0.0/24"),    // IETF protocol assignments
	netip.MustParsePrefix("192.0.2.0/24"),    // TEST-NET-1
	netip.MustParsePrefix("198.18.0.0/15"),   // benchmarking
	netip.MustParsePrefix("198.51.100.0/24"), // TEST-NET-2
	netip.MustParsePrefix("203.0.113.0/24"),  // TEST-NET-3
	netip.MustParsePrefix("240.0.0.0/4"),     // reserved + broadcast
}

var deniedV6 = []netip.Prefix{
	netip.MustParsePrefix("2001:db8::/32"), // documentation
	netip.MustParsePrefix("64:ff9b::/96"),  // NAT64: can embed a private v4
}

// vetDialAddr rejects any dial target that is not a public unicast address.
// address is the transport's "ip:port" -- post-DNS, so a hostname that
// resolves (or re-resolves) to something internal is caught here. Fail
// closed: anything unparseable is rejected.
func vetDialAddr(address string) error {
	ap, err := netip.ParseAddrPort(address)
	if err != nil {
		return errDisallowedAddr
	}
	if !isPublicAddr(ap.Addr()) {
		return fmt.Errorf("%w: %s", errDisallowedAddr, ap.Addr())
	}
	return nil
}

// isPublicAddr reports whether a is a globally routable unicast address.
func isPublicAddr(a netip.Addr) bool {
	a = a.Unmap()
	if !a.IsValid() ||
		a.IsLoopback() ||
		a.IsPrivate() || // RFC1918 + ULA fc00::/7
		a.IsLinkLocalUnicast() ||
		a.IsLinkLocalMulticast() ||
		a.IsInterfaceLocalMulticast() ||
		a.IsMulticast() ||
		a.IsUnspecified() {
		return false
	}
	denied := deniedV4
	if a.Is6() {
		denied = deniedV6
	}
	for _, p := range denied {
		if p.Contains(a) {
			return false
		}
	}
	return true
}
