package webpush

import (
	"crypto/ecdsa"
	"crypto/elliptic"
	"crypto/rand"
	"crypto/sha256"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"net/url"
	"strings"
	"sync"
	"time"
)

var b64 = base64.RawURLEncoding

// vapidTTL is the lifetime of one VAPID token. RFC 8292 sets a maximum of
// 24 hours.
const vapidTTL = 12 * time.Hour

// vapidRenew is the time before its expiry at which a cached token is
// replaced.
const vapidRenew = time.Hour

// maxVAPIDAudiences is the size limit of the token cache. An endpoint host
// comes from a client, so the number of hosts has no natural limit. When the
// cache is full, authorization empties it before it adds a token.
const maxVAPIDAudiences = 64

// A VAPIDKey is the P-256 key pair that identifies this server to the push
// services, with the contact URL that goes into every token.
// It is safe for concurrent use. Create it with ParseVAPIDKey. The zero
// value is not usable.
type VAPIDKey struct {
	priv    *ecdsa.PrivateKey
	public  string // base64url of the 65-byte public point
	subject string

	mu     sync.Mutex
	tokens map[string]vapidToken // by audience
}

// A vapidToken is one signed JWT and the time it expires.
type vapidToken struct {
	jwt     string
	expires time.Time
}

// GenerateVAPIDKey returns a new key pair as base64url strings: the 32-byte
// private scalar and the 65-byte uncompressed public point.
func GenerateVAPIDKey() (private, public string, err error) {
	priv, err := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	if err != nil {
		return "", "", fmt.Errorf("webpush: generate vapid key: %w", err)
	}
	privBytes, err := priv.Bytes()
	if err != nil {
		return "", "", err
	}
	pubBytes, err := priv.PublicKey.Bytes()
	if err != nil {
		return "", "", err
	}
	return b64.EncodeToString(privBytes), b64.EncodeToString(pubBytes), nil
}

// ParseVAPIDKey builds a VAPIDKey from the base64url private scalar and the
// subject. The subject must be a mailto: or https: URL, because the push
// services reject a token without one.
func ParseVAPIDKey(private, subject string) (*VAPIDKey, error) {
	raw, err := b64.DecodeString(strings.TrimRight(private, "="))
	if err != nil {
		return nil, fmt.Errorf("webpush: vapid private key: %w", err)
	}
	priv, err := ecdsa.ParseRawPrivateKey(elliptic.P256(), raw)
	if err != nil {
		return nil, fmt.Errorf("webpush: vapid private key: %w", err)
	}
	if err := ValidateSubject(subject); err != nil {
		return nil, err
	}
	pubBytes, err := priv.PublicKey.Bytes()
	if err != nil {
		return nil, err
	}
	return &VAPIDKey{
		priv:    priv,
		public:  b64.EncodeToString(pubBytes),
		subject: subject,
		tokens:  map[string]vapidToken{},
	}, nil
}

// ValidateSubject reports an error unless subject is a mailto: URL with an
// address or an https: URL with a host.
func ValidateSubject(subject string) error {
	u, err := url.Parse(subject)
	if err != nil {
		return fmt.Errorf("webpush: vapid subject: %w", err)
	}
	switch {
	case u.Scheme == "mailto" && u.Opaque != "":
		return nil
	case u.Scheme == "https" && u.Host != "":
		return nil
	}
	return errors.New("webpush: vapid subject must be a mailto: or https: URL")
}

// PublicKey returns the base64url public point. The browser needs it as the
// applicationServerKey of a subscription.
func (k *VAPIDKey) PublicKey() string { return k.public }

// authorization returns the Authorization header value for a request to
// audience, the origin of the endpoint. A token is reused for one audience
// until it is near its expiry.
func (k *VAPIDKey) authorization(audience string, now time.Time) (string, error) {
	k.mu.Lock()
	defer k.mu.Unlock()
	tok, ok := k.tokens[audience]
	if !ok || now.After(tok.expires.Add(-vapidRenew)) {
		expires := now.Add(vapidTTL)
		jwt, err := k.sign(audience, expires)
		if err != nil {
			return "", err
		}
		if len(k.tokens) >= maxVAPIDAudiences {
			clear(k.tokens)
		}
		tok = vapidToken{jwt: jwt, expires: expires}
		k.tokens[audience] = tok
	}
	return "vapid t=" + tok.jwt + ", k=" + k.public, nil
}

// sign returns an ES256 JWT with the claims aud, exp and sub.
func (k *VAPIDKey) sign(audience string, expires time.Time) (string, error) {
	header := b64.EncodeToString([]byte(`{"typ":"JWT","alg":"ES256"}`))
	claims, err := json.Marshal(struct {
		Aud string `json:"aud"`
		Exp int64  `json:"exp"`
		Sub string `json:"sub"`
	}{audience, expires.Unix(), k.subject})
	if err != nil {
		return "", err
	}
	signed := header + "." + b64.EncodeToString(claims)
	digest := sha256.Sum256([]byte(signed))
	r, s, err := ecdsa.Sign(rand.Reader, k.priv, digest[:])
	if err != nil {
		return "", fmt.Errorf("webpush: sign vapid token: %w", err)
	}
	// JWS wants r and s as two fixed 32-byte integers, not ASN.1.
	sig := make([]byte, 64)
	r.FillBytes(sig[:32])
	s.FillBytes(sig[32:])
	return signed + "." + b64.EncodeToString(sig), nil
}
