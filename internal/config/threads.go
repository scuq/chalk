package config

import (
	"fmt"
	"os"
	"strconv"
	"strings"
	"time"
)

// ThreadsConfig holds the server-wide thread-inbox knobs (42-5), following the
// AttachmentConfig model: a struct seeded by defaultThreadsConfig(), overlaid by
// applyEnv(), and fenced by Validate(). Config embeds it as Config.Threads and
// forwards the three lifecycle calls.
//
//	ActiveWindowHrs  how far back a reply still counts as "active" for the
//	                 thread inbox's discovery half.
//	                 CHALK_THREAD_ACTIVE_WINDOW_HOURS.
type ThreadsConfig struct {
	// ActiveWindowHrs bounds the "active threads" half of the thread inbox: a
	// thread whose newest reply is younger than this is surfaced whether or not
	// the viewer took part in it.
	//
	// It does NOT define unread. A thread that went quiet a week ago with a
	// reply you have not read is still surfaced, through the involved-and-unread
	// half of the query, which has no age bound at all. This knob controls how
	// much *discovery* the inbox does -- never whether something can be silently
	// dropped.
	ActiveWindowHrs int
}

// Two days: long enough to cover "what happened since yesterday", short enough
// that the discovery list stays genuinely current. Nothing is lost at the edge
// -- see the note on ActiveWindowHrs.
const defaultThreadActiveWindowHrs = 48

func defaultThreadsConfig() ThreadsConfig {
	return ThreadsConfig{ActiveWindowHrs: defaultThreadActiveWindowHrs}
}

// ActiveWindow is the recency window as a duration.
func (t ThreadsConfig) ActiveWindow() time.Duration {
	return time.Duration(t.ActiveWindowHrs) * time.Hour
}

// applyEnv overlays CHALK_THREAD_* env vars onto t. Unset or unparseable leaves
// the default, the same contract as the rest of config.
func (t *ThreadsConfig) applyEnv() {
	if n, ok := threadEnvInt("CHALK_THREAD_ACTIVE_WINDOW_HOURS"); ok {
		t.ActiveWindowHrs = n
	}
}

// Validate fences the window at both ends. The upper bound is the interesting
// one: a window measured in years turns the active-window scan into "every
// thread in every channel I am in", which is exactly what the
// (channel_id, last_reply_ts DESC) index exists to avoid.
func (t ThreadsConfig) Validate() error {
	if t.ActiveWindowHrs < 1 {
		return fmt.Errorf("CHALK_THREAD_ACTIVE_WINDOW_HOURS must be >= 1 (got %d)", t.ActiveWindowHrs)
	}
	if t.ActiveWindowHrs > 24*90 {
		return fmt.Errorf("CHALK_THREAD_ACTIVE_WINDOW_HOURS must be <= %d (90 days) (got %d)",
			24*90, t.ActiveWindowHrs)
	}
	return nil
}

// threadEnvInt mirrors config.envInt, kept local so ThreadsConfig is a
// self-contained unit -- the same reason attachEnvInt exists.
func threadEnvInt(key string) (int, bool) {
	v := strings.TrimSpace(os.Getenv(key))
	if v == "" {
		return 0, false
	}
	n, err := strconv.Atoi(v)
	if err != nil {
		return 0, false
	}
	return n, true
}
