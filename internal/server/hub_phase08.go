package server

// Phase 08 adds ForEachConn so the channel-membership fan-out path
// can iterate every locally-connected device. The existing
// BroadcastFresh broadcasts to ALL conns (with one except-filter); for
// channels we need a finer-grained filter (per-user, per-channel-
// membership) that BroadcastFresh can't express cleanly.
//
// The method takes a callback rather than returning a slice so the
// hub can hold its RLock for the duration without leaking *Conn
// references outside the lock window. Callbacks should be fast: they
// run with the RLock held, blocking Register/Unregister. In practice
// the callback just does an Enqueue (non-blocking by design) and
// returns, so this is fine.

// ForEachConn invokes fn for every active connection. The hub's
// RLock is held for the duration of the iteration; fn must not call
// hub methods that take the write lock (Register/Unregister) or it
// will deadlock. Enqueue is safe (uses its own internal locking).
func (h *Hub) ForEachConn(fn func(*Conn)) {
	h.mu.RLock()
	defer h.mu.RUnlock()
	for _, c := range h.conns {
		fn(c)
	}
}
