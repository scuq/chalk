package mail

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"fmt"
	"log"
	"net/smtp"
	"time"
)

// SMTPMailer delivers messages via SMTP. Uses net/smtp from the
// standard library — minimal feature set (no STARTTLS by default,
// no DSN, no DKIM signing) but covers what chalk needs.
//
// Behavior:
//   - PLAIN AUTH if authUser is non-empty.
//   - No TLS by default (Mailhog doesn't support it on 1025). To
//     enable TLS, future-proof: add a CHALK_SMTP_TLS=1 toggle.
//     Punted to a later phase; chalk dev runs against Mailhog
//     (no TLS) and chalk production hasn't shipped yet.
//   - Honors ctx via a goroutine-cancel pattern: if ctx is done
//     before Send returns, we return ctx.Err() and the in-flight
//     SMTP exchange continues to completion in the background
//     (rather than leaving a half-spoken protocol on the wire).
type SMTPMailer struct {
	host     string
	port     int
	from     string
	fromName string
	authUser string
	authPass string
	logger   *log.Logger
}

// Send composes the message with standard headers and delivers it
// via SMTP. ctx cancellation only affects the wait; the underlying
// goroutine completes to leave the SMTP connection clean.
func (m *SMTPMailer) Send(ctx context.Context, to, subject, body string) error {
	addr := addrWithPort(m.host, m.port)
	msgID := generateMessageID(randomHex, hostFromAddr(m.from))
	date := time.Now().Format(time.RFC1123Z)
	headers := formatHeaders(m.from, m.fromName, to, subject, msgID, date)
	payload := []byte(headers + body)

	var auth smtp.Auth
	if m.authUser != "" {
		auth = smtp.PlainAuth("", m.authUser, m.authPass, m.host)
	}

	// Run the send in a goroutine so we can respect ctx without
	// orphaning the SMTP exchange.
	done := make(chan error, 1)
	go func() {
		done <- smtp.SendMail(addr, auth, m.from, []string{to}, payload)
	}()

	select {
	case err := <-done:
		if err != nil {
			m.logger.Printf("mail: SMTP send failed to=%s host=%s: %v",
				to, m.host, err)
			return fmt.Errorf("smtp send: %w", err)
		}
		m.logger.Printf("mail: sent to=%s subject=%q", to, subject)
		return nil
	case <-ctx.Done():
		m.logger.Printf("mail: ctx cancelled before SMTP completed (to=%s)", to)
		return ctx.Err()
	}
}

// randomHex returns 16 hex characters from a CSPRNG. Used for
// Message-ID local-parts.
func randomHex() string {
	var buf [8]byte
	if _, err := rand.Read(buf[:]); err != nil {
		// Catastrophic CSPRNG failure. Fall back to a timestamp;
		// uniqueness within the same nanosecond is unlikely enough.
		return fmt.Sprintf("%016x", time.Now().UnixNano())
	}
	return hex.EncodeToString(buf[:])
}
