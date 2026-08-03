package config

// EphemeralConfig holds the phase-80 ephemeral-voice-channel knobs, following
// the ThreadsConfig model: seeded by defaultEphemeralConfig(), overlaid by
// applyEnv(), fenced by Validate(). Config embeds it as Config.Ephemeral.
//
//	Enabled           feature switch: create/mint/redeem all answer disabled
//	                  when off. CHALK_EPHEMERAL_ENABLED, default true.
//	MaxTTLHours       cap on a channel's lifetime, chosen at creation.
//	                  CHALK_EPHEMERAL_MAX_TTL_HOURS, default 720 (1 month).
//	InviteMaxTTLHours cap on a magic link's lifetime. Hard-capped at 24:
//	                  whoever holds a link IS the guest, so a link must not
//	                  outlive a day no matter what the operator asks for.
//	                  CHALK_EPHEMERAL_INVITE_MAX_TTL_HOURS, default 24.
//	MaxGuests         most guests a channel can mint invites for. The voice
//	                  mesh cap (CHALK_VOICE_MAX_PARTICIPANTS) still governs
//	                  who fits in the call itself.
//	                  CHALK_EPHEMERAL_MAX_GUESTS, default 8.
//
// Note the feature also needs CHALK_DB_URL_GUEST (the chalk_guest pool);
// that is a top-level Config field beside CHALK_DB_URL, not part of this
// struct, and the server logs the feature off when it is absent.

import (
	"fmt"
	"time"
)

type EphemeralConfig struct {
	Enabled           bool
	MaxTTLHours       int
	InviteMaxTTLHours int
	MaxGuests         int
}

// inviteTTLHardCapHours is the ceiling Validate enforces on
// InviteMaxTTLHours. A forwarded or shoulder-surfed link is a full
// credential; 24 h is the accepted honest residual, not a tunable.
const inviteTTLHardCapHours = 24

func defaultEphemeralConfig() EphemeralConfig {
	return EphemeralConfig{
		Enabled:           true,
		MaxTTLHours:       720,
		InviteMaxTTLHours: inviteTTLHardCapHours,
		MaxGuests:         8,
	}
}

// MaxTTL / InviteMaxTTL as durations.
func (e EphemeralConfig) MaxTTL() time.Duration {
	return time.Duration(e.MaxTTLHours) * time.Hour
}

func (e EphemeralConfig) InviteMaxTTL() time.Duration {
	return time.Duration(e.InviteMaxTTLHours) * time.Hour
}

// applyEnv overlays CHALK_EPHEMERAL_* env vars onto e. Unset or unparseable
// leaves the default, the same contract as the rest of config.
func (e *EphemeralConfig) applyEnv() {
	if v, ok := envBool("CHALK_EPHEMERAL_ENABLED"); ok {
		e.Enabled = v
	}
	if n, ok := envInt("CHALK_EPHEMERAL_MAX_TTL_HOURS"); ok {
		e.MaxTTLHours = n
	}
	if n, ok := envInt("CHALK_EPHEMERAL_INVITE_MAX_TTL_HOURS"); ok {
		e.InviteMaxTTLHours = n
	}
	if n, ok := envInt("CHALK_EPHEMERAL_MAX_GUESTS"); ok {
		e.MaxGuests = n
	}
}

// Validate fails loudly on nonsense. The invite-TTL hard cap is a refusal,
// not a clamp: an operator who configured 72 h should learn the ceiling at
// boot, not discover links dying three times earlier than expected.
func (e EphemeralConfig) Validate() error {
	if !e.Enabled {
		return nil
	}
	if e.MaxTTLHours < 1 {
		return fmt.Errorf("CHALK_EPHEMERAL_MAX_TTL_HOURS must be >= 1 (got %d)", e.MaxTTLHours)
	}
	if e.InviteMaxTTLHours < 1 {
		return fmt.Errorf("CHALK_EPHEMERAL_INVITE_MAX_TTL_HOURS must be >= 1 (got %d)", e.InviteMaxTTLHours)
	}
	if e.InviteMaxTTLHours > inviteTTLHardCapHours {
		return fmt.Errorf("CHALK_EPHEMERAL_INVITE_MAX_TTL_HOURS is hard-capped at %d (got %d): a magic link is a bearer credential",
			inviteTTLHardCapHours, e.InviteMaxTTLHours)
	}
	if e.MaxGuests < 1 {
		return fmt.Errorf("CHALK_EPHEMERAL_MAX_GUESTS must be >= 1 (got %d)", e.MaxGuests)
	}
	return nil
}
