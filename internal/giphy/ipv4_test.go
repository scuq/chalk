package giphy

import (
	"context"
	"errors"
	"net"
	"net/http"
	"strings"
	"syscall"
	"testing"
	"time"
)

// TestDialContextIPv4Only checks the dial function. The dialer has a Control
// function that returns a sentinel error, so the test needs no listener and
// no IPv6 route. With IPv4 only, an IPv6 literal fails before Control runs,
// and a hostname reaches Control with IPv4 addresses only.
func TestDialContextIPv4Only(t *testing.T) {
	errStop := errors.New("stop")
	var seen []string
	d := &net.Dialer{
		Timeout: 2 * time.Second,
		Control: func(_, address string, _ syscall.RawConn) error {
			seen = append(seen, address)
			return errStop
		},
	}
	ctx := context.Background()

	if _, err := dialContext(d, false)(ctx, "tcp", "127.0.0.1:1"); !errors.Is(err, errStop) {
		t.Fatalf("dual stack, IPv4 literal: %v", err)
	}

	seen = nil
	v4 := dialContext(d, true)
	if _, err := v4(ctx, "tcp", "127.0.0.1:1"); !errors.Is(err, errStop) {
		t.Fatalf("IPv4 only, IPv4 literal: %v", err)
	}
	if len(seen) != 1 {
		t.Fatalf("IPv4 only, IPv4 literal: Control saw %v", seen)
	}

	seen = nil
	if _, err := v4(ctx, "tcp", "[::1]:1"); err == nil || errors.Is(err, errStop) {
		t.Fatalf("IPv4 only, IPv6 literal: %v", err)
	}
	if len(seen) != 0 {
		t.Fatalf("IPv4 only, IPv6 literal: Control saw %v", seen)
	}

	seen = nil
	_, _ = v4(ctx, "tcp", "localhost:1")
	for _, a := range seen {
		if !strings.HasPrefix(a, "127.") {
			t.Fatalf("IPv4 only, hostname: Control saw %s", a)
		}
	}
}

// TestWithIPv4Only checks that the default client has no custom transport.
// With WithIPv4Only, the transport refuses an IPv6 address and keeps the
// timeout. A client from WithHTTPClient stays as it is.
func TestWithIPv4Only(t *testing.T) {
	if c := New("k", 10, "g", time.Second); c.hc.Transport != nil {
		t.Fatal("the default client has a custom transport")
	}

	c := New("k", 10, "g", time.Second, WithIPv4Only())
	tr, ok := c.hc.Transport.(*http.Transport)
	if !ok || tr.DialContext == nil {
		t.Fatalf("IPv4 only: transport = %T", c.hc.Transport)
	}
	if c.hc.Timeout != time.Second {
		t.Fatalf("IPv4 only: timeout = %s", c.hc.Timeout)
	}
	if _, err := tr.DialContext(context.Background(), "tcp", "[::1]:1"); err == nil {
		t.Fatal("IPv4 only: the transport dialed an IPv6 address")
	}

	own := &http.Client{}
	c = New("k", 10, "g", time.Second, WithHTTPClient(own), WithIPv4Only())
	if c.hc != own || own.Transport != nil {
		t.Fatal("IPv4 only changed a client from WithHTTPClient")
	}
}
