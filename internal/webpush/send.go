package webpush

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/netip"
	"net/url"
	"strconv"
	"strings"
	"syscall"
	"time"
)

// ErrGone is returned when the push service answers 404 or 410. The
// subscription no longer exists. The caller must delete it.
var ErrGone = errors.New("webpush: subscription is gone")

// ErrEndpoint is returned for an endpoint that is not an https URL with a
// host and without credentials.
var ErrEndpoint = errors.New("webpush: endpoint must be an https URL")

// errDisallowedAddr is the error of the dial-time address guard.
var errDisallowedAddr = errors.New("webpush: address is not public")

// A StatusError is an answer of the push service that is neither a success
// (status 200 to 299) nor ErrGone. A redirect is a StatusError, because the
// Sender does not follow redirects. Reason holds the text that the service
// gives for the rejection, if the response body has any.
type StatusError struct {
	Code       int
	RetryAfter string // the Retry-After header, if the service sent one
	Reason     string // 65-12: the reason text of the service, cleaned by reasonFrom
}

// Error returns the message of e, with the status code. If Reason is not
// empty, the message ends with Reason in parentheses.
func (e *StatusError) Error() string {
	msg := "webpush: push service answered " + strconv.Itoa(e.Code)
	if e.Reason != "" {
		msg += " (" + e.Reason + ")"
	}
	return msg
}

// maxReasonLen is the maximum length of the reason that reasonFrom returns, in
// characters.
const maxReasonLen = 120

// reasonFrom returns the reason text in the response body of a push service.
// If body is a JSON object with a non-empty string field "reason", the text
// is that string. Otherwise the text is body. The result keeps only printable
// ASCII characters (0x20 to 0x7e), has no leading or trailing space, and has
// at most maxReasonLen characters. A push service is a third party, so its text
// must not add a line to the log.
func reasonFrom(body []byte) string {
	text := string(body)
	var obj struct {
		Reason string `json:"reason"`
	}
	if json.Unmarshal(body, &obj) == nil && obj.Reason != "" {
		text = obj.Reason
	}
	var b strings.Builder
	for _, r := range strings.TrimSpace(text) {
		if b.Len() == maxReasonLen {
			break
		}
		if r >= 0x20 && r < 0x7f {
			b.WriteRune(r)
		}
	}
	return strings.TrimSpace(b.String())
}

// Urgency is the Urgency header of RFC 8030.
type Urgency string

// The values of the Urgency header.
const (
	UrgencyVeryLow Urgency = "very-low"
	UrgencyLow     Urgency = "low"
	UrgencyNormal  Urgency = "normal"
	UrgencyHigh    Urgency = "high"
)

// Options are the delivery headers of one push.
// Send writes TTL in whole seconds, also when TTL is zero.
type Options struct {
	TTL     time.Duration // how long the push service keeps an undelivered push
	Topic   string        // a later push with the same topic replaces this one
	Urgency Urgency       // empty means the service default, normal
}

// A Subscription is the part of a browser's push registration that a send
// needs.
type Subscription struct {
	Endpoint string // the https URL of the push service
	P256dh   []byte // the browser public key, 65 bytes
	Auth     []byte // the authentication secret, 16 bytes
}

// A Sender posts encrypted pushes to push services. It is safe for
// concurrent use.
type Sender struct {
	key *VAPIDKey
	hc  *http.Client
	now func() time.Time
}

// NewSender returns a Sender that signs with key and gives up on one push
// after timeout. Its HTTP client connects only to public addresses and
// follows no redirect. The options (65-11) change how the client dials, for
// example [WithIPv4Only].
func NewSender(key *VAPIDKey, timeout time.Duration, opts ...SenderOption) *Sender {
	var so senderOptions
	for _, o := range opts {
		o(&so)
	}
	// The dial-time guard checks the address of each connection after DNS.
	// The transport sets Proxy to nil on purpose. With a proxy, the guard
	// would check the address of the proxy and not the address of the
	// endpoint.
	dialer := &net.Dialer{
		Timeout: timeout,
		Control: func(_, address string, _ syscall.RawConn) error {
			return vetDialAddr(address)
		},
	}
	return &Sender{
		key: key,
		now: time.Now,
		hc: &http.Client{
			Timeout:   timeout,
			Transport: &http.Transport{DialContext: dialContext(dialer, so.ipv4Only), Proxy: nil},
			CheckRedirect: func(*http.Request, []*http.Request) error {
				return http.ErrUseLastResponse
			},
		},
	}
}

// senderOptions holds the settings that a [SenderOption] changes.
type senderOptions struct {
	ipv4Only bool
}

// A SenderOption changes one setting of a [Sender] at construction.
type SenderOption func(*senderOptions)

// WithIPv4Only returns a SenderOption that makes the Sender dial with network
// "tcp4". The Sender then tries no IPv6 address.
func WithIPv4Only() SenderOption {
	return func(o *senderOptions) { o.ipv4Only = true }
}

// dialContext returns the dial function for the HTTP transport. If ipv4Only is
// false, it returns d.DialContext. If ipv4Only is true, the function ignores
// the network argument and dials "tcp4", so the resolver asks for A records only.
func dialContext(d *net.Dialer, ipv4Only bool) func(context.Context, string, string) (net.Conn, error) {
	if !ipv4Only {
		return d.DialContext
	}
	return func(ctx context.Context, _, addr string) (net.Conn, error) {
		return d.DialContext(ctx, "tcp4", addr)
	}
}

// PublicKey returns the VAPID public key of the Sender.
func (s *Sender) PublicKey() string { return s.key.PublicKey() }

// ValidateEndpoint returns ErrEndpoint unless endpoint is an https URL with
// a host and without credentials. It returns the origin, which is the VAPID
// audience.
func ValidateEndpoint(endpoint string) (origin string, err error) {
	u, perr := url.Parse(endpoint)
	if perr != nil || u.Scheme != "https" || u.Host == "" || u.User != nil {
		return "", ErrEndpoint
	}
	return "https://" + u.Host, nil
}

// Send encrypts payload to sub and posts it to the endpoint.
//
// It returns ErrGone if the subscription no longer exists, ErrEndpoint or
// ErrPayloadTooLarge for bad input, and a *StatusError for every other
// answer that is not a success. Send reads at most 4096 bytes of the response
// body. Only a *StatusError uses the body, for its Reason.
func (s *Sender) Send(ctx context.Context, sub Subscription, payload []byte, opts Options) error {
	origin, err := ValidateEndpoint(sub.Endpoint)
	if err != nil {
		return err
	}
	body, err := Encrypt(payload, sub.P256dh, sub.Auth)
	if err != nil {
		return err
	}
	authz, err := s.key.authorization(origin, s.now())
	if err != nil {
		return err
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, sub.Endpoint, bytes.NewReader(body))
	if err != nil {
		return ErrEndpoint
	}
	req.Header.Set("Authorization", authz)
	req.Header.Set("Content-Encoding", "aes128gcm")
	req.Header.Set("Content-Type", "application/octet-stream")
	req.Header.Set("TTL", strconv.FormatInt(int64(opts.TTL/time.Second), 10))
	if opts.Topic != "" {
		req.Header.Set("Topic", opts.Topic)
	}
	if opts.Urgency != "" {
		req.Header.Set("Urgency", string(opts.Urgency))
	}

	resp, err := s.hc.Do(req)
	if err != nil {
		return fmt.Errorf("webpush: send: %w", err)
	}
	defer resp.Body.Close()
	// The body gives the Reason of a StatusError. Send ignores a read error and
	// uses the bytes that it read.
	answer, _ := io.ReadAll(io.LimitReader(resp.Body, 4096))

	switch {
	case resp.StatusCode >= 200 && resp.StatusCode < 300:
		return nil
	case resp.StatusCode == http.StatusNotFound || resp.StatusCode == http.StatusGone:
		return ErrGone
	}
	return &StatusError{
		Code:       resp.StatusCode,
		RetryAfter: resp.Header.Get("Retry-After"),
		Reason:     reasonFrom(answer),
	}
}

// The rest of this file is the dial-time address guard. It is copied from
// internal/linkpreview.

// deniedV4 lists the IPv4 ranges that isPublicAddr rejects in addition to
// the ranges that the net/netip methods reject.

var deniedV4 = []netip.Prefix{
	netip.MustParsePrefix("100.64.0.0/10"),   // CGNAT
	netip.MustParsePrefix("192.0.0.0/24"),    // IETF protocol assignments
	netip.MustParsePrefix("192.0.2.0/24"),    // TEST-NET-1
	netip.MustParsePrefix("198.18.0.0/15"),   // benchmarking
	netip.MustParsePrefix("198.51.100.0/24"), // TEST-NET-2
	netip.MustParsePrefix("203.0.113.0/24"),  // TEST-NET-3
	netip.MustParsePrefix("240.0.0.0/4"),     // reserved + broadcast
}

// deniedV6 lists the IPv6 ranges that isPublicAddr rejects in addition to
// the ranges that the net/netip methods reject.
var deniedV6 = []netip.Prefix{
	netip.MustParsePrefix("2001:db8::/32"), // documentation
	netip.MustParsePrefix("64:ff9b::/96"),  // NAT64: can embed a private v4
}

// vetDialAddr returns an error if a dial target is not a public unicast
// address. address is the "ip:port" of the transport, after DNS, so a
// hostname that resolves to an internal address fails here. An address that
// does not parse also fails.
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
		a.IsPrivate() ||
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
