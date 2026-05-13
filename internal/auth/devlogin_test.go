package auth

import (
	"strings"
	"testing"
)

func TestIsDevModeOff(t *testing.T) {
	for _, v := range []string{"", "0", "false", "no", "off", "FALSE", "garbage", " "} {
		t.Setenv("CHALK_DEV", v)
		if IsDevMode() {
			t.Errorf("IsDevMode for CHALK_DEV=%q: got true, want false", v)
		}
	}
}

func TestIsDevModeOn(t *testing.T) {
	for _, v := range []string{"1", "true", "yes", "on", "TRUE", "Yes", " on "} {
		t.Setenv("CHALK_DEV", v)
		if !IsDevMode() {
			t.Errorf("IsDevMode for CHALK_DEV=%q: got false, want true", v)
		}
	}
}

func TestDevModeBanner(t *testing.T) {
	banner := DevModeBanner()
	if !strings.Contains(banner, "DEV MODE") {
		t.Errorf("banner missing DEV MODE: %q", banner)
	}
	// Single line.
	if strings.Contains(banner, "\n") {
		t.Errorf("banner contains newline: %q", banner)
	}
}
