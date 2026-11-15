package webpush

import (
	"context"
	"errors"
	"net"
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

// TestSendIPv4OnlySkipsIPv6Endpoint checks that a Sender with WithIPv4Only
// does not reach the dial guard for an IPv6 endpoint. The test skips if the
// host has no IPv6 loopback.
func TestSendIPv4OnlySkipsIPv6Endpoint(t *testing.T) {
	ua, auth := newUA(t)
	sub := Subscription{Endpoint: "https://[::1]:1/send", P256dh: ua.PublicKey().Bytes(), Auth: auth}

	err := NewSender(newKey(t), 5*time.Second).Send(context.Background(), sub, []byte("x"), Options{})
	if !errors.Is(err, errDisallowedAddr) {
		t.Skipf("no IPv6 loopback on this host: %v", err)
	}

	err = NewSender(newKey(t), 5*time.Second, WithIPv4Only()).Send(context.Background(), sub, []byte("x"), Options{})
	if err == nil || errors.Is(err, errDisallowedAddr) {
		t.Fatalf("IPv4 only reached the dial guard with an IPv6 address: %v", err)
	}
}
