package config

import "testing"

// Phase 42-5: the thread-inbox recency window. DB-free, so this runs in
// `go test ./internal/config/...` without a database.
//
// The window is a discovery knob, not an unread knob, so the interesting
// property is the upper bound: a window measured in years turns the
// active-window scan into "every thread in every channel I am in", which is
// exactly what the (channel_id, last_reply_ts DESC) index exists to avoid.

func TestThreadsConfig_DefaultIsTwoDays(t *testing.T) {
	c := defaultThreadsConfig()
	if c.ActiveWindowHrs != 48 {
		t.Errorf("default = %dh, want 48h", c.ActiveWindowHrs)
	}
	if got := c.ActiveWindow().Hours(); got != 48 {
		t.Errorf("ActiveWindow() = %vh, want 48h", got)
	}
	if err := c.Validate(); err != nil {
		t.Errorf("the default must validate: %v", err)
	}
}

func TestThreadsConfig_ValidateBounds(t *testing.T) {
	for _, tc := range []struct {
		name    string
		hours   int
		wantErr bool
	}{
		{"zero would mean nothing is ever active", 0, true},
		{"negative", -1, true},
		{"one hour is tight but legal", 1, false},
		{"a week", 168, false},
		{"ninety days is the ceiling", 24 * 90, false},
		{"beyond ninety days scans everything", 24*90 + 1, true},
	} {
		err := ThreadsConfig{ActiveWindowHrs: tc.hours}.Validate()
		if tc.wantErr && err == nil {
			t.Errorf("%s (%dh): want error, got nil", tc.name, tc.hours)
		}
		if !tc.wantErr && err != nil {
			t.Errorf("%s (%dh): want nil, got %v", tc.name, tc.hours, err)
		}
	}
}

func TestThreadsConfig_ApplyEnv(t *testing.T) {
	c := defaultThreadsConfig()
	t.Setenv("CHALK_THREAD_ACTIVE_WINDOW_HOURS", "72")
	c.applyEnv()
	if c.ActiveWindowHrs != 72 {
		t.Errorf("ActiveWindowHrs = %d, want 72", c.ActiveWindowHrs)
	}
}

func TestThreadsConfig_ApplyEnvKeepsDefaultOnGarbage(t *testing.T) {
	// Unparseable must leave the default standing rather than zero it, which
	// would silently mean "nothing is ever active". Same contract as envInt.
	c := defaultThreadsConfig()
	t.Setenv("CHALK_THREAD_ACTIVE_WINDOW_HOURS", "two days please")
	c.applyEnv()
	if c.ActiveWindowHrs != 48 {
		t.Errorf("ActiveWindowHrs = %d, want the default 48", c.ActiveWindowHrs)
	}
}
