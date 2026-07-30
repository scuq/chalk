package auth

import (
	"encoding/json"
	"fmt"
	"log"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/scuq/chalk/internal/linkpreview"
)

// lpDeps builds HTTPDeps with the given preview client and a fresh limiter,
// skipping MountLinkPreview so tests can call the handlers directly with a
// fabricated session (the RequireSession middleware has its own tests).
func lpDeps(client *linkpreview.Client, limit int) *HTTPDeps {
	return &HTTPDeps{
		Logger:             log.Default(),
		LinkPreview:        client,
		linkPreviewLimiter: linkpreview.NewRateLimiter(limit, time.Minute),
	}
}

func lpUser() *SessionUser {
	return &SessionUser{UserID: uuid.New(), Username: "alice"}
}

func TestLinkPreviewDisabledReturns503(t *testing.T) {
	d := lpDeps(nil, 10)
	w := httptest.NewRecorder()
	d.handleLinkPreview(w, httptest.NewRequest("GET", "/api/linkpreview?url=https://youtube.com/", nil), lpUser())
	if w.Code != http.StatusServiceUnavailable {
		t.Fatalf("status = %d, want 503", w.Code)
	}
}

func TestLinkPreviewMissingURLReturns400(t *testing.T) {
	d := lpDeps(linkpreview.New(time.Second), 10)
	w := httptest.NewRecorder()
	d.handleLinkPreview(w, httptest.NewRequest("GET", "/api/linkpreview", nil), lpUser())
	if w.Code != http.StatusBadRequest {
		t.Fatalf("status = %d, want 400", w.Code)
	}
}

func TestLinkPreviewBadURLReturns400(t *testing.T) {
	d := lpDeps(linkpreview.New(time.Second), 10)
	w := httptest.NewRecorder()
	d.handleLinkPreview(w, httptest.NewRequest("GET", "/api/linkpreview?url=http://youtube.com/", nil), lpUser())
	if w.Code != http.StatusBadRequest {
		t.Fatalf("status = %d, want 400 (http url)", w.Code)
	}
}

func TestLinkPreviewGuardedFetchReturns502(t *testing.T) {
	// Production client (no test options): the dial guard rejects loopback,
	// which must surface as an opaque 502, proving guard and mapping wire up.
	d := lpDeps(linkpreview.New(time.Second), 10)
	w := httptest.NewRecorder()
	d.handleLinkPreview(w, httptest.NewRequest("GET", "/api/linkpreview?url=https://127.0.0.1:1/", nil), lpUser())
	if w.Code != http.StatusBadGateway {
		t.Fatalf("status = %d, want 502", w.Code)
	}
}

func TestLinkPreviewHappyPathAndRateLimit(t *testing.T) {
	srv := httptest.NewTLSServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path == "/thumb.png" {
			w.Header().Set("Content-Type", "image/png")
			fmt.Fprint(w, "PNG")
			return
		}
		w.Header().Set("Content-Type", "text/html")
		fmt.Fprint(w, `<head><meta property="og:title" content="A Page"></head>`)
	}))
	defer srv.Close()
	client := linkpreview.New(time.Second, linkpreview.WithHTTPClient(srv.Client()))

	d := lpDeps(client, 3)
	su := lpUser()

	w := httptest.NewRecorder()
	d.handleLinkPreview(w, httptest.NewRequest("GET", "/api/linkpreview?url="+srv.URL, nil), su)
	if w.Code != http.StatusOK {
		t.Fatalf("status = %d, body %s", w.Code, w.Body)
	}
	var p linkpreview.Preview
	if err := json.Unmarshal(w.Body.Bytes(), &p); err != nil || p.Title != "A Page" {
		t.Fatalf("preview = %+v, err %v", p, err)
	}

	w = httptest.NewRecorder()
	d.handleLinkPreviewImage(w, httptest.NewRequest("GET", "/api/linkpreview/image?url="+srv.URL+"/thumb.png", nil), su)
	if w.Code != http.StatusOK || w.Body.String() != "PNG" {
		t.Fatalf("image status = %d, body %q", w.Code, w.Body)
	}
	if cc := w.Header().Get("Cache-Control"); cc != "no-store" {
		t.Fatalf("Cache-Control = %q, want no-store", cc)
	}

	// Two fetches spent; the third is allowed, the fourth rate-limited --
	// but only for this user.
	w = httptest.NewRecorder()
	d.handleLinkPreview(w, httptest.NewRequest("GET", "/api/linkpreview?url="+srv.URL, nil), su)
	if w.Code != http.StatusOK {
		t.Fatalf("3rd fetch status = %d", w.Code)
	}
	w = httptest.NewRecorder()
	d.handleLinkPreview(w, httptest.NewRequest("GET", "/api/linkpreview?url="+srv.URL, nil), su)
	if w.Code != http.StatusTooManyRequests {
		t.Fatalf("4th fetch status = %d, want 429", w.Code)
	}
	w = httptest.NewRecorder()
	d.handleLinkPreview(w, httptest.NewRequest("GET", "/api/linkpreview?url="+srv.URL, nil), lpUser())
	if w.Code != http.StatusOK {
		t.Fatalf("other user status = %d (limit must be per-user)", w.Code)
	}
}

func TestConfigReportsLinkPreview(t *testing.T) {
	// handleConfig needs a Service; reuse the test harness other config
	// tests use if available -- here we only exercise the JSON shape via
	// the response struct to keep this test store-free.
	resp := configResponse{
		LinkPreviewEnabled: true,
		LinkPreviewDomains: []string{"youtube.com", "youtu.be"},
	}
	b, err := json.Marshal(resp)
	if err != nil {
		t.Fatal(err)
	}
	var m map[string]any
	if err := json.Unmarshal(b, &m); err != nil {
		t.Fatal(err)
	}
	if m["linkpreview_enabled"] != true {
		t.Fatalf("linkpreview_enabled missing: %s", b)
	}
	if _, ok := m["linkpreview_domains"].([]any); !ok {
		t.Fatalf("linkpreview_domains missing: %s", b)
	}
}
