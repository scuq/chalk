// chalk -- 83-2: the writer sequence.
//
// Every signed message envelope carries u64be(wseq), a per-writer-scope
// monotonic counter (PHASE-83-MSGSIG.md D.1). Its job is detection metadata:
// a verifier that later walks one writer's messages can notice a gap or a
// regression, which is what makes server-withheld messages *visible* under
// the phase-83 trust model. Nothing enforces continuity yet -- the field is
// sealed and signed now so history carries it from the first signed build.
//
// The counter is keyed by writer scope (the device id) and persisted in
// localStorage so it survives reloads. Two tabs on one device share the
// scope and can race the read-increment-write; the loser reuses a value.
// That is an accepted imperfection: wseq is detection metadata, not a
// uniqueness key (the replay identity is (actor, scope, client_msg_id), and
// client_msg_id is fresh per send), and a same-device duplicate is
// indistinguishable from benign at-least-once behaviour to any verifier.
// Serializing tabs through IndexedDB locks would buy little and cost a
// storage transaction per keystroke-send.
//
// Storage is injectable for Node tests; the in-memory fallback covers
// browsers with storage disabled (counter restarts at 1 per session there,
// which is monotone within the session -- the same honesty trade-off
// getOrCreateDeviceId makes).

interface KVStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

const memory = new Map<string, string>();
const memoryStorage: KVStorage = {
  getItem: (k) => memory.get(k) ?? null,
  setItem: (k, v) => {
    memory.set(k, v);
  },
};

function defaultStorage(): KVStorage {
  try {
    if (typeof window !== "undefined" && window.localStorage) return window.localStorage;
  } catch {
    // storage gated (privacy mode); fall through
  }
  return memoryStorage;
}

/**
 * nextWseq returns the next writer-sequence value for a scope and persists
 * the high-water mark. Starts at 1; strictly increasing per storage.
 */
export function nextWseq(scope: string, storage: KVStorage = defaultStorage()): number {
  const key = `chalk-wseq:${scope}`;
  let prev = 0;
  try {
    const raw = storage.getItem(key);
    if (raw) {
      const n = Number(raw);
      if (Number.isSafeInteger(n) && n > 0) prev = n;
    }
  } catch {
    // unreadable storage: treat as fresh
  }
  const next = prev + 1;
  try {
    storage.setItem(key, String(next));
  } catch {
    // full/blocked storage: the value is still monotone via `memory` next time
    memoryStorage.setItem(key, String(next));
  }
  return next;
}
