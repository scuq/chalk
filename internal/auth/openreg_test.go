package auth

import "testing"

func TestIsOpenRegistrationOff(t *testing.T) {
	for _, v := range []string{"", "0", "false", "no", "off", "FALSE", "garbage", " "} {
		t.Setenv("CHALK_OPEN_REGISTRATION", v)
		if IsOpenRegistration() {
			t.Errorf("IsOpenRegistration for CHALK_OPEN_REGISTRATION=%q: got true, want false", v)
		}
	}
}

func TestIsOpenRegistrationOn(t *testing.T) {
	for _, v := range []string{"1", "true", "yes", "on", "TRUE", "Yes", " on "} {
		t.Setenv("CHALK_OPEN_REGISTRATION", v)
		if !IsOpenRegistration() {
			t.Errorf("IsOpenRegistration for CHALK_OPEN_REGISTRATION=%q: got false, want true", v)
		}
	}
}
