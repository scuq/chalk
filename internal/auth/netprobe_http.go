package auth

import (
	"encoding/json"
	"fmt"
	"io"
	"log"
	"net/http"
	"time"
)

// MountNetprobe registers the pre-stream uplink probe endpoint (30-8, design
// Addendum D §D1). Clients time an upload here BEFORE any media flows to pick
// a sane starting quality tier -- because chalk media is coturn-relayed and
// coturn sits with chalkd, uplink-to-server is a sound proxy for the relay
// uplink the media actually uses. In-call re-checks are passive getStats
// reads client-side; this endpoint is never hit mid-call.
//
// Route:
//
//	POST /api/netprobe   → { "bytes": n, "millis": m, "bps": b }   (session required)
//
// The body is read and DISCARDED, capped at NetprobeMaxBytes
// (CHALK_VOICE_PROBE_BYTES) so the endpoint cannot be used to soak the
// server; timing is server-side so the client's request-setup overhead does
// not deflate the number. Answers 503 when voice or the probe is disabled
// (CHALK_VOICE_ENABLED / CHALK_VOICE_PROBE_ENABLED) -- clients also learn
// this from voice_join_ack.adaptive and simply never call.
func (d *HTTPDeps) MountNetprobe(mux *http.ServeMux) error {
	if d.Store == nil {
		return fmt.Errorf("auth: MountNetprobe requires Store")
	}
	if d.Logger == nil {
		d.Logger = log.Default()
	}
	mux.HandleFunc("POST /api/netprobe", RequireSession(d.Store, d.handleNetprobe))
	return nil
}

// netprobeResponse: what a timed discard measured. bps is bits per second.
type netprobeResponse struct {
	Bytes  int64 `json:"bytes"`
	Millis int64 `json:"millis"`
	BPS    int64 `json:"bps"`
}

// handleNetprobe times a body discard. Session-gated so anonymous callers
// can't burn upload bandwidth, capped so authenticated ones can't either.
func (d *HTTPDeps) handleNetprobe(w http.ResponseWriter, r *http.Request, _ *SessionUser) {
	if !d.NetprobeEnabled {
		writeError(w, http.StatusServiceUnavailable, "netprobe_disabled",
			"the uplink probe is disabled on this server (CHALK_VOICE_PROBE_ENABLED)")
		return
	}
	maxBytes := d.NetprobeMaxBytes
	if maxBytes <= 0 {
		maxBytes = 3_000_000
	}
	start := time.Now()
	n, err := io.Copy(io.Discard, io.LimitReader(r.Body, maxBytes))
	elapsed := time.Since(start)
	if err != nil {
		// A broken upload yields no usable measurement; the client falls
		// back to its conservative default refined by passive stats.
		writeError(w, http.StatusBadRequest, "netprobe_read", "probe upload aborted")
		return
	}
	millis := elapsed.Milliseconds()
	if millis < 1 {
		millis = 1 // sub-ms uploads (tiny bodies, local dev) still divide
	}
	w.Header().Set("Content-Type", "application/json")
	_ = json.NewEncoder(w).Encode(netprobeResponse{
		Bytes:  n,
		Millis: millis,
		BPS:    n * 8 * 1000 / millis,
	})
}
