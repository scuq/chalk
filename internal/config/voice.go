package config

import (
	"fmt"
	"os"
	"strconv"
	"strings"
	"time"
)

// VoiceConfig holds the Phase 30 voice/video server knobs (30-1). All are
// env-only (CHALK_VOICE_* / CHALK_TURN_* / CHALK_STUN_URLS), mirroring the
// AttachmentConfig model: a struct seeded by defaultVoiceConfig(), overlaid by
// applyEnv(), and fenced by Validate(). The wider Config embeds this as
// Config.Voice and forwards the three lifecycle calls to it.
//
// What each knob does:
//
//	Enabled          feature flag; when false the voice frames (30-2) are
//	                 rejected and no TURN creds are minted. CHALK_VOICE_ENABLED.
//	MaxParticipants  mesh hard cap; voice_join is rejected when the room holds
//	                 this many. Mesh bandwidth grows ~(N-1) per member, so this
//	                 stays SMALL. CHALK_VOICE_MAX_PARTICIPANTS.
//	ForceRelay       test knob: tells clients to set
//	                 RTCConfiguration.iceTransportPolicy='relay' so a call must
//	                 succeed using ONLY the coturn relay (the no-P2P acceptance
//	                 gate, design §7d). CHALK_VOICE_FORCE_RELAY.
//	TurnURLs         comma-separated coturn URIs
//	                 (e.g. "turn:203.0.113.7:3478?transport=udp"). Empty means
//	                 STUN-only DEGRADED mode -- most real clients will fail to
//	                 connect (design §0). CHALK_TURN_URLS.
//	TurnSecret       the coturn static-auth-secret shared with chalkd; the
//	                 TURN REST HMAC credential minter (internal/turncred) signs
//	                 usernames with it. Required when TurnURLs is set.
//	                 CHALK_TURN_SECRET.
//	TurnTTLSecs      lifetime of a minted TURN credential in seconds; expired
//	                 creds are not replayable. CHALK_TURN_TTL_SECS.
//	StunURLs         optional comma-separated explicit STUN URIs
//	                 (e.g. "stun:stun.l.google.com:19302"). CHALK_STUN_URLS.
type VoiceConfig struct {
	Enabled         bool
	MaxParticipants int
	ForceRelay      bool
	TurnURLs        string
	TurnSecret      string
	TurnTTLSecs     int
	StunURLs        string

	// 30-8 (design Addendum D): adaptive-quality knobs, delivered to the
	// client on voice_join_ack.adaptive so the mesh budget divider and the
	// tier ladder run against server policy rather than baked constants.
	//
	//	ProbeEnabled    whether clients run the pre-stream uplink probe
	//	                (POST /api/netprobe). CHALK_VOICE_PROBE_ENABLED.
	//	ProbeBytes      probe upload size cap in bytes; also the server-side
	//	                body bound on /api/netprobe. CHALK_VOICE_PROBE_BYTES.
	//	RecheckSecs     comma-separated replan tick offsets from call start,
	//	                seconds (passive getStats reads, never active tests
	//	                mid-call). CHALK_VOICE_RECHECK_SECS.
	//	UplinkHeadroom  fraction of the measured uplink the planner spends
	//	                (0 < x <= 1). CHALK_VOICE_UPLINK_HEADROOM.
	//	AudioKbps       per-peer voice reserve. CHALK_VOICE_AUDIO_KBPS.
	//	MinVideoKbps    per-copy floor before video is unsustainable.
	//	                CHALK_VOICE_MIN_VIDEO_KBPS.
	ProbeEnabled   bool
	ProbeBytes     int64
	RecheckSecs    string
	UplinkHeadroom float64
	AudioKbps      int
	MinVideoKbps   int
}

// Voice defaults. Named constants so the values appear once and are referenced
// by both defaultVoiceConfig and the doc comments above.
const (
	defaultVoiceMaxParticipants = 5
	defaultVoiceTurnTTLSecs     = 3600

	// 30-8 adaptive defaults (design D5).
	defaultVoiceProbeBytes    = 3_000_000
	defaultVoiceRecheckSecs   = "60,360,660"
	defaultVoiceHeadroom      = 0.85
	defaultVoiceAudioKbps     = 64
	defaultVoiceMinVideoKbps  = 300
	defaultVoiceProbeBytesMin = 100_000
	defaultVoiceProbeBytesMax = 50_000_000
)

func defaultVoiceConfig() VoiceConfig {
	return VoiceConfig{
		Enabled:         false,
		MaxParticipants: defaultVoiceMaxParticipants,
		ForceRelay:      false,
		TurnTTLSecs:     defaultVoiceTurnTTLSecs,

		ProbeEnabled:   true,
		ProbeBytes:     defaultVoiceProbeBytes,
		RecheckSecs:    defaultVoiceRecheckSecs,
		UplinkHeadroom: defaultVoiceHeadroom,
		AudioKbps:      defaultVoiceAudioKbps,
		MinVideoKbps:   defaultVoiceMinVideoKbps,
	}
}

// TurnTTL is the minted-credential lifetime as a duration.
func (v VoiceConfig) TurnTTL() time.Duration {
	return time.Duration(v.TurnTTLSecs) * time.Second
}

// TurnURLList splits the comma-separated TurnURLs, trimming blanks.
func (v VoiceConfig) TurnURLList() []string {
	return voiceSplitURLs(v.TurnURLs)
}

// StunURLList splits the comma-separated StunURLs, trimming blanks.
func (v VoiceConfig) StunURLList() []string {
	return voiceSplitURLs(v.StunURLs)
}

func voiceSplitURLs(s string) []string {
	parts := strings.Split(s, ",")
	out := make([]string, 0, len(parts))
	for _, p := range parts {
		if t := strings.TrimSpace(p); t != "" {
			out = append(out, t)
		}
	}
	return out
}

// applyEnv overlays CHALK_VOICE_* / CHALK_TURN_* / CHALK_STUN_URLS env vars.
// Unset/unparseable vars leave the existing (default) value untouched, the
// same contract as Config.applyEnv's envInt helper.
func (v *VoiceConfig) applyEnv() {
	if b, ok := voiceEnvBool("CHALK_VOICE_ENABLED"); ok {
		v.Enabled = b
	}
	if n, ok := voiceEnvInt("CHALK_VOICE_MAX_PARTICIPANTS"); ok {
		v.MaxParticipants = n
	}
	if b, ok := voiceEnvBool("CHALK_VOICE_FORCE_RELAY"); ok {
		v.ForceRelay = b
	}
	strBinds := []struct {
		dst *string
		key string
	}{
		{&v.TurnURLs, "CHALK_TURN_URLS"},
		{&v.TurnSecret, "CHALK_TURN_SECRET"},
		{&v.StunURLs, "CHALK_STUN_URLS"},
	}
	for _, b := range strBinds {
		if s := strings.TrimSpace(os.Getenv(b.key)); s != "" {
			*b.dst = s
		}
	}
	if n, ok := voiceEnvInt("CHALK_TURN_TTL_SECS"); ok {
		v.TurnTTLSecs = n
	}
	// 30-8 adaptive knobs.
	if b, ok := voiceEnvBool("CHALK_VOICE_PROBE_ENABLED"); ok {
		v.ProbeEnabled = b
	}
	if n, ok := voiceEnvInt("CHALK_VOICE_PROBE_BYTES"); ok {
		v.ProbeBytes = int64(n)
	}
	if s := strings.TrimSpace(os.Getenv("CHALK_VOICE_RECHECK_SECS")); s != "" {
		v.RecheckSecs = s
	}
	if s := strings.TrimSpace(os.Getenv("CHALK_VOICE_UPLINK_HEADROOM")); s != "" {
		if f, err := strconv.ParseFloat(s, 64); err == nil {
			v.UplinkHeadroom = f
		}
	}
	if n, ok := voiceEnvInt("CHALK_VOICE_AUDIO_KBPS"); ok {
		v.AudioKbps = n
	}
	if n, ok := voiceEnvInt("CHALK_VOICE_MIN_VIDEO_KBPS"); ok {
		v.MinVideoKbps = n
	}
}

// RecheckSecList parses the comma-separated RecheckSecs into positive ints,
// dropping blanks. Validate has already fenced malformed entries.
func (v VoiceConfig) RecheckSecList() []int {
	parts := strings.Split(v.RecheckSecs, ",")
	out := make([]int, 0, len(parts))
	for _, p := range parts {
		t := strings.TrimSpace(p)
		if t == "" {
			continue
		}
		if n, err := strconv.Atoi(t); err == nil && n > 0 {
			out = append(out, n)
		}
	}
	return out
}

// Validate fails loudly on nonsensical voice settings rather than letting
// chalkd run with, say, a 1-person "room" or an unsignable TURN setup.
// STUN-only (TurnURLs empty) is permitted but DEGRADED (design §0/§5); the
// server logs that at startup rather than failing here.
func (v VoiceConfig) Validate() error {
	if v.MaxParticipants < 2 || v.MaxParticipants > 16 {
		return fmt.Errorf("CHALK_VOICE_MAX_PARTICIPANTS must be in 2..16 (got %d; mesh bandwidth grows per-peer, keep rooms small)", v.MaxParticipants)
	}
	if v.TurnTTLSecs < 60 {
		return fmt.Errorf("CHALK_TURN_TTL_SECS must be >= 60 (got %d)", v.TurnTTLSecs)
	}
	if strings.TrimSpace(v.TurnURLs) != "" && strings.TrimSpace(v.TurnSecret) == "" {
		return fmt.Errorf("CHALK_TURN_SECRET is required when CHALK_TURN_URLS is set (coturn static-auth-secret; the HMAC credential minter cannot sign without it)")
	}
	// 30-8 adaptive knobs.
	if v.ProbeBytes < defaultVoiceProbeBytesMin || v.ProbeBytes > defaultVoiceProbeBytesMax {
		return fmt.Errorf("CHALK_VOICE_PROBE_BYTES must be in %d..%d (got %d)", defaultVoiceProbeBytesMin, defaultVoiceProbeBytesMax, v.ProbeBytes)
	}
	if v.UplinkHeadroom <= 0 || v.UplinkHeadroom > 1 {
		return fmt.Errorf("CHALK_VOICE_UPLINK_HEADROOM must be in (0,1] (got %g)", v.UplinkHeadroom)
	}
	if v.AudioKbps < 16 || v.AudioKbps > 510 {
		return fmt.Errorf("CHALK_VOICE_AUDIO_KBPS must be in 16..510 (got %d; Opus tops out at 510)", v.AudioKbps)
	}
	if v.MinVideoKbps < 50 || v.MinVideoKbps > 2000 {
		return fmt.Errorf("CHALK_VOICE_MIN_VIDEO_KBPS must be in 50..2000 (got %d)", v.MinVideoKbps)
	}
	if len(v.RecheckSecList()) == 0 {
		return fmt.Errorf("CHALK_VOICE_RECHECK_SECS must contain at least one positive integer (got %q)", v.RecheckSecs)
	}
	for _, p := range strings.Split(v.RecheckSecs, ",") {
		t := strings.TrimSpace(p)
		if t == "" {
			continue
		}
		if n, err := strconv.Atoi(t); err != nil || n <= 0 {
			return fmt.Errorf("CHALK_VOICE_RECHECK_SECS entries must be positive integers (got %q)", t)
		}
	}
	return nil
}

// voiceEnvInt mirrors config.envInt but is kept local so VoiceConfig is a
// self-contained unit (its own file added by 30-1, no edits to config.go's
// helpers) -- the same pattern as attachEnvInt.
func voiceEnvInt(key string) (int, bool) {
	s := strings.TrimSpace(os.Getenv(key))
	if s == "" {
		return 0, false
	}
	n, err := strconv.Atoi(s)
	if err != nil {
		return 0, false
	}
	return n, true
}

// voiceEnvBool reads a boolean env var ("true"/"1"/"yes"/"on" => true,
// "false"/"0"/"no"/"off" => false; anything else leaves the default).
func voiceEnvBool(key string) (bool, bool) {
	s := strings.ToLower(strings.TrimSpace(os.Getenv(key)))
	switch s {
	case "":
		return false, false
	case "1", "true", "yes", "on":
		return true, true
	case "0", "false", "no", "off":
		return false, true
	}
	return false, false
}
