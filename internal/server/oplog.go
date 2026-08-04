// chalk -- 85-2/85-3 operational logging: the periodic connection snapshot and
// the slow-request line.
//
// Both are built around the same constraint: chalkd runs on somebody's small
// self-hosted box, and diagnostics that cost throughput are not diagnostics
// worth having. So neither of these measures anything the server was not
// already doing.
//
//   - The WebSocket round-trip comes from the keepalive ping, which already
//     waits for its pong (85-2, see pingLoop).
//   - The pool counters are maintained by pgx whether anyone reads them or not.
//   - The database round-trip is one ping per snapshot interval, not per
//     request.
//   - The slow-request line costs a time.Now and a comparison per request and
//     produces no output at all on a healthy server.
//
// The snapshot is off unless CHALK_OPLOG_SNAPSHOT_INTERVAL is set. See
// config.OplogConfig for why that default is about privacy rather than cost.
package server

import (
	"context"
	"fmt"
	"log"
	"net/http"
	"sort"
	"time"

	"github.com/scuq/chalk/internal/auth"
)

// snapshotLoop logs the connection snapshot every interval until ctx ends.
func (s *Server) snapshotLoop(ctx context.Context, interval time.Duration) {
	t := time.NewTicker(interval)
	defer t.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-t.C:
			s.logSnapshot(ctx)
		}
	}
}

// logSnapshot writes one summary line plus one line per live connection.
func (s *Server) logSnapshot(ctx context.Context) {
	conns := s.hub.Conns()
	guests := 0
	for _, c := range conns {
		if c.IsGuest {
			guests++
		}
	}
	// Sorted so consecutive snapshots can be diffed by eye. The hub's maps
	// iterate in randomized order, which would make an unchanged set of
	// connections look different every interval.
	sort.Slice(conns, func(i, j int) bool {
		if conns[i].Username != conns[j].Username {
			return conns[i].Username < conns[j].Username
		}
		return conns[i].ID < conns[j].ID
	})

	s.logger.Printf("snapshot: conns=%d users=%d guests=%d%s",
		len(conns), s.hub.CountUsers(), guests, s.dbHealth(ctx))

	now := time.Now()
	for _, c := range conns {
		s.logger.Printf("snapshot:   user=%s dev=%s ip=%s age=%s rtt=%s%s",
			orUnknown(c.Username), orUnknown(c.DeviceType), orUnknown(c.RemoteIP),
			shortDur(now.Sub(c.CreatedAt)), rttString(c.RTT()), guestMark(c.IsGuest))
	}
}

// dbHealth measures one database round-trip and reports pgx's own pool
// counters. pool_waits is the one to watch: a non-zero, growing count means
// requests are queueing for a connection, which is the shape a "chalk feels
// slow" report usually has.
func (s *Server) dbHealth(ctx context.Context) string {
	if s.store == nil || s.store.Pool == nil {
		return ""
	}
	pingCtx, cancel := context.WithTimeout(ctx, 2*time.Second)
	start := time.Now()
	err := s.store.Pool.Ping(pingCtx)
	cancel()

	st := s.store.Pool.Stat()
	pool := fmt.Sprintf(" pool=%d/%d pool_waits=%d",
		st.AcquiredConns(), st.MaxConns(), st.EmptyAcquireCount())
	if err != nil {
		// Worth saying out loud: the server is up and holding connections
		// while its database is not answering.
		return " db=unreachable" + pool
	}
	return " db_rtt=" + shortDur(time.Since(start)) + pool
}

// slowRequestLogger logs one line for any request that takes at least
// threshold. A zero threshold returns h untouched, so the disabled case costs
// nothing at all -- not even a wrapper frame per request.
func slowRequestLogger(h http.Handler, threshold time.Duration, logger *log.Logger) http.Handler {
	if threshold <= 0 {
		return h
	}
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		// A WebSocket is "slow" by definition -- it lives as long as the tab
		// is open -- so timing it produces one useless line per disconnect.
		// Wrapping its ResponseWriter would also hide the hijack the upgrade
		// depends on. Hand it through untouched.
		if r.URL.Path == "/ws" {
			h.ServeHTTP(w, r)
			return
		}
		start := time.Now()
		sw := &statusWriter{ResponseWriter: w, status: http.StatusOK}
		h.ServeHTTP(sw, r)
		if d := time.Since(start); d >= threshold {
			logger.Printf("slow request: %s %s %s status=%d ip=%s",
				r.Method, r.URL.Path, shortDur(d), sw.status, clientIP(r))
		}
	})
}

// statusWriter captures the response status for the slow-request line.
//
// Unwrap is what keeps this transparent: http.ResponseController walks it to
// reach the real writer, so Flush and friends still work on anything that
// needs them. Nothing on chalkd's HTTP surface type-asserts a ResponseWriter
// directly -- the one thing that did is the WebSocket upgrade, which is
// routed around this wrapper entirely.
type statusWriter struct {
	http.ResponseWriter
	status int
}

func (w *statusWriter) WriteHeader(code int) {
	w.status = code
	w.ResponseWriter.WriteHeader(code)
}

func (w *statusWriter) Unwrap() http.ResponseWriter { return w.ResponseWriter }

// clientIP renders a request's client address, honouring CHALK_TRUSTED_PROXY
// the same way the auth rate limiters do.
func clientIP(r *http.Request) string {
	if ip := auth.IPFromRequest(r); ip != nil {
		return ip.String()
	}
	return "?"
}

// shortDur formats a duration for a human scanning a log: sub-second values
// keep tenths of a millisecond, longer ones round to the second so a
// connection age reads as "1h12m0s" rather than to the nanosecond.
func shortDur(d time.Duration) string {
	if d < time.Second {
		return d.Round(100 * time.Microsecond).String()
	}
	return d.Round(time.Second).String()
}

// rttString renders a round-trip, or "?" for a connection that has not been
// pinged yet (younger than one ping interval).
func rttString(d time.Duration) string {
	if d <= 0 {
		return "?"
	}
	return shortDur(d)
}

func orUnknown(s string) string {
	if s == "" {
		return "?"
	}
	return s
}

func guestMark(isGuest bool) string {
	if isGuest {
		return " guest"
	}
	return ""
}
