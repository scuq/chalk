package config

import (
	"testing"
	"time"
)

func TestOplogDefaults(t *testing.T) {
	c := Default()
	if !c.Oplog.SecurityEvents {
		t.Error("security events must default on; they are rare and are the whole point of 85-1")
	}
	// The privacy default. If this ever flips, it is a decision someone has to
	// make on purpose, not a diff nobody noticed.
	if c.Oplog.SnapshotInterval != 0 {
		t.Errorf("connection snapshot must default OFF, got %s", c.Oplog.SnapshotInterval)
	}
	if c.Oplog.SlowRequest != 2*time.Second {
		t.Errorf("slow-request threshold = %s, want 2s", c.Oplog.SlowRequest)
	}
}

func TestOplogApplyEnv(t *testing.T) {
	t.Setenv("CHALK_OPLOG_SECURITY", "false")
	t.Setenv("CHALK_OPLOG_SNAPSHOT_INTERVAL", "5m")
	t.Setenv("CHALK_OPLOG_SLOW_REQUEST", "500ms")

	c := Default()
	c.applyEnv()

	if c.Oplog.SecurityEvents {
		t.Error("CHALK_OPLOG_SECURITY=false did not disable security events")
	}
	if c.Oplog.SnapshotInterval != 5*time.Minute {
		t.Errorf("snapshot interval = %s, want 5m", c.Oplog.SnapshotInterval)
	}
	if c.Oplog.SlowRequest != 500*time.Millisecond {
		t.Errorf("slow request = %s, want 500ms", c.Oplog.SlowRequest)
	}
}

// An unparseable duration must leave the default standing rather than zero it.
// Zeroing SlowRequest would silently disable the feature the operator was
// trying to tune, which is the worst possible reading of a typo.
func TestOplogApplyEnvIgnoresGarbage(t *testing.T) {
	t.Setenv("CHALK_OPLOG_SLOW_REQUEST", "two seconds")
	t.Setenv("CHALK_OPLOG_SNAPSHOT_INTERVAL", "wednesday")

	c := Default()
	c.applyEnv()

	if c.Oplog.SlowRequest != 2*time.Second {
		t.Errorf("garbage slow-request value changed the default to %s", c.Oplog.SlowRequest)
	}
	if c.Oplog.SnapshotInterval != 0 {
		t.Errorf("garbage snapshot value changed the default to %s", c.Oplog.SnapshotInterval)
	}
}

// "0" is what chalkctl backfills for the snapshot, so it has to parse to "off"
// rather than fall through to the unparseable branch.
func TestOplogSnapshotZeroIsOff(t *testing.T) {
	t.Setenv("CHALK_OPLOG_SNAPSHOT_INTERVAL", "0")
	c := Default()
	c.applyEnv()
	if c.Oplog.SnapshotInterval != 0 {
		t.Errorf("snapshot interval = %s, want 0 (off)", c.Oplog.SnapshotInterval)
	}
	if err := c.Oplog.Validate(); err != nil {
		t.Errorf("0 must validate as off: %v", err)
	}
}

func TestOplogValidate(t *testing.T) {
	tests := []struct {
		name    string
		cfg     OplogConfig
		wantErr bool
	}{
		{"defaults", defaultOplogConfig(), false},
		{"snapshot off", OplogConfig{SnapshotInterval: 0, SlowRequest: time.Second}, false},
		{"snapshot 5m", OplogConfig{SnapshotInterval: 5 * time.Minute}, false},
		{"snapshot 1m floor", OplogConfig{SnapshotInterval: time.Minute}, false},
		{"snapshot below floor", OplogConfig{SnapshotInterval: 10 * time.Second}, true},
		{"snapshot negative", OplogConfig{SnapshotInterval: -time.Minute}, true},
		{"slow request off", OplogConfig{SlowRequest: 0}, false},
		{"slow request negative", OplogConfig{SlowRequest: -time.Second}, true},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			err := tt.cfg.Validate()
			if tt.wantErr && err == nil {
				t.Error("want error, got nil")
			}
			if !tt.wantErr && err != nil {
				t.Errorf("want nil, got %v", err)
			}
		})
	}
}
