package webpush

import (
	"crypto/tls"
	"crypto/x509"
	"net"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"
)

// TestNewTransportHTTP2 checks that the transport speaks HTTP/2 to a TLS test
// server with the flag and HTTP/1.1 without it. It also checks that
// NewHTTP2Client sets the flag and keeps the guards, and that the Web Push
// sender keeps HTTP/1.1.
func TestNewTransportHTTP2(t *testing.T) {
	srv := httptest.NewUnstartedServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("X-Proto", r.Proto)
	}))
	srv.EnableHTTP2 = true
	srv.StartTLS()
	defer srv.Close()
	pool := x509.NewCertPool()
	pool.AddCert(srv.Certificate())

	for _, tc := range []struct {
		http2 bool
		want  string
	}{{true, "HTTP/2.0"}, {false, "HTTP/1.1"}} {
		tr := newTransport(&net.Dialer{Timeout: 2 * time.Second}, false, tc.http2)
		tr.TLSClientConfig = &tls.Config{RootCAs: pool}
		resp, err := (&http.Client{Transport: tr}).Get(srv.URL)
		if err != nil {
			t.Fatalf("http2=%v: %v", tc.http2, err)
		}
		resp.Body.Close()
		if got := resp.Header.Get("X-Proto"); got != tc.want {
			t.Fatalf("http2=%v: server saw %s, want %s", tc.http2, got, tc.want)
		}
		tr.CloseIdleConnections()
	}

	hc := NewHTTP2Client(time.Second, WithIPv4Only())
	tr, ok := hc.Transport.(*http.Transport)
	if !ok || !tr.ForceAttemptHTTP2 || tr.Proxy != nil || hc.CheckRedirect == nil {
		t.Fatalf("NewHTTP2Client: transport %+v", hc.Transport)
	}
	if got := NewSender(newKey(t), time.Second).hc.Transport.(*http.Transport).ForceAttemptHTTP2; got {
		t.Fatal("the Web Push sender must keep HTTP/1.1")
	}
	if ReasonFrom([]byte(`{"reason":"BadDeviceToken"}`)) != "BadDeviceToken" {
		t.Fatal("ReasonFrom")
	}
}
