// Package mail abstracts outbound email sending for chalk. The two
// implementations are:
//
//   - SMTPMailer: real SMTP delivery via net/smtp. Used in production
//     and in dev when a Mailhog (or similar) container is running.
//   - StderrMailer: writes the message to a logger instead of sending.
//     The fallback for dev when no SMTP host is configured; the dev
//     can copy URLs from chalkd's stderr.
//
// Selection at startup is driven by CHALK_SMTP_HOST. If empty, the
// stderr fallback is used. Other env vars (CHALK_SMTP_PORT,
// CHALK_SMTP_FROM) tune the SMTP path.
//
// The Mailer interface is intentionally narrow: a single Send method
// taking address + subject + plaintext body. HTML email is out of
// scope for chalk's use cases (invite links, email-change verification
// links, admin notices) which are all link-driven and don't need
// rich formatting.
package mail

import (
	"context"
	"fmt"
	"log"
	"net"
	"os"
	"strings"
)

// Mailer is the interface every implementation satisfies. ctx allows
// the SMTP implementation to honor request timeouts; the stderr
// implementation ignores it.
type Mailer interface {
	// Send delivers a plaintext message. Returns nil on success.
	// Implementations are responsible for adding common headers
	// (From, To, Subject, Date, Message-ID, MIME-Version).
	Send(ctx context.Context, to, subject, body string) error
}

// Config drives Mailer selection at startup. All fields are optional;
// an empty Host selects the StderrMailer fallback. Construct via
// LoadConfigFromEnv() rather than hand-rolling.
type Config struct {
	// Host is the SMTP server hostname or IP. Empty = stderr fallback.
	Host string
	// Port is the SMTP port. Defaults to 25 if Host is set and Port
	// is 0. For Mailhog use 1025.
	Port int
	// From is the envelope-from address. Defaults to
	// "chalk@<hostname>" if empty.
	From string
	// FromName is the display name placed before From in the
	// Sender header. Optional.
	FromName string
	// AuthUser / AuthPass: SMTP AUTH credentials. Empty = no auth.
	// For Mailhog leave both empty.
	AuthUser string
	AuthPass string
	// Logger is used by both implementations for error reporting
	// and (in the stderr fallback) the actual "delivery" output.
	// If nil, the package falls back to the stdlib log default.
	Logger *log.Logger
}

// LoadConfigFromEnv reads CHALK_SMTP_* env vars into a Config.
// Defaults: Port=25 when Host is set, From="chalk@<hostname>".
func LoadConfigFromEnv(logger *log.Logger) Config {
	cfg := Config{
		Host:     strings.TrimSpace(os.Getenv("CHALK_SMTP_HOST")),
		From:     strings.TrimSpace(os.Getenv("CHALK_SMTP_FROM")),
		FromName: strings.TrimSpace(os.Getenv("CHALK_SMTP_FROM_NAME")),
		AuthUser: strings.TrimSpace(os.Getenv("CHALK_SMTP_USER")),
		AuthPass: os.Getenv("CHALK_SMTP_PASS"), // don't trim password
		Logger:   logger,
	}
	if portStr := strings.TrimSpace(os.Getenv("CHALK_SMTP_PORT")); portStr != "" {
		var port int
		_, err := fmt.Sscanf(portStr, "%d", &port)
		if err == nil && port > 0 && port < 65536 {
			cfg.Port = port
		}
	}
	if cfg.Host != "" && cfg.Port == 0 {
		cfg.Port = 25
	}
	if cfg.From == "" {
		hostname, _ := os.Hostname()
		if hostname == "" {
			hostname = "localhost"
		}
		cfg.From = "chalk@" + hostname
	}
	if cfg.FromName == "" {
		cfg.FromName = "chalk"
	}
	return cfg
}

// New constructs a Mailer from the given Config. If Host is empty,
// returns a StderrMailer; otherwise returns an SMTPMailer.
//
// Failures during SMTP construction are deferred to Send time so the
// server starts cleanly even when the mail server is temporarily
// unavailable (we don't want chalkd to refuse to boot just because
// Mailhog isn't up yet).
func New(cfg Config) Mailer {
	if cfg.Logger == nil {
		cfg.Logger = log.Default()
	}
	if cfg.Host == "" {
		return &StderrMailer{
			logger:   cfg.Logger,
			from:     cfg.From,
			fromName: cfg.FromName,
		}
	}
	return &SMTPMailer{
		host:     cfg.Host,
		port:     cfg.Port,
		from:     cfg.From,
		fromName: cfg.FromName,
		authUser: cfg.AuthUser,
		authPass: cfg.AuthPass,
		logger:   cfg.Logger,
	}
}

// formatHeaders builds the standard set of RFC 5322 headers that
// both implementations share. Returns a header block ending in
// "\r\n\r\n" so the caller can concatenate the body directly.
func formatHeaders(from, fromName, to, subject, messageID, date string) string {
	var b strings.Builder
	if fromName != "" {
		fmt.Fprintf(&b, "From: %s <%s>\r\n", fromName, from)
	} else {
		fmt.Fprintf(&b, "From: %s\r\n", from)
	}
	fmt.Fprintf(&b, "To: %s\r\n", to)
	fmt.Fprintf(&b, "Subject: %s\r\n", subject)
	fmt.Fprintf(&b, "Date: %s\r\n", date)
	if messageID != "" {
		fmt.Fprintf(&b, "Message-ID: %s\r\n", messageID)
	}
	fmt.Fprintf(&b, "MIME-Version: 1.0\r\n")
	fmt.Fprintf(&b, "Content-Type: text/plain; charset=utf-8\r\n")
	fmt.Fprintf(&b, "Content-Transfer-Encoding: 8bit\r\n")
	fmt.Fprintf(&b, "\r\n")
	return b.String()
}

// generateMessageID returns a header-safe Message-ID. Format is
// "<random-hex@hostname>". Not cryptographically critical; just
// uniqueness for tracking.
func generateMessageID(rand func() string, host string) string {
	if host == "" {
		host = "chalk.local"
	}
	// Strip any port from host (e.g. if a From address had "user@h:25").
	if idx := strings.IndexByte(host, ':'); idx > 0 {
		host = host[:idx]
	}
	return fmt.Sprintf("<%s@%s>", rand(), host)
}

// hostFromAddr extracts the host part of an email address ("u@h" -> "h").
// Used for default Message-ID generation. Returns "" on malformed input.
func hostFromAddr(addr string) string {
	at := strings.LastIndexByte(addr, '@')
	if at < 0 || at == len(addr)-1 {
		return ""
	}
	return addr[at+1:]
}

// addrWithPort returns "host:port" for net.Dial. Wraps IPv6 in brackets.
func addrWithPort(host string, port int) string {
	return net.JoinHostPort(host, fmt.Sprintf("%d", port))
}
