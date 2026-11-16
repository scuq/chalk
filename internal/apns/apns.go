// Package apns sends push notifications to iPhones through the Apple Push
// Notification service (APNs). It is the native counterpart of package
// webpush (phase 136, docs/phases/PHASE-136-IOS.md).
//
// Apple sees only ciphertext. The app makes its own P-256 key pair and
// 16-byte authentication secret, and uploads the public half with the APNs
// device token, in the shape of a Web Push subscription. [Sender.Send]
// encrypts the payload with [webpush.Encrypt] (RFC 8291, aes128gcm, padded to
// one fixed length) and puts the ciphertext in the "chalk" key of the JSON
// body. A Notification Service Extension in the app decrypts it. If the
// extension fails, the phone shows the constant text [FallbackTitle] and
// [FallbackBody].
//
// # Status
//
// 136-4a: chalkd does not build a [Sender] yet, so no push goes to Apple.
// The tests use a local TLS server and send nothing to the real APNs.
package apns

import (
	"bytes"
	"context"
	"crypto/ecdsa"
	"crypto/elliptic"
	"crypto/rand"
	"crypto/sha256"
	"crypto/x509"
	"encoding/base64"
	"encoding/json"
	"encoding/pem"
	"errors"
	"fmt"
	"io"
	"net/http"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/scuq/chalk/internal/webpush"
)

// ErrGone is returned when APNs reports that the device token is no longer
// valid. That is status 410, or status 400 with the reason BadDeviceToken or
// DeviceTokenNotForTopic. The caller must delete the device row. The error
// text keeps the status and the reason.
//
// APNs also answers BadDeviceToken when a sandbox token goes to the
// production host. A wrong environment setting therefore makes the caller
// delete rows.
var ErrGone = errors.New("apns: device token is gone")

// ErrToken is returned for a device token that is empty, longer than 200
// characters, or not hexadecimal. The check keeps the token from changing
// the request path.
var ErrToken = errors.New("apns: device token must be hexadecimal")

// ErrCollapseID is returned for a collapse id that is longer than 64 bytes,
// the limit of APNs.
var ErrCollapseID = errors.New("apns: collapse id is longer than 64 bytes")

// A StatusError is an answer of APNs that is neither a success (status 200)
// nor [ErrGone]. A redirect is a StatusError, because the Sender does not
// follow redirects. Reason holds the reason text of APNs, cleaned by
// [webpush.ReasonFrom], if the response body has one.
type StatusError struct {
	Code       int
	RetryAfter string
	Reason     string
}

// Error returns the message of e, with the status code. If Reason is not
// empty, the message ends with Reason in parentheses.
func (e *StatusError) Error() string {
	msg := "apns: push service answered " + strconv.Itoa(e.Code)
	if e.Reason != "" {
		msg += " (" + e.Reason + ")"
	}
	return msg
}

// An Environment is the APNs host that a [Sender] uses. Builds installed from
// Xcode use [Sandbox]. TestFlight builds use [Production].
type Environment string

// The values of Environment.
const (
	Production Environment = "production"
	Sandbox    Environment = "sandbox"
)

// host returns the base URL of the APNs host for e. Any value other than
// [Sandbox] gives the production host.
func (e Environment) host() string {
	if e == Sandbox {
		return "https://api.sandbox.push.apple.com"
	}
	return "https://api.push.apple.com"
}

// ParseEnvironment returns the Environment that s names. The empty string
// means [Production]. It returns an error for any other value than
// "production" and "sandbox".
func ParseEnvironment(s string) (Environment, error) {
	switch Environment(s) {
	case "", Production:
		return Production, nil
	case Sandbox:
		return Sandbox, nil
	}
	return "", errors.New("apns: environment must be production or sandbox")
}

// tokenRenew is the age at which a cached provider token is replaced. APNs
// rejects a token that is older than one hour. It asks providers not to make
// a new token more often than every 20 minutes.
const tokenRenew = 40 * time.Minute

// maxTokenLen is the maximum length of a device token, in characters.
const maxTokenLen = 200

// maxCollapseID is the maximum length of a collapse id, in bytes.
const maxCollapseID = 64

// FallbackTitle and FallbackBody are the constant alert text. The phone
// shows it if the Notification Service Extension does not replace it.
const (
	FallbackTitle = "chalk"
	FallbackBody  = "New notification"
)

// A Key is the APNs signing key of the developer team, with its key id and
// team id. It makes and caches the provider token. It is safe for concurrent
// use. Create it with [ParseKey]. The zero value is not usable.
type Key struct {
	priv   *ecdsa.PrivateKey
	keyID  string
	teamID string

	mu     sync.Mutex
	jwt    string
	issued time.Time
}

// ParseKey returns the Key that p8, keyID, and teamID describe. p8 is the
// .p8 file of Apple, either as PEM or as the bare base64 of its body, so it
// fits on one line of an environment file. The key must be a PKCS#8 P-256
// key. keyID and teamID must each be 10 letters and digits.
func ParseKey(p8, keyID, teamID string) (*Key, error) {
	if !isID(keyID) {
		return nil, errors.New("apns: key id must be 10 letters and digits")
	}
	if !isID(teamID) {
		return nil, errors.New("apns: team id must be 10 letters and digits")
	}
	der, err := keyDER(p8)
	if err != nil {
		return nil, err
	}
	parsed, err := x509.ParsePKCS8PrivateKey(der)
	if err != nil {
		return nil, fmt.Errorf("apns: private key: %w", err)
	}
	priv, ok := parsed.(*ecdsa.PrivateKey)
	if !ok || priv.Curve != elliptic.P256() {
		return nil, errors.New("apns: private key must be a P-256 key")
	}
	return &Key{priv: priv, keyID: keyID, teamID: teamID}, nil
}

// keyDER returns the DER bytes of p8. If p8 holds a PEM header, keyDER
// decodes the PEM block. Otherwise it decodes p8 as base64 and ignores white
// space.
func keyDER(p8 string) ([]byte, error) {
	text := strings.TrimSpace(p8)
	if strings.Contains(text, "-----BEGIN") {
		block, _ := pem.Decode([]byte(text))
		if block == nil {
			return nil, errors.New("apns: private key: bad PEM")
		}
		return block.Bytes, nil
	}
	der, err := base64.StdEncoding.DecodeString(strings.Join(strings.Fields(text), ""))
	if err != nil {
		return nil, fmt.Errorf("apns: private key: %w", err)
	}
	return der, nil
}

// isID reports whether s is a key id or team id of Apple: exactly 10 ASCII
// letters and digits.
func isID(s string) bool {
	if len(s) != 10 {
		return false
	}
	for _, r := range s {
		if !(r >= '0' && r <= '9' || r >= 'A' && r <= 'Z' || r >= 'a' && r <= 'z') {
			return false
		}
	}
	return true
}

// authorization returns the value of the authorization header for time now.
// It reuses the cached provider token. It signs a new token if none exists,
// if the cached token is at least tokenRenew old, or if now is before the
// time of issue (the clock went back).
func (k *Key) authorization(now time.Time) (string, error) {
	k.mu.Lock()
	defer k.mu.Unlock()
	if k.jwt == "" || now.Sub(k.issued) >= tokenRenew || now.Before(k.issued) {
		jwt, err := k.sign(now)
		if err != nil {
			return "", err
		}
		k.jwt, k.issued = jwt, now
	}
	return "bearer " + k.jwt, nil
}

// forget drops the cached provider token if authz is the header value that
// it made. A later send then signs a new token. Another goroutine that has
// already replaced the token keeps its new token.
func (k *Key) forget(authz string) {
	k.mu.Lock()
	defer k.mu.Unlock()
	if "bearer "+k.jwt == authz {
		k.jwt = ""
	}
}

// sign returns a new provider token: an ES256 JWT with the header fields
// alg and kid, and the claims iss (the team id) and iat (now, in Unix
// seconds).
func (k *Key) sign(now time.Time) (string, error) {
	b64 := base64.RawURLEncoding
	header, err := json.Marshal(struct {
		Alg string `json:"alg"`
		Kid string `json:"kid"`
	}{"ES256", k.keyID})
	if err != nil {
		return "", err
	}
	claims, err := json.Marshal(struct {
		Iss string `json:"iss"`
		Iat int64  `json:"iat"`
	}{k.teamID, now.Unix()})
	if err != nil {
		return "", err
	}
	signed := b64.EncodeToString(header) + "." + b64.EncodeToString(claims)
	digest := sha256.Sum256([]byte(signed))
	r, s, err := ecdsa.Sign(rand.Reader, k.priv, digest[:])
	if err != nil {
		return "", fmt.Errorf("apns: sign provider token: %w", err)
	}
	sig := make([]byte, 64)
	r.FillBytes(sig[:32])
	s.FillBytes(sig[32:])
	return signed + "." + b64.EncodeToString(sig), nil
}

// ValidateTopic returns an error unless topic is a bundle id: 1 to 255
// characters from letters, digits, the dot, and the hyphen.
func ValidateTopic(topic string) error {
	if topic == "" || len(topic) > 255 {
		return errors.New("apns: topic must be the bundle id of the app")
	}
	for _, r := range topic {
		if !(r >= '0' && r <= '9' || r >= 'A' && r <= 'Z' || r >= 'a' && r <= 'z' || r == '.' || r == '-') {
			return errors.New("apns: topic must be the bundle id of the app")
		}
	}
	return nil
}

// ValidateToken returns [ErrToken] unless token is 1 to 200 hexadecimal
// characters.
func ValidateToken(token string) error {
	if token == "" || len(token) > maxTokenLen {
		return ErrToken
	}
	for _, r := range token {
		if !(r >= '0' && r <= '9' || r >= 'a' && r <= 'f' || r >= 'A' && r <= 'F') {
			return ErrToken
		}
	}
	return nil
}

// A Priority is the value of the apns-priority header.
type Priority int

// The values of Priority. Send uses PriorityHigh if opts.Priority is zero.
const (
	PriorityHigh   Priority = 10
	PriorityNormal Priority = 5
)

// Options are the delivery headers of one push.
type Options struct {
	TTL        time.Duration // how long APNs keeps an undelivered push, in whole seconds
	CollapseID string        // a later push with the same id replaces this one, at most 64 bytes
	Priority   Priority      // zero means PriorityHigh
}

// A Device is what a send needs from the registration of one app install.
type Device struct {
	Token  string // the APNs device token, in hexadecimal
	P256dh []byte // the public key of the app, 65 bytes
	Auth   []byte // the authentication secret of the app, 16 bytes
}

// A Sender posts encrypted pushes to APNs. It is safe for concurrent use.
// Its HTTP client speaks HTTP/2, connects only to public addresses, and
// follows no redirect.
type Sender struct {
	key   *Key
	topic string
	base  string
	hc    *http.Client
	now   func() time.Time
}

// NewSender returns a Sender that signs with key and sends to the host of
// env. topic is the bundle id of the app. NewSender returns an error if
// [ValidateTopic] rejects topic. A push gives up after timeout. The options
// change how the client dials, for example [webpush.WithIPv4Only].
func NewSender(key *Key, topic string, env Environment, timeout time.Duration, opts ...webpush.SenderOption) (*Sender, error) {
	if err := ValidateTopic(topic); err != nil {
		return nil, err
	}
	return &Sender{
		key:   key,
		topic: topic,
		base:  env.host(),
		hc:    webpush.NewHTTP2Client(timeout, opts...),
		now:   time.Now,
	}, nil
}

// Topic returns the bundle id that the Sender sends in apns-topic.
func (s *Sender) Topic() string { return s.topic }

// notification is the JSON body of one push. It has exactly two keys. The
// aps key holds the constant fallback alert, mutable-content 1 (this makes
// iOS run the Notification Service Extension), and the default sound. The
// chalk key holds the base64 of the ciphertext. The body has no badge count,
// because the count is inside the ciphertext and the extension sets it.
type notification struct {
	APS struct {
		Alert struct {
			Title string `json:"title"`
			Body  string `json:"body"`
		} `json:"alert"`
		MutableContent int    `json:"mutable-content"`
		Sound          string `json:"sound"`
	} `json:"aps"`
	Chalk string `json:"chalk"`
}

// Send encrypts payload to dev and posts it to APNs.
//
// The body has one length for every payload, because [webpush.Encrypt]
// pads to one length. The body stays well under the APNs limit of 4096 bytes.
//
// Send sets these headers:
//
//	apns-topic       the bundle id of the Sender
//	apns-push-type   alert
//	apns-priority    10, or 5 if opts.Priority is [PriorityNormal]
//	apns-expiration  the time now plus opts.TTL as Unix time, or 0 if
//	                 opts.TTL is zero
//	apns-collapse-id opts.CollapseID, only if it is not empty
//
// It returns [ErrToken] or [ErrCollapseID] for bad input, and an error from
// [webpush.Encrypt] if the device key or secret is not valid. It returns
// [ErrGone] if the device token is gone. It returns a *[StatusError] for
// every other answer that is not status 200. If APNs answers 403 with the
// reason ExpiredProviderToken, Send also drops the cached provider token.
// Send does not retry. It reads at most 4096 bytes of the response body.
func (s *Sender) Send(ctx context.Context, dev Device, payload []byte, opts Options) error {
	if err := ValidateToken(dev.Token); err != nil {
		return err
	}
	if len(opts.CollapseID) > maxCollapseID {
		return ErrCollapseID
	}
	sealed, err := webpush.Encrypt(payload, dev.P256dh, dev.Auth)
	if err != nil {
		return err
	}
	var n notification
	n.APS.Alert.Title = FallbackTitle
	n.APS.Alert.Body = FallbackBody
	n.APS.MutableContent = 1
	n.APS.Sound = "default"
	n.Chalk = base64.StdEncoding.EncodeToString(sealed)
	body, err := json.Marshal(n)
	if err != nil {
		return err
	}
	now := s.now()
	authz, err := s.key.authorization(now)
	if err != nil {
		return err
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, s.base+"/3/device/"+strings.ToLower(dev.Token), bytes.NewReader(body))
	if err != nil {
		return ErrToken
	}
	priority := opts.Priority
	if priority == 0 {
		priority = PriorityHigh
	}
	expiration := int64(0)
	if opts.TTL > 0 {
		expiration = now.Add(opts.TTL).Unix()
	}
	req.Header.Set("Authorization", authz)
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("apns-topic", s.topic)
	req.Header.Set("apns-push-type", "alert")
	req.Header.Set("apns-priority", strconv.Itoa(int(priority)))
	req.Header.Set("apns-expiration", strconv.FormatInt(expiration, 10))
	if opts.CollapseID != "" {
		req.Header.Set("apns-collapse-id", opts.CollapseID)
	}

	resp, err := s.hc.Do(req)
	if err != nil {
		return fmt.Errorf("apns: send: %w", err)
	}
	defer resp.Body.Close()
	answer, _ := io.ReadAll(io.LimitReader(resp.Body, 4096))
	reason := webpush.ReasonFrom(answer)

	switch {
	case resp.StatusCode == http.StatusOK:
		return nil
	case resp.StatusCode == http.StatusGone,
		resp.StatusCode == http.StatusBadRequest && (reason == "BadDeviceToken" || reason == "DeviceTokenNotForTopic"):
		return fmt.Errorf("%w (%d %s)", ErrGone, resp.StatusCode, reason)
	case resp.StatusCode == http.StatusForbidden && reason == "ExpiredProviderToken":
		s.key.forget(authz)
	}
	return &StatusError{
		Code:       resp.StatusCode,
		RetryAfter: resp.Header.Get("Retry-After"),
		Reason:     reason,
	}
}
