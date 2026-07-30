package server

import (
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"testing/fstest"
)

// fakeWebFS builds an embed-like fs.FS with the dist/ subtree the
// SPA handler expects.
func fakeWebFS(files map[string]string) fstest.MapFS {
	out := fstest.MapFS{}
	for k, v := range files {
		out[k] = &fstest.MapFile{Data: []byte(v)}
	}
	return out
}

func newSPATestServer(t *testing.T, files map[string]string) *httptest.Server {
	t.Helper()
	h, err := spaHandler(fakeWebFS(files), "dist")
	if err != nil {
		t.Fatalf("spaHandler: %v", err)
	}
	return httptest.NewServer(h)
}

func TestSPA_RootServesIndex(t *testing.T) {
	srv := newSPATestServer(t, map[string]string{
		"dist/index.html": "<html>chalk</html>",
		"dist/index.js":   "console.log('hi')",
	})
	defer srv.Close()

	resp, err := http.Get(srv.URL + "/")
	if err != nil {
		t.Fatalf("get /: %v", err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != 200 {
		t.Fatalf("status: %d", resp.StatusCode)
	}
	if ct := resp.Header.Get("Content-Type"); !strings.HasPrefix(ct, "text/html") {
		t.Errorf("content-type %q, want text/html...", ct)
	}
	if cc := resp.Header.Get("Cache-Control"); cc != "no-cache" {
		t.Errorf("cache-control %q, want no-cache", cc)
	}
}

func TestSPA_AssetServed(t *testing.T) {
	srv := newSPATestServer(t, map[string]string{
		"dist/index.html": "<html></html>",
		"dist/index.js":   "console.log('hi')",
		"dist/theme.css":  "body{color:#0f0}",
	})
	defer srv.Close()

	resp, err := http.Get(srv.URL + "/theme.css")
	if err != nil {
		t.Fatalf("get /theme.css: %v", err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != 200 {
		t.Fatalf("status: %d", resp.StatusCode)
	}
	if ct := resp.Header.Get("Content-Type"); !strings.HasPrefix(ct, "text/css") {
		t.Errorf("content-type %q, want text/css...", ct)
	}
	// Non-index assets are content-hashed and served immutably (see spa.go).
	if cc := resp.Header.Get("Cache-Control"); cc != "public, max-age=31536000, immutable" {
		t.Errorf("cache-control %q, want public, max-age=31536000, immutable", cc)
	}
}

func TestSPA_DeepLinkFallsBackToIndex(t *testing.T) {
	srv := newSPATestServer(t, map[string]string{
		"dist/index.html": "<html>chalk</html>",
	})
	defer srv.Close()

	resp, err := http.Get(srv.URL + "/channels/general")
	if err != nil {
		t.Fatalf("get /channels/general: %v", err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != 200 {
		t.Fatalf("status: %d", resp.StatusCode)
	}
	if ct := resp.Header.Get("Content-Type"); !strings.HasPrefix(ct, "text/html") {
		t.Errorf("deep-link should return index.html with text/html, got %q", ct)
	}
}

func TestSPA_MissingAssetIs404(t *testing.T) {
	srv := newSPATestServer(t, map[string]string{
		"dist/index.html": "<html></html>",
	})
	defer srv.Close()

	resp, err := http.Get(srv.URL + "/missing.js")
	if err != nil {
		t.Fatalf("get /missing.js: %v", err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != 404 {
		t.Errorf("expected 404 for missing asset with extension, got %d", resp.StatusCode)
	}
}

func TestSPA_DotfileRefused(t *testing.T) {
	srv := newSPATestServer(t, map[string]string{
		"dist/index.html": "<html></html>",
		"dist/.gitkeep":   "",
		"dist/.env":       "SECRET=hunter2",
	})
	defer srv.Close()

	// Direct dotfile request: refused.
	for _, p := range []string{"/.gitkeep", "/.env"} {
		resp, err := http.Get(srv.URL + p)
		if err != nil {
			t.Fatalf("get %s: %v", p, err)
		}
		resp.Body.Close()
		if resp.StatusCode != 404 {
			t.Errorf("dotfile %s should 404, got %d", p, resp.StatusCode)
		}
	}
}

func TestSPA_TraversalRefused(t *testing.T) {
	srv := newSPATestServer(t, map[string]string{
		"dist/index.html": "<html></html>",
	})
	defer srv.Close()

	// path.Clean normalizes "../etc/passwd" to "../etc/passwd"; our
	// handler rejects anything starting with "../".
	req, _ := http.NewRequest("GET", srv.URL+"/", nil)
	req.URL.Path = "/../etc/passwd"
	client := &http.Client{}
	resp, err := client.Do(req)
	if err != nil {
		t.Fatalf("get traversal: %v", err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != 404 {
		t.Errorf("traversal should 404, got %d", resp.StatusCode)
	}
}

func TestSPA_DirectoryListingRefused(t *testing.T) {
	srv := newSPATestServer(t, map[string]string{
		"dist/index.html":        "<html></html>",
		"dist/icons/favicon.svg": "<svg/>",
	})
	defer srv.Close()

	resp, err := http.Get(srv.URL + "/icons")
	if err != nil {
		t.Fatalf("get /icons: %v", err)
	}
	defer resp.Body.Close()
	// /icons has no extension, so it falls back to index.html (SPA
	// route). That's the correct behavior; a directory listing would
	// leak the asset layout.
	if resp.StatusCode != 200 {
		t.Errorf("expected SPA fallback (200), got %d", resp.StatusCode)
	}
	ct := resp.Header.Get("Content-Type")
	if !strings.HasPrefix(ct, "text/html") {
		t.Errorf("expected text/html from SPA fallback, got %q", ct)
	}
}

func TestSPA_MissingIndexHTMLFailsConstructor(t *testing.T) {
	_, err := spaHandler(fakeWebFS(map[string]string{
		"dist/other.html": "x",
	}), "dist")
	if err == nil {
		t.Fatal("spaHandler should fail when index.html is missing")
	}
}

// ---- security headers ----------------------------------------------------

func TestSPA_DocumentCarriesSecurityHeaders(t *testing.T) {
	srv := newSPATestServer(t, map[string]string{
		"dist/index.html": "<html>chalk</html>",
	})
	defer srv.Close()

	for _, path := range []string{"/", "/channels/general"} {
		resp, err := http.Get(srv.URL + path)
		if err != nil {
			t.Fatalf("get %s: %v", path, err)
		}
		resp.Body.Close()
		csp := resp.Header.Get("Content-Security-Policy")
		if csp == "" {
			t.Fatalf("%s: no Content-Security-Policy", path)
		}
		// Spot-check the directives whose absence would be a real hole, and
		// the two allowances whose absence would break login and the TOTP QR.
		for _, want := range []string{
			"default-src 'self'",
			"connect-src 'self'",
			"frame-ancestors 'none'",
			"object-src 'none'",
			"'wasm-unsafe-eval'",
			"img-src 'self' data: blob:",
			// Blocking these would silently kill Giphy rendering for
			// viewers who opted in.
			"https://media2.giphy.com",
			"https://i.giphy.com",
		} {
			if !strings.Contains(csp, want) {
				t.Errorf("%s: CSP %q missing %q", path, csp, want)
			}
		}
		if rp := resp.Header.Get("Referrer-Policy"); rp != "no-referrer" {
			t.Errorf("%s: referrer-policy %q, want no-referrer", path, rp)
		}
		if xcto := resp.Header.Get("X-Content-Type-Options"); xcto != "nosniff" {
			t.Errorf("%s: x-content-type-options %q, want nosniff", path, xcto)
		}
	}
}

// Assets get nosniff but no document policy: CSP on a .js response is inert,
// and shipping it there would only invite it to drift from the real one.
func TestSPA_AssetNosniffWithoutDocumentHeaders(t *testing.T) {
	srv := newSPATestServer(t, map[string]string{
		"dist/index.html": "<html></html>",
		"dist/theme.css":  "body{color:#0f0}",
	})
	defer srv.Close()

	resp, err := http.Get(srv.URL + "/theme.css")
	if err != nil {
		t.Fatalf("get /theme.css: %v", err)
	}
	resp.Body.Close()
	if xcto := resp.Header.Get("X-Content-Type-Options"); xcto != "nosniff" {
		t.Errorf("x-content-type-options %q, want nosniff", xcto)
	}
	if csp := resp.Header.Get("Content-Security-Policy"); csp != "" {
		t.Errorf("asset carries a CSP (%q); it belongs on documents only", csp)
	}
}

// A 404 is still a response the browser types; nosniff has to survive the
// early returns that reject traversal and dotfiles.
func TestSPA_NotFoundKeepsNosniff(t *testing.T) {
	srv := newSPATestServer(t, map[string]string{
		"dist/index.html": "<html></html>",
	})
	defer srv.Close()

	for _, path := range []string{"/missing.js", "/.env"} {
		resp, err := http.Get(srv.URL + path)
		if err != nil {
			t.Fatalf("get %s: %v", path, err)
		}
		resp.Body.Close()
		if resp.StatusCode != 404 {
			t.Fatalf("%s: status %d, want 404", path, resp.StatusCode)
		}
		if xcto := resp.Header.Get("X-Content-Type-Options"); xcto != "nosniff" {
			t.Errorf("%s: x-content-type-options %q, want nosniff", path, xcto)
		}
	}
}

// 52-2: the background-blur runtime is WASM, and WebAssembly's streaming
// instantiation refuses anything not typed application/wasm. Go's mime table
// has no entry for the extension and we send nosniff, so without an explicit
// type the blur silently fails to start on a MIME technicality.
func TestSPA_WasmContentType(t *testing.T) {
	srv := newSPATestServer(t, map[string]string{
		"dist/index.html":                          "<html></html>",
		"dist/mediapipe-ABCD1234/vision_wasm.wasm": "\x00asm\x01\x00\x00\x00",
		"dist/mediapipe-ABCD1234/selfie.tflite":    "TFL3",
	})
	defer srv.Close()

	for _, tc := range []struct{ path, want string }{
		{"/mediapipe-ABCD1234/vision_wasm.wasm", "application/wasm"},
		{"/mediapipe-ABCD1234/selfie.tflite", "application/octet-stream"},
	} {
		resp, err := http.Get(srv.URL + tc.path)
		if err != nil {
			t.Fatalf("get %s: %v", tc.path, err)
		}
		resp.Body.Close()
		if resp.StatusCode != 200 {
			t.Fatalf("%s status: %d", tc.path, resp.StatusCode)
		}
		if ct := resp.Header.Get("Content-Type"); ct != tc.want {
			t.Errorf("%s content-type %q, want %q", tc.path, ct, tc.want)
		}
		// The whole point of the hashed directory: these are cacheable forever.
		if cc := resp.Header.Get("Cache-Control"); !strings.Contains(cc, "immutable") {
			t.Errorf("%s cache-control %q, want immutable", tc.path, cc)
		}
	}
}

func TestContentTypeForLeavesKnownTypesAlone(t *testing.T) {
	// Everything else keeps ServeContent's own answer; a map that grew to
	// cover .js and .css would be a second, quietly diverging mime table.
	for _, name := range []string{"index-AB12.js", "theme-CD34.css", "icons/favicon-EF56.svg"} {
		if got := contentTypeFor(name); got != "" {
			t.Errorf("contentTypeFor(%q) = %q, want empty", name, got)
		}
	}
}
