package config

import (
	"errors"
	"fmt"
	"os"
	"strings"

	"github.com/scuq/chalk/internal/webpush"
)

// PushConfig holds the Web Push settings (phase 65,
// docs/phases/PHASE-65-PUSH.md). All settings come from environment variables:
//
//	Enabled     master switch. If false, chalkd sends no push and
//	            /api/auth/config reports push_enabled=false.
//	            CHALK_PUSH_ENABLED, default false.
//	PublicKey   VAPID public key, base64url of the 65-byte point.
//	            CHALK_VAPID_PUBLIC_KEY.
//	PrivateKey  VAPID private key, base64url of the 32-byte scalar.
//	            CHALK_VAPID_PRIVATE_KEY.
//	Subject     the operator contact that goes into every VAPID token, a
//	            mailto: or https: URL. CHALK_VAPID_SUBJECT.
//
// The three VAPID values are necessary only if Enabled is true.
type PushConfig struct {
	Enabled    bool
	PublicKey  string
	PrivateKey string
	Subject    string
}

func defaultPushConfig() PushConfig { return PushConfig{} }

// applyEnv overlays CHALK_PUSH_ENABLED and CHALK_VAPID_* onto p. An unset
// variable keeps the existing value.
func (p *PushConfig) applyEnv() {
	if b, ok := envBool("CHALK_PUSH_ENABLED"); ok {
		p.Enabled = b
	}
	if v, ok := os.LookupEnv("CHALK_VAPID_PUBLIC_KEY"); ok {
		p.PublicKey = strings.TrimSpace(v)
	}
	if v, ok := os.LookupEnv("CHALK_VAPID_PRIVATE_KEY"); ok {
		p.PrivateKey = strings.TrimSpace(v)
	}
	if v, ok := os.LookupEnv("CHALK_VAPID_SUBJECT"); ok {
		p.Subject = strings.TrimSpace(v)
	}
}

// Validate returns an error if Enabled is true and the VAPID values are not
// usable. The private key must parse. The subject must be a mailto: or https:
// URL. The public key must belong to the private key. If Enabled is false,
// Validate returns nil.
func (p PushConfig) Validate() error {
	if !p.Enabled {
		return nil
	}
	if p.PublicKey == "" || p.PrivateKey == "" || p.Subject == "" {
		return errors.New("CHALK_PUSH_ENABLED=true needs CHALK_VAPID_PUBLIC_KEY, CHALK_VAPID_PRIVATE_KEY and CHALK_VAPID_SUBJECT")
	}
	k, err := p.Key()
	if err != nil {
		return fmt.Errorf("CHALK_VAPID_*: %w", err)
	}
	if k.PublicKey() != strings.TrimRight(p.PublicKey, "=") {
		return errors.New("CHALK_VAPID_PUBLIC_KEY does not belong to CHALK_VAPID_PRIVATE_KEY")
	}
	return nil
}

// Key returns the VAPID key that PrivateKey and Subject describe.
func (p PushConfig) Key() (*webpush.VAPIDKey, error) {
	return webpush.ParseVAPIDKey(p.PrivateKey, p.Subject)
}
