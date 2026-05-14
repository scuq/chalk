package mail

import (
	"context"
	"fmt"
	"log"
	"strings"
)

// StderrMailer writes outgoing messages to a logger instead of
// sending them over SMTP. The intended use case is dev/test runs
// where no SMTP server is configured: the developer can see invite
// URLs and email-change verification URLs by tailing chalkd's
// stderr.
//
// The format is intentionally noisy and human-readable, with clear
// delimiters so URLs are easy to spot:
//
//   ─── chalk:mail ─── to=user@example  subject="..."  ──────────
//   From: chalk <chalk@localhost>
//   ... full body ...
//   ──────────── end mail ────────────────────────────────────────
type StderrMailer struct {
	logger   *log.Logger
	from     string
	fromName string
}

// Send writes the message to the logger. Always returns nil; the
// stderr fallback can't fail meaningfully (a write failure would
// be a logger-level concern, not a mail-delivery one).
func (m *StderrMailer) Send(ctx context.Context, to, subject, body string) error {
	// Allow ctx cancellation to short-circuit, mostly as a courtesy
	// for symmetry with SMTP. In practice this is instant.
	if err := ctx.Err(); err != nil {
		return err
	}

	var b strings.Builder
	b.WriteString("\n─── chalk:mail ─── ")
	fmt.Fprintf(&b, "to=%s subject=%q ──────────\n", to, subject)
	if m.fromName != "" {
		fmt.Fprintf(&b, "From: %s <%s>\n", m.fromName, m.from)
	} else {
		fmt.Fprintf(&b, "From: %s\n", m.from)
	}
	fmt.Fprintf(&b, "To: %s\n", to)
	fmt.Fprintf(&b, "Subject: %s\n", subject)
	b.WriteString("\n")
	b.WriteString(body)
	if !strings.HasSuffix(body, "\n") {
		b.WriteString("\n")
	}
	b.WriteString("──────────── end mail ────────────────────────────────────────\n")
	m.logger.Print(b.String())
	return nil
}
