package config

import (
	"errors"
	"fmt"
	"os"
	"strings"

	"github.com/scuq/chalk/internal/apns"
	"github.com/scuq/chalk/internal/webpush"
)

// PushConfig holds the push settings: Web Push (phase 65,
// docs/phases/PHASE-65-PUSH.md) and APNs (phase 136). All settings come from
// environment variables:
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
//	APNs        the settings of the Apple Push Notification service. See
//	            [APNsConfig].
//
// The three VAPID values are necessary only if Enabled is true. The APNs
// values are validated only if Enabled is true, and they are optional.
type PushConfig struct {
	Enabled    bool
	PublicKey  string
	PrivateKey string
	Subject    string
	APNs       APNsConfig
}

// An APNsConfig holds the settings of the Apple Push Notification service
// (phase 136, docs/phases/PHASE-136-IOS.md). All settings come from
// environment variables:
//
//	Key          the .p8 key of Apple, as PEM or as the bare base64 of its
//	             body. CHALK_APNS_KEY.
//	KeyID        the 10-character key id. CHALK_APNS_KEY_ID.
//	TeamID       the 10-character team id. CHALK_APNS_TEAM_ID.
//	Topic        the bundle id of the app. CHALK_APNS_TOPIC.
//	Environment  "production" or "sandbox". CHALK_APNS_ENV, default
//	             production.
//
// Key, KeyID, TeamID, and Topic must all be set, or none of them.
// 136-4a: chalkd does not use these values yet, so they have no effect.
type APNsConfig struct {
	Key         string
	KeyID       string
	TeamID      string
	Topic       string
	Environment string
}

// Configured reports whether at least one of Key, KeyID, TeamID, and Topic is
// set. Environment alone does not count.
func (a APNsConfig) Configured() bool {
	return a.Key != "" || a.KeyID != "" || a.TeamID != "" || a.Topic != ""
}

// Validate returns an error if the settings are partly set or not usable.
// If none of Key, KeyID, TeamID, and Topic is set, it returns nil. Otherwise
// all four must be set, the key must parse, the topic must be a bundle id,
// and the environment must be empty, "production", or "sandbox".
func (a APNsConfig) Validate() error {
	if !a.Configured() {
		return nil
	}
	if a.Key == "" || a.KeyID == "" || a.TeamID == "" || a.Topic == "" {
		return errors.New("CHALK_APNS_KEY, CHALK_APNS_KEY_ID, CHALK_APNS_TEAM_ID and CHALK_APNS_TOPIC must all be set, or none of them")
	}
	if _, err := a.ParseKey(); err != nil {
		return fmt.Errorf("CHALK_APNS_*: %w", err)
	}
	if err := apns.ValidateTopic(a.Topic); err != nil {
		return fmt.Errorf("CHALK_APNS_TOPIC: %w", err)
	}
	if _, err := apns.ParseEnvironment(a.Environment); err != nil {
		return fmt.Errorf("CHALK_APNS_ENV: %w", err)
	}
	return nil
}

// ParseKey returns the APNs key that Key, KeyID, and TeamID describe.
func (a APNsConfig) ParseKey() (*apns.Key, error) {
	return apns.ParseKey(a.Key, a.KeyID, a.TeamID)
}

func defaultPushConfig() PushConfig { return PushConfig{} }

// applyEnv overlays CHALK_PUSH_ENABLED, CHALK_VAPID_*, and CHALK_APNS_* onto
// p. An unset variable keeps the existing value.
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
	for name, field := range map[string]*string{
		"CHALK_APNS_KEY":     &p.APNs.Key,
		"CHALK_APNS_KEY_ID":  &p.APNs.KeyID,
		"CHALK_APNS_TEAM_ID": &p.APNs.TeamID,
		"CHALK_APNS_TOPIC":   &p.APNs.Topic,
		"CHALK_APNS_ENV":     &p.APNs.Environment,
	} {
		if v, ok := os.LookupEnv(name); ok {
			*field = strings.TrimSpace(v)
		}
	}
}

// Validate returns an error if Enabled is true and the VAPID values or the
// APNs values are not usable. The private key must parse. The subject must be
// a mailto: or https: URL. The public key must belong to the private key. The
// APNs values must pass [APNsConfig.Validate]. If Enabled is false, Validate
// returns nil.
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
	return p.APNs.Validate()
}

// Key returns the VAPID key that PrivateKey and Subject describe.
func (p PushConfig) Key() (*webpush.VAPIDKey, error) {
	return webpush.ParseVAPIDKey(p.PrivateKey, p.Subject)
}
