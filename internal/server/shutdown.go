package server

import (
	"encoding/json"
	"log"
	"time"

	"github.com/scuq/chalk/internal/proto"
	"github.com/scuq/chalk/internal/version"
)

// notifyRestarting tells every connection on this instance that the process is
// going away, so a tab can offer a reload instead of silently sitting on a
// bundle the server has moved past. The frame says only "restarting" -- whether
// the build that comes back differs is decided by the next welcome's version.
//
// Best effort. The frame is marshalled once and the same []byte goes to every
// conn (Enqueue only forwards the slice, never mutates it). FanOutFresh closes
// any conn whose send buffer is full; during shutdown that is the fate CloseAll
// delivers a moment later anyway, so no special case is warranted.
func notifyRestarting(h *Hub, logger *log.Logger) {
	f, err := proto.NewFrame(proto.TypeServerNotice, "", proto.ServerNoticePayload{
		Kind:    proto.NoticeRestarting,
		Version: version.Version,
		Commit:  version.Commit,
	})
	if err != nil {
		logger.Printf("shutdown notice: %v", err)
		return
	}
	data, err := json.Marshal(f)
	if err != nil {
		logger.Printf("shutdown notice: %v", err)
		return
	}
	// Empty exceptConnID: nobody is excluded. time.Now() as the freshness
	// stamp skips only conns that registered after shutdown began, which are
	// closed a moment later and learn from their next welcome anyway.
	h.FanOutFresh("", data, time.Now())
}
