package config

import (
	"slices"
	"testing"
)

func TestLinkPreviewDefaults(t *testing.T) {
	l := defaultLinkPreviewConfig()
	if !l.Enabled {
		t.Fatal("link previews should default to enabled")
	}
	if l.TimeoutSeconds != defaultLinkPreviewTimeoutSeconds {
		t.Fatalf("TimeoutSeconds = %d, want %d", l.TimeoutSeconds, defaultLinkPreviewTimeoutSeconds)
	}
	want := []string{
		"youtube.com", "www.youtube.com", "m.youtube.com", "youtu.be",
		"store.steampowered.com", "steamcommunity.com",
	}
	if !slices.Equal(l.Domains, want) {
		t.Fatalf("Domains = %v, want %v", l.Domains, want)
	}
	if err := l.Validate(); err != nil {
		t.Fatalf("default config must validate: %v", err)
	}
}

func TestLinkPreviewApplyEnv(t *testing.T) {
	t.Setenv("CHALK_LINKPREVIEW_ENABLED", "false")
	t.Setenv("CHALK_LINKPREVIEW_DOMAINS", " Example.COM , media.example.com ,")
	t.Setenv("CHALK_LINKPREVIEW_TIMEOUT_SECONDS", "3")

	l := defaultLinkPreviewConfig()
	l.applyEnv()

	if l.Enabled {
		t.Fatal("CHALK_LINKPREVIEW_ENABLED=false not applied")
	}
	if !slices.Equal(l.Domains, []string{"example.com", "media.example.com"}) {
		t.Fatalf("Domains = %v (want lower-cased, trimmed, empties dropped)", l.Domains)
	}
	if l.TimeoutSeconds != 3 {
		t.Fatalf("TimeoutSeconds = %d, want 3", l.TimeoutSeconds)
	}
}

func TestLinkPreviewApplyEnvUnsetKeepsDefaults(t *testing.T) {
	l := defaultLinkPreviewConfig()
	l.applyEnv()
	if !l.Enabled || len(l.Domains) == 0 || l.TimeoutSeconds != defaultLinkPreviewTimeoutSeconds {
		t.Fatalf("unset env must keep defaults, got %+v", l)
	}
}

func TestLinkPreviewValidate(t *testing.T) {
	cases := []struct {
		name string
		mut  func(*LinkPreviewConfig)
		ok   bool
	}{
		{"default", func(l *LinkPreviewConfig) {}, true},
		{"timeout too low", func(l *LinkPreviewConfig) { l.TimeoutSeconds = 0 }, false},
		{"timeout too high", func(l *LinkPreviewConfig) { l.TimeoutSeconds = 61 }, false},
		{"domain with scheme", func(l *LinkPreviewConfig) { l.Domains = []string{"https://youtube.com"} }, false},
		{"domain with path", func(l *LinkPreviewConfig) { l.Domains = []string{"youtube.com/watch"} }, false},
		{"domain with space", func(l *LinkPreviewConfig) { l.Domains = []string{"you tube.com"} }, false},
		{"empty domain", func(l *LinkPreviewConfig) { l.Domains = []string{""} }, false},
		{"no domains at all", func(l *LinkPreviewConfig) { l.Domains = nil }, true},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			l := defaultLinkPreviewConfig()
			tc.mut(&l)
			err := l.Validate()
			if tc.ok && err != nil {
				t.Fatalf("want ok, got %v", err)
			}
			if !tc.ok && err == nil {
				t.Fatal("want error, got nil")
			}
		})
	}
}
