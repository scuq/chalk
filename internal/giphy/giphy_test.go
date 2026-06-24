package giphy

import (
	"context"
	"net/http"
	"net/http/httptest"
	"net/url"
	"strings"
	"testing"
	"time"
)

// cannedSearchJSON is a trimmed Giphy /v1/gifs/search response covering the
// cases Search must handle: a full entry, an entry missing the downsampled
// preview (preview falls back to fixed_width), an entry missing fixed_width
// (full falls back to original), and an entry missing every rendition we
// rely on (skipped).
const cannedSearchJSON = `{
  "data": [
    {
      "id": "abc123",
      "title": "happy dance",
      "images": {
        "fixed_width": {"url": "https://media.giphy.com/abc/fw.gif", "width": "200", "height": "150"},
        "fixed_width_downsampled": {"url": "https://media.giphy.com/abc/fwd.gif", "width": "200", "height": "150"},
        "original": {"url": "https://media.giphy.com/abc/orig.gif", "width": "480", "height": "360"}
      }
    },
    {
      "id": "noprev",
      "title": "no downsample",
      "images": {
        "fixed_width": {"url": "https://media.giphy.com/np/fw.gif", "width": "200", "height": "100"},
        "fixed_width_downsampled": {"url": "", "width": "", "height": ""},
        "original": {"url": "https://media.giphy.com/np/orig.gif", "width": "500", "height": "250"}
      }
    },
    {
      "id": "nofw",
      "title": "no fixed width",
      "images": {
        "fixed_width": {"url": "", "width": "", "height": ""},
        "fixed_width_downsampled": {"url": "https://media.giphy.com/nf/fwd.gif", "width": "180", "height": "180"},
        "original": {"url": "https://media.giphy.com/nf/orig.gif", "width": "400", "height": "400"}
      }
    },
    {
      "id": "empty",
      "title": "no usable rendition",
      "images": {
        "fixed_width": {"url": "", "width": "", "height": ""},
        "fixed_width_downsampled": {"url": "", "width": "", "height": ""},
        "original": {"url": "", "width": "", "height": ""}
      }
    }
  ],
  "meta": {"status": 200, "msg": "OK"}
}`

// newMockGiphy returns an httptest server that records the last request query
// and serves the supplied status + body.
func newMockGiphy(t *testing.T, status int, body string, captured *url.Values) *httptest.Server {
	t.Helper()
	return httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if captured != nil {
			*captured = r.URL.Query()
		}
		if r.URL.Path != "/v1/gifs/search" {
			t.Errorf("unexpected path %q", r.URL.Path)
		}
		w.WriteHeader(status)
		_, _ = w.Write([]byte(body))
	}))
}

func TestSearch_ForwardsParamsAndMaps(t *testing.T) {
	var got url.Values
	srv := newMockGiphy(t, 200, cannedSearchJSON, &got)
	defer srv.Close()

	c := New("test-key", 24, "pg-13", 5*time.Second, WithBaseURL(srv.URL))
	results, err := c.Search(context.Background(), "  happy dance  ")
	if err != nil {
		t.Fatalf("Search: %v", err)
	}

	// Query params forwarded to Giphy.
	if got.Get("api_key") != "test-key" {
		t.Errorf("api_key = %q", got.Get("api_key"))
	}
	if got.Get("q") != "happy dance" { // trimmed
		t.Errorf("q = %q, want trimmed 'happy dance'", got.Get("q"))
	}
	if got.Get("limit") != "24" {
		t.Errorf("limit = %q", got.Get("limit"))
	}
	if got.Get("rating") != "pg-13" {
		t.Errorf("rating = %q", got.Get("rating"))
	}
	if got.Get("bundle") != "messaging_non_clips" {
		t.Errorf("bundle = %q", got.Get("bundle"))
	}

	// The 4th entry (no usable rendition) is skipped -> 3 results.
	if len(results) != 3 {
		t.Fatalf("len(results) = %d, want 3", len(results))
	}

	// Entry 1: full mapping, preview = downsampled.
	r0 := results[0]
	if r0.ID != "abc123" || r0.Title != "happy dance" {
		t.Errorf("r0 id/title = %q/%q", r0.ID, r0.Title)
	}
	if r0.PreviewURL != "https://media.giphy.com/abc/fwd.gif" {
		t.Errorf("r0 preview = %q (want downsampled)", r0.PreviewURL)
	}
	if r0.FullURL != "https://media.giphy.com/abc/fw.gif" {
		t.Errorf("r0 full = %q (want fixed_width)", r0.FullURL)
	}
	if r0.PreviewWidth != 200 || r0.PreviewHeight != 150 {
		t.Errorf("r0 preview dims = %dx%d", r0.PreviewWidth, r0.PreviewHeight)
	}

	// Entry 2: no downsample -> preview falls back to fixed_width.
	if results[1].PreviewURL != "https://media.giphy.com/np/fw.gif" {
		t.Errorf("r1 preview = %q (want fixed_width fallback)", results[1].PreviewURL)
	}

	// Entry 3: no fixed_width -> full falls back to original.
	if results[2].FullURL != "https://media.giphy.com/nf/orig.gif" {
		t.Errorf("r2 full = %q (want original fallback)", results[2].FullURL)
	}
}

func TestSearch_EmptyQuery(t *testing.T) {
	var called bool
	srv := httptest.NewServer(http.HandlerFunc(func(http.ResponseWriter, *http.Request) {
		called = true
	}))
	defer srv.Close()

	c := New("k", 24, "pg-13", time.Second, WithBaseURL(srv.URL))
	if _, err := c.Search(context.Background(), "   "); err != ErrEmptyQuery {
		t.Fatalf("err = %v, want ErrEmptyQuery", err)
	}
	if called {
		t.Error("blank query must not hit the network")
	}
}

func TestSearch_UpstreamNon2xx(t *testing.T) {
	srv := newMockGiphy(t, http.StatusForbidden, `{"meta":{"status":403,"msg":"Forbidden"}}`, nil)
	defer srv.Close()

	c := New("k", 24, "pg-13", time.Second, WithBaseURL(srv.URL))
	_, err := c.Search(context.Background(), "cats")
	if err == nil || !strings.Contains(err.Error(), "status 403") {
		t.Fatalf("err = %v, want upstream status 403", err)
	}
}

func TestSearch_MalformedJSON(t *testing.T) {
	srv := newMockGiphy(t, 200, `{not json`, nil)
	defer srv.Close()

	c := New("k", 24, "pg-13", time.Second, WithBaseURL(srv.URL))
	if _, err := c.Search(context.Background(), "cats"); err == nil {
		t.Fatal("want decode error, got nil")
	}
}

func TestSearch_TruncatesLongQuery(t *testing.T) {
	var got url.Values
	srv := newMockGiphy(t, 200, `{"data":[],"meta":{"status":200}}`, &got)
	defer srv.Close()

	c := New("k", 24, "pg-13", time.Second, WithBaseURL(srv.URL))
	long := strings.Repeat("a", 250)
	if _, err := c.Search(context.Background(), long); err != nil {
		t.Fatalf("Search: %v", err)
	}
	if got.Get("q") != strings.Repeat("a", maxQueryLen) {
		t.Errorf("forwarded q length = %d, want %d", len(got.Get("q")), maxQueryLen)
	}
}

func TestSearch_NoRatingOmitsParam(t *testing.T) {
	var got url.Values
	srv := newMockGiphy(t, 200, `{"data":[],"meta":{"status":200}}`, &got)
	defer srv.Close()

	c := New("k", 24, "", time.Second, WithBaseURL(srv.URL))
	if _, err := c.Search(context.Background(), "cats"); err != nil {
		t.Fatalf("Search: %v", err)
	}
	if _, ok := got["rating"]; ok {
		t.Errorf("rating param should be omitted when empty")
	}
}
