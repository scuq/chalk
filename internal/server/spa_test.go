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
	if cc := resp.Header.Get("Cache-Control"); cc != "public, max-age=300" {
		t.Errorf("cache-control %q, want public, max-age=300", cc)
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
		"dist/index.html":   "<html></html>",
		"dist/.gitkeep":     "",
		"dist/.env":         "SECRET=hunter2",
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
		"dist/index.html":      "<html></html>",
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
