package linkpreview

import (
	"context"
	"errors"
	"fmt"
	"net/http"
	"net/http/httptest"
	"net/netip"
	"strings"
	"testing"
	"time"
)

// newTLSServer returns an httptest TLS server plus a Client whose transport
// trusts it and (necessarily) allows loopback dials.
func newTLSServer(t *testing.T, handler http.Handler) (*httptest.Server, *Client) {
	t.Helper()
	srv := httptest.NewTLSServer(handler)
	t.Cleanup(srv.Close)
	c := New(5*time.Second, WithAllowPrivateAddrs())
	// Trust the test server's cert while keeping our transport's dial guard
	// and redirect policy.
	tr := c.hc.Transport.(*http.Transport)
	tr.TLSClientConfig = srv.Client().Transport.(*http.Transport).TLSClientConfig
	return srv, c
}

func TestFetchHappyPath(t *testing.T) {
	var gotUA string
	srv, c := newTLSServer(t, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		gotUA = r.Header.Get("User-Agent")
		w.Header().Set("Content-Type", "text/html; charset=utf-8")
		fmt.Fprint(w, `<head>
			<meta property="og:title" content="A Video">
			<meta property="og:description" content="About things">
			<meta property="og:site_name" content="YouTube">
			<meta property="og:image" content="/thumb.jpg">
		</head><body></body>`)
	}))

	p, err := c.Fetch(context.Background(), srv.URL+"/watch?v=x")
	if err != nil {
		t.Fatal(err)
	}
	if p.Title != "A Video" || p.Description != "About things" || p.SiteName != "YouTube" {
		t.Fatalf("preview = %+v", p)
	}
	if p.ImageURL != srv.URL+"/thumb.jpg" {
		t.Fatalf("ImageURL = %q (relative og:image must resolve against the page)", p.ImageURL)
	}
	if gotUA != userAgent {
		t.Fatalf("User-Agent = %q", gotUA)
	}
}

func TestFetchRejectsBadURLs(t *testing.T) {
	c := New(time.Second, WithAllowPrivateAddrs())
	for _, u := range []string{
		"http://example.com/",         // not https
		"ftp://example.com/",          //
		"https://user:pw@example.com", // userinfo
		"https://",                    // no host
		"not a url at all",
		"",
	} {
		_, err := c.Fetch(context.Background(), u)
		if !errors.Is(err, ErrBadURL) {
			t.Fatalf("Fetch(%q) err = %v, want ErrBadURL", u, err)
		}
	}
}

func TestFetchRejectsNonHTML(t *testing.T) {
	srv, c := newTLSServer(t, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		fmt.Fprint(w, `{}`)
	}))
	if _, err := c.Fetch(context.Background(), srv.URL); err == nil {
		t.Fatal("want error for non-html content type")
	}
}

func TestFetchRedirectLimitAndScheme(t *testing.T) {
	var srv *httptest.Server
	mux := http.NewServeMux()
	mux.HandleFunc("/hop/", func(w http.ResponseWriter, r *http.Request) {
		n := strings.TrimPrefix(r.URL.Path, "/hop/")
		http.Redirect(w, r, srv.URL+"/hop/"+n+"x", http.StatusFound)
	})
	mux.HandleFunc("/downgrade", func(w http.ResponseWriter, r *http.Request) {
		http.Redirect(w, r, "http://example.com/", http.StatusFound)
	})
	mux.HandleFunc("/once", func(w http.ResponseWriter, r *http.Request) {
		http.Redirect(w, r, srv.URL+"/final", http.StatusFound)
	})
	mux.HandleFunc("/final", func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "text/html")
		fmt.Fprint(w, `<head><meta property="og:title" content="landed"></head>`)
	})
	srv, c := newTLSServer(t, mux)

	p, err := c.Fetch(context.Background(), srv.URL+"/once")
	if err != nil || p.Title != "landed" {
		t.Fatalf("one redirect should be fine: %v, %+v", err, p)
	}
	if p.URL != srv.URL+"/final" {
		t.Fatalf("URL = %q, want final url", p.URL)
	}
	if _, err := c.Fetch(context.Background(), srv.URL+"/hop/1"); err == nil {
		t.Fatal("want error after redirect limit")
	}
	if _, err := c.Fetch(context.Background(), srv.URL+"/downgrade"); err == nil {
		t.Fatal("want error on redirect to http")
	}
}

func TestFetchImage(t *testing.T) {
	big := strings.Repeat("x", maxImageBytes+1)
	mux := http.NewServeMux()
	mux.HandleFunc("/ok.png", func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "image/png")
		fmt.Fprint(w, "PNGBYTES")
	})
	mux.HandleFunc("/big.png", func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "image/png")
		fmt.Fprint(w, big)
	})
	mux.HandleFunc("/evil.svg", func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "image/svg+xml")
		fmt.Fprint(w, "<svg/>")
	})
	mux.HandleFunc("/page", func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "text/html")
	})
	srv, c := newTLSServer(t, mux)

	data, ct, err := c.FetchImage(context.Background(), srv.URL+"/ok.png")
	if err != nil || string(data) != "PNGBYTES" || ct != "image/png" {
		t.Fatalf("FetchImage = %q %q %v", data, ct, err)
	}
	if _, _, err := c.FetchImage(context.Background(), srv.URL+"/big.png"); err == nil {
		t.Fatal("want error for oversized image")
	}
	if _, _, err := c.FetchImage(context.Background(), srv.URL+"/evil.svg"); err == nil {
		t.Fatal("want error for svg")
	}
	if _, _, err := c.FetchImage(context.Background(), srv.URL+"/page"); err == nil {
		t.Fatal("want error for non-image content type")
	}
}

func TestDialGuardBlocksLoopback(t *testing.T) {
	srv := httptest.NewTLSServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {}))
	defer srv.Close()
	c := New(time.Second) // no WithAllowPrivateAddrs: production config
	_, err := c.Fetch(context.Background(), srv.URL)
	if err == nil || !strings.Contains(err.Error(), "address not allowed") {
		t.Fatalf("want dial-guard rejection for loopback, got %v", err)
	}
}

func TestIsPublicAddr(t *testing.T) {
	deny := []string{
		"127.0.0.1", "10.1.2.3", "172.16.0.1", "192.168.1.1",
		"169.254.169.254", // cloud metadata
		"100.64.0.1",      // CGNAT
		"0.0.0.0", "255.255.255.255", "240.0.0.1",
		"192.0.2.1", "198.51.100.1", "203.0.113.1", "198.18.0.1", "192.0.0.1",
		"::1", "fe80::1", "fc00::1", "fd12::1", "ff02::1",
		"2001:db8::1", "64:ff9b::a00:1", "::",
		"::ffff:10.0.0.1", // v4-mapped private
	}
	for _, s := range deny {
		if isPublicAddr(netip.MustParseAddr(s)) {
			t.Errorf("isPublicAddr(%s) = true, want false", s)
		}
	}
	allow := []string{"93.184.216.34", "142.250.74.78", "2607:f8b0:4004:800::200e", "::ffff:93.184.216.34"}
	for _, s := range allow {
		if !isPublicAddr(netip.MustParseAddr(s)) {
			t.Errorf("isPublicAddr(%s) = false, want true", s)
		}
	}
}

func TestVetDialAddr(t *testing.T) {
	if err := vetDialAddr("10.0.0.1:443"); err == nil {
		t.Fatal("want rejection for private addr")
	}
	if err := vetDialAddr("bogus"); err == nil {
		t.Fatal("want rejection for unparseable addr (fail closed)")
	}
	if err := vetDialAddr("93.184.216.34:443"); err != nil {
		t.Fatalf("public addr rejected: %v", err)
	}
}

func TestRateLimiter(t *testing.T) {
	r := NewRateLimiter(3, time.Minute)
	now := time.Unix(1000, 0)
	r.now = func() time.Time { return now }

	for i := 0; i < 3; i++ {
		if !r.Allow("alice") {
			t.Fatalf("attempt %d should be allowed", i+1)
		}
	}
	if r.Allow("alice") {
		t.Fatal("4th attempt within window must be denied")
	}
	if !r.Allow("bob") {
		t.Fatal("keys are independent")
	}
	now = now.Add(61 * time.Second)
	if !r.Allow("alice") {
		t.Fatal("window expiry must restore the allowance")
	}
}
