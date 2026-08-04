package config

import (
	"fmt"
	"os"
	"strings"
	"time"
)

// OplogConfig holds the operational-logging knobs (85-1, CHALK_OPLOG_*).
//
// chalkd is nearly silent once it is up: it prints its configuration, then
// nothing but errors. That is fine until something goes wrong on a box nobody
// can attach a debugger to -- an account that will not log in, a client that
// feels slow, a login flood the operator only hears about from the person
// being locked out. These three knobs buy that visibility back.
//
// Each is shaped so its log volume is bounded by something other than traffic:
// security events are rare by nature and throttled per IP on top, the snapshot
// fires on a timer, and the slow-request line only appears for a request that
// already took seconds. Nothing here logs per message, per frame or per
// healthy request.
type OplogConfig struct {
	// SecurityEvents logs authentication outcomes an operator would want to
	// see: TOTP lockouts, rate-limit denials, failed and successful logins,
	// attempts against blocked or deleted accounts.
	//
	// The lines carry the client IP, which is the point -- "someone is
	// guessing passwords" without an address is not actionable. They do not
	// carry anything an attacker could not already supply themselves.
	//
	// CHALK_OPLOG_SECURITY, default true.
	SecurityEvents bool

	// SnapshotInterval is how often to log who is connected right now: one
	// summary line with connection counts and database health, then a line
	// per connection naming the user, device, remote IP, connection age and
	// WebSocket round-trip.
	//
	// Off by default, and that is a privacy decision rather than a cost one.
	// chalk encrypts message content end-to-end; a rolling record of which
	// account was online, when, and from which address is precisely the
	// metadata that survives that encryption, and it would sit in an
	// unencrypted log file with a longer retention than anyone intends. An
	// operator who wants it can have it; no deployment gets it by accident.
	//
	// CHALK_OPLOG_SNAPSHOT_INTERVAL, a duration ("5m"), default 0 (off).
	SnapshotInterval time.Duration

	// SlowRequest is the threshold above which one HTTP request logs one
	// line. Every request pays a time.Now and a comparison for this; a
	// healthy server logs nothing at all.
	//
	// CHALK_OPLOG_SLOW_REQUEST, a duration, default 2s. 0 disables it.
	SlowRequest time.Duration
}

// Slow enough that no request chalk makes on purpose reaches it -- an Argon2id
// login pass is ~200ms, the largest attachment finalize well under a second --
// so a line here always means something is actually wrong.
const defaultOplogSlowRequest = 2 * time.Second

func defaultOplogConfig() OplogConfig {
	return OplogConfig{
		SecurityEvents: true,
		SlowRequest:    defaultOplogSlowRequest,
	}
}

// applyEnv overlays CHALK_OPLOG_* onto o. Unset or unparseable leaves the
// default, the same contract as the rest of config.
func (o *OplogConfig) applyEnv() {
	if b, ok := envBool("CHALK_OPLOG_SECURITY"); ok {
		o.SecurityEvents = b
	}
	if d, ok := oplogEnvDuration("CHALK_OPLOG_SNAPSHOT_INTERVAL"); ok {
		o.SnapshotInterval = d
	}
	if d, ok := oplogEnvDuration("CHALK_OPLOG_SLOW_REQUEST"); ok {
		o.SlowRequest = d
	}
}

// Validate fences the two durations. The snapshot floor is the interesting
// one: the snapshot walks every connection and pings the database, so a
// ten-second interval turns a diagnostic into a log flood plus standing load.
func (o OplogConfig) Validate() error {
	if o.SnapshotInterval < 0 {
		return fmt.Errorf("CHALK_OPLOG_SNAPSHOT_INTERVAL must be >= 0 (got %s)", o.SnapshotInterval)
	}
	if o.SnapshotInterval > 0 && o.SnapshotInterval < time.Minute {
		return fmt.Errorf("CHALK_OPLOG_SNAPSHOT_INTERVAL must be 0 (off) or >= 1m (got %s)",
			o.SnapshotInterval)
	}
	if o.SlowRequest < 0 {
		return fmt.Errorf("CHALK_OPLOG_SLOW_REQUEST must be >= 0 (got %s)", o.SlowRequest)
	}
	return nil
}

// oplogEnvDuration reads a duration env var, keeping OplogConfig a
// self-contained unit for the same reason attachEnvInt and threadEnvInt exist.
func oplogEnvDuration(key string) (time.Duration, bool) {
	v := strings.TrimSpace(os.Getenv(key))
	if v == "" {
		return 0, false
	}
	d, err := time.ParseDuration(v)
	if err != nil {
		return 0, false
	}
	return d, true
}
