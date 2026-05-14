package mail

import (
	"bytes"
	"context"
	"log"
	"strings"
	"testing"
)

func TestLoadConfigFromEnv_Defaults(t *testing.T) {
	// All env vars unset → stderr fallback.
	t.Setenv("CHALK_SMTP_HOST", "")
	t.Setenv("CHALK_SMTP_PORT", "")
	t.Setenv("CHALK_SMTP_FROM", "")
	t.Setenv("CHALK_SMTP_FROM_NAME", "")
	t.Setenv("CHALK_SMTP_USER", "")
	t.Setenv("CHALK_SMTP_PASS", "")

	cfg := LoadConfigFromEnv(nil)
	if cfg.Host != "" {
		t.Errorf("Host = %q, want empty (stderr fallback)", cfg.Host)
	}
	if !strings.HasPrefix(cfg.From, "chalk@") {
		t.Errorf("From = %q, want chalk@<hostname>", cfg.From)
	}
	if cfg.FromName != "chalk" {
		t.Errorf("FromName = %q, want 'chalk'", cfg.FromName)
	}
}

func TestLoadConfigFromEnv_MailhogShape(t *testing.T) {
	t.Setenv("CHALK_SMTP_HOST", "localhost")
	t.Setenv("CHALK_SMTP_PORT", "1025")
	t.Setenv("CHALK_SMTP_FROM", "chalk@example.test")
	t.Setenv("CHALK_SMTP_FROM_NAME", "chalk dev")
	t.Setenv("CHALK_SMTP_USER", "")
	t.Setenv("CHALK_SMTP_PASS", "")

	cfg := LoadConfigFromEnv(nil)
	if cfg.Host != "localhost" {
		t.Errorf("Host = %q, want 'localhost'", cfg.Host)
	}
	if cfg.Port != 1025 {
		t.Errorf("Port = %d, want 1025", cfg.Port)
	}
	if cfg.From != "chalk@example.test" {
		t.Errorf("From = %q", cfg.From)
	}
	if cfg.FromName != "chalk dev" {
		t.Errorf("FromName = %q", cfg.FromName)
	}
	if cfg.AuthUser != "" || cfg.AuthPass != "" {
		t.Errorf("Mailhog config should have no auth")
	}
}

func TestLoadConfigFromEnv_DefaultsPort25(t *testing.T) {
	t.Setenv("CHALK_SMTP_HOST", "smtp.example.com")
	t.Setenv("CHALK_SMTP_PORT", "")
	cfg := LoadConfigFromEnv(nil)
	if cfg.Port != 25 {
		t.Errorf("Port = %d, want 25 (default when Host is set)", cfg.Port)
	}
}

func TestLoadConfigFromEnv_RejectsInvalidPort(t *testing.T) {
	t.Setenv("CHALK_SMTP_HOST", "smtp.example.com")
	t.Setenv("CHALK_SMTP_PORT", "not-a-port")
	cfg := LoadConfigFromEnv(nil)
	// Invalid port → falls through to the default 25 path.
	if cfg.Port != 25 {
		t.Errorf("Port = %d, want 25 (invalid port should fall back)", cfg.Port)
	}
}

func TestNew_EmptyHostReturnsStderrMailer(t *testing.T) {
	cfg := Config{Logger: log.Default()}
	m := New(cfg)
	if _, ok := m.(*StderrMailer); !ok {
		t.Errorf("New with empty Host returned %T, want *StderrMailer", m)
	}
}

func TestNew_HostSetReturnsSMTPMailer(t *testing.T) {
	cfg := Config{Host: "smtp.example.com", Port: 25, Logger: log.Default()}
	m := New(cfg)
	if _, ok := m.(*SMTPMailer); !ok {
		t.Errorf("New with Host returned %T, want *SMTPMailer", m)
	}
}

func TestStderrMailer_SendWritesToLogger(t *testing.T) {
	var buf bytes.Buffer
	logger := log.New(&buf, "", 0)
	m := &StderrMailer{
		logger:   logger,
		from:     "chalk@test.invalid",
		fromName: "chalk test",
	}
	err := m.Send(context.Background(),
		"alice@example.test",
		"Welcome to chalk",
		"Click here to register: https://chalk.test/invite/abc123\n",
	)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	got := buf.String()
	for _, want := range []string{
		"to=alice@example.test",
		"Welcome to chalk",
		"chalk@test.invalid",
		"https://chalk.test/invite/abc123",
		"chalk:mail",
		"end mail",
	} {
		if !strings.Contains(got, want) {
			t.Errorf("output missing %q\nfull output:\n%s", want, got)
		}
	}
}

func TestStderrMailer_HonorsCtxCancel(t *testing.T) {
	var buf bytes.Buffer
	logger := log.New(&buf, "", 0)
	m := &StderrMailer{
		logger: logger,
		from:   "chalk@test.invalid",
	}
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	err := m.Send(ctx, "alice@example.test", "x", "y")
	if err == nil {
		t.Errorf("expected error from cancelled ctx, got nil")
	}
	if buf.Len() != 0 {
		t.Errorf("cancelled Send should not write; buffer has:\n%s", buf.String())
	}
}

func TestFormatHeaders_CoreFields(t *testing.T) {
	h := formatHeaders(
		"chalk@test.invalid", "chalk test",
		"alice@example.test",
		"Test subject",
		"<test-msgid@chalk.local>",
		"Mon, 01 Jan 2024 12:00:00 +0000",
	)
	for _, want := range []string{
		"From: chalk test <chalk@test.invalid>\r\n",
		"To: alice@example.test\r\n",
		"Subject: Test subject\r\n",
		"Date: Mon, 01 Jan 2024 12:00:00 +0000\r\n",
		"Message-ID: <test-msgid@chalk.local>\r\n",
		"MIME-Version: 1.0\r\n",
		"Content-Type: text/plain; charset=utf-8\r\n",
	} {
		if !strings.Contains(h, want) {
			t.Errorf("headers missing %q\nfull:\n%s", want, h)
		}
	}
	// Must end with the blank line that separates headers from body.
	if !strings.HasSuffix(h, "\r\n\r\n") {
		t.Errorf("headers should end with \\r\\n\\r\\n; got tail: %q",
			h[len(h)-6:])
	}
}

func TestFormatHeaders_OmitsFromNameWhenEmpty(t *testing.T) {
	h := formatHeaders(
		"chalk@test.invalid", "", // no FromName
		"alice@example.test",
		"Test", "<x@y>", "Mon, 01 Jan 2024 12:00:00 +0000",
	)
	if strings.Contains(h, "From: <") {
		t.Errorf("From should not contain empty display-name angle brackets:\n%s", h)
	}
	if !strings.Contains(h, "From: chalk@test.invalid\r\n") {
		t.Errorf("From line malformed:\n%s", h)
	}
}

func TestHostFromAddr(t *testing.T) {
	cases := map[string]string{
		"alice@example.com":      "example.com",
		"u@h":                    "h",
		"":                       "",
		"no-at-sign":             "",
		"trailing-at@":           "",
		"multi@at@hostname.com":  "hostname.com",
	}
	for in, want := range cases {
		if got := hostFromAddr(in); got != want {
			t.Errorf("hostFromAddr(%q) = %q, want %q", in, got, want)
		}
	}
}

func TestGenerateMessageID(t *testing.T) {
	// Deterministic by passing a fixed-rand function.
	id := generateMessageID(func() string { return "deadbeef" }, "chalk.test")
	if id != "<deadbeef@chalk.test>" {
		t.Errorf("MessageID = %q, want <deadbeef@chalk.test>", id)
	}
	// Empty host falls back to chalk.local.
	id2 := generateMessageID(func() string { return "abc123" }, "")
	if id2 != "<abc123@chalk.local>" {
		t.Errorf("MessageID with empty host = %q, want <abc123@chalk.local>", id2)
	}
	// Host with port: port stripped.
	id3 := generateMessageID(func() string { return "abc" }, "smtp.example.com:25")
	if id3 != "<abc@smtp.example.com>" {
		t.Errorf("MessageID with host:port = %q, want <abc@smtp.example.com>", id3)
	}
}

func TestAddrWithPort_IPv6(t *testing.T) {
	got := addrWithPort("::1", 1025)
	if got != "[::1]:1025" {
		t.Errorf("addrWithPort(::1, 1025) = %q, want [::1]:1025", got)
	}
}

func TestAddrWithPort_IPv4(t *testing.T) {
	got := addrWithPort("127.0.0.1", 25)
	if got != "127.0.0.1:25" {
		t.Errorf("addrWithPort(127.0.0.1, 25) = %q", got)
	}
}
