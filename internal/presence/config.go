package presence

import (
	"os"
	"time"
)

// LoopConfigFromEnv builds a LoopConfig by overlaying environment-
// variable overrides on DefaultLoopConfig. Unknown or unparseable
// values are silently ignored (the default stays in effect). This is
// intended for test-only tuning: the bootstrap phase script can set
// these to shrink production-default windows to sub-second so the
// janitor test runs in under 10 seconds instead of 25+.
//
// Recognized variables (durations parseable by time.ParseDuration):
//
//	CHALK_PRESENCE_HEARTBEAT_INTERVAL  -- default 5s
//	CHALK_PRESENCE_JANITOR_INTERVAL    -- default 10s
//	CHALK_PRESENCE_INSTANCE_STALENESS  -- default 15s
//	CHALK_PRESENCE_DEMOTION_INTERVAL   -- default 5s
//
// Production deployments should NOT set these; the defaults are chosen
// for stability. Setting InstanceStaleness too low risks reaping
// healthy instances during transient PG slowness. Setting it lower
// than 2 * HeartbeatInterval is an antipattern.
//
// LoopConfigFromEnv never returns a config with zero-or-negative
// intervals; if an env var parses to <= 0, the default is kept.
func LoopConfigFromEnv() LoopConfig {
	cfg := DefaultLoopConfig()
	apply := func(envName string, dst *time.Duration) {
		v := os.Getenv(envName)
		if v == "" {
			return
		}
		d, err := time.ParseDuration(v)
		if err != nil || d <= 0 {
			return
		}
		*dst = d
	}
	apply("CHALK_PRESENCE_HEARTBEAT_INTERVAL", &cfg.HeartbeatInterval)
	apply("CHALK_PRESENCE_JANITOR_INTERVAL", &cfg.JanitorInterval)
	apply("CHALK_PRESENCE_INSTANCE_STALENESS", &cfg.InstanceStaleness)
	apply("CHALK_PRESENCE_DEMOTION_INTERVAL", &cfg.DemotionInterval)
	return cfg
}
