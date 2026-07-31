// SearchPanel: find a message in what this client holds.
//
// Phase 61-2. Same overlay pattern as ThreadInboxPanel: fixed card,
// click-outside + Escape to close, opened from the channel header or
// Ctrl/Cmd+K.
//
// SEARCH IS CLIENT-SIDE, and can only be: bodies are ciphertext on the
// server, which is deliberately never asked to match on them. The corpus is
// state.messages -- every message this device has decrypted, which grows as
// history pages in. That honesty is surfaced in the empty state and, in
// 61-3, by the explicit "search full history" crawl.
//
// Two scopes: the current channel, or every channel with anything loaded.
// Matching, ordering, capping and snippets live in chat/search.ts where they
// are unit-tested away from the DOM.
//
// Presentational: App owns the corpus, the labels and the navigation.

import { useEffect, useMemo, useRef, useState } from "preact/hooks";
import type { Message } from "../state/types";
import {
  searchableText,
  searchMessages,
  snippetSegments,
  SEARCH_RESULT_CAP,
  type SearchScope,
} from "../chat/search";
import { threadQueryTerms } from "../chat/threadinbox";
import { fmtRelative } from "../chat/reltime";
import type { DeepSearchProgress } from "../chat/deep-search";

interface Props {
  activeChannelID: string | null;
  messagesByChannel: Record<string, Message[]>;
  // channelID -> display name, userID -> handle. Resolved by App, which
  // holds the channel list and the member rosters.
  channelNames: Record<string, string>;
  handles: Record<string, string>;
  ownUserID: string | null;
  // 61-3: whether the active channel's history is fully loaded, and the
  // state of the crawl that gets it there. App owns the crawl; the panel
  // only renders its progress and offers start/stop.
  historyComplete: boolean;
  deep: DeepSearchProgress | null;
  onStartDeep: () => void;
  onStopDeep: () => void;
  onOpenResult: (m: Message) => void;
  onClose: () => void;
}

export function SearchPanel({
  activeChannelID,
  messagesByChannel,
  channelNames,
  handles,
  ownUserID,
  historyComplete,
  deep,
  onStartDeep,
  onStopDeep,
  onOpenResult,
  onClose,
}: Props) {
  const [query, setQuery] = useState("");
  // "channel" is the default because the header button lives in a channel:
  // "find it here" is the common case, one click widens to everything.
  const [scopeKind, setScopeKind] = useState<"channel" | "all">(
    activeChannelID ? "channel" : "all",
  );
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      // Escape backs out one level at a time: it clears the query first, so a
      // mistyped search does not also cost you the panel.
      if (query.length > 0) {
        setQuery("");
        return;
      }
      onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose, query]);

  // One clock per render pass, like MessageList: a Date per row would make
  // rows in the same list disagree about "now".
  const now = new Date();

  const label = (userID?: string): string => {
    if (!userID) return "someone";
    if (ownUserID && userID === ownUserID) return "you";
    return handles[userID] ?? "someone";
  };

  const terms = useMemo(() => threadQueryTerms(query), [query]);

  const scope: SearchScope =
    scopeKind === "channel" && activeChannelID
      ? { kind: "channel", channelID: activeChannelID }
      : { kind: "all" };

  const { results, total } = useMemo(
    () => searchMessages(messagesByChannel, scope, terms, { channelNames, handles }),
    [messagesByChannel, scopeKind, activeChannelID, terms, channelNames, handles],
  );

  const searching = terms.length > 0;

  const renderRow = (m: Message) => (
    <li key={m.id} class="chalk-search-item">
      <button
        type="button"
        class="chalk-search-row"
        onClick={() => onOpenResult(m)}
        data-testid={`search-result-${m.id}`}
      >
        <div class="chalk-search-meta">
          <span class="chalk-search-chan">{channelNames[m.channelID] ?? "a channel"}</span>
          <span class="chalk-search-sender">{label(m.senderUserID)}</span>
          {m.parentID && <span class="chalk-search-thread">in thread</span>}
          <span class="chalk-search-when">{fmtRelative(m.ts, now)}</span>
        </div>
        <div class="chalk-search-snippet">
          {/* The extracted text, not the raw body -- a link-preview body
              would otherwise show its embedded payload JSON. */}
          {snippetSegments(searchableText(m.body) ?? m.body, terms).map((s) =>
            s.hit ? <mark class="chalk-search-hit">{s.text}</mark> : s.text,
          )}
        </div>
      </button>
    </li>
  );

  return (
    <div class="chalk-modal-backdrop" role="presentation" onClick={onClose}>
      <div
        class="chalk-modal-card chalk-search-panel"
        role="dialog"
        aria-label="search messages"
        onClick={(e) => e.stopPropagation()}
        data-testid="search-panel"
      >
        <div class="chalk-search-header">
          <div class="chalk-search-title">search messages</div>
          <button
            type="button"
            class="chalk-modal-close"
            onClick={onClose}
            aria-label="close"
          >
            x
          </button>
        </div>

        <div class="chalk-search-controls">
          <div class="chalk-search-inputwrap">
            <input
              ref={inputRef}
              type="text"
              class="chalk-search-input"
              placeholder="search messages..."
              value={query}
              onInput={(e) => setQuery((e.target as HTMLInputElement).value)}
              aria-label="search messages by text, sender or channel"
              data-testid="search-input"
            />
            {searching && (
              <button
                type="button"
                class="chalk-search-clear"
                onClick={() => {
                  setQuery("");
                  inputRef.current?.focus();
                }}
                aria-label="clear search"
              >
                x
              </button>
            )}
          </div>
          <div class="chalk-search-scopes" role="radiogroup" aria-label="search scope">
            <button
              type="button"
              class={`chalk-search-scope${scopeKind === "channel" ? " chalk-search-scope--on" : ""}`}
              role="radio"
              aria-checked={scopeKind === "channel"}
              disabled={!activeChannelID}
              onClick={() => setScopeKind("channel")}
              data-testid="search-scope-channel"
            >
              this channel
            </button>
            <button
              type="button"
              class={`chalk-search-scope${scopeKind === "all" ? " chalk-search-scope--on" : ""}`}
              role="radio"
              aria-checked={scopeKind === "all"}
              onClick={() => setScopeKind("all")}
              data-testid="search-scope-all"
            >
              everything loaded
            </button>
          </div>
        </div>

        {!searching ? (
          <div class="chalk-search-empty">
            <div class="chalk-search-empty-hint">
              searches the messages loaded on this device &mdash; the channel
              you're in, or everything fetched so far
            </div>
          </div>
        ) : results.length === 0 ? (
          <div class="chalk-search-empty">
            no matches in what's loaded here
            <div class="chalk-search-empty-hint">
              messages never fetched to this device can't be searched
            </div>
          </div>
        ) : (
          <>
            {total > results.length && (
              <div class="chalk-search-capnote" data-testid="search-cap-note">
                showing the newest {SEARCH_RESULT_CAP} of {total} matches
              </div>
            )}
            <ul class="chalk-search-list">{results.map(renderRow)}</ul>
          </>
        )}

        {/* 61-3: the full-history crawl, current-channel scope only -- "all
            channels back to the beginning" would be every message on the
            server through one browser tab. Explicit start, live progress,
            stop button. */}
        {scopeKind === "channel" && activeChannelID && (
          <div class="chalk-search-deep" data-testid="search-deep">
            {deep?.phase === "running" ? (
              <>
                <span class="chalk-search-deep-status" aria-live="polite">
                  searching full history&hellip; {deep.scanned} messages scanned
                  {deep.oldestTS && <> &middot; back to {deep.oldestTS.toLocaleDateString()}</>}
                </span>
                <button
                  type="button"
                  class="chalk-search-deep-btn"
                  onClick={onStopDeep}
                  data-testid="search-deep-stop"
                >
                  stop
                </button>
              </>
            ) : historyComplete ? (
              <span class="chalk-search-deep-status" data-testid="search-deep-complete">
                the full channel history is on this device &mdash; results above
                cover all of it
                {deep && deep.undecryptable > 0 && (
                  <> ({deep.undecryptable} {deep.undecryptable === 1 ? "message" : "messages"} couldn't be decrypted here)</>
                )}
              </span>
            ) : (
              <>
                <span class="chalk-search-deep-status">
                  {deep?.phase === "error" ? (
                    <>
                      connection lost
                      {deep.oldestTS && <> &mdash; searched back to {deep.oldestTS.toLocaleDateString()}</>}
                    </>
                  ) : deep?.phase === "stopped" ? (
                    <>
                      stopped
                      {deep.oldestTS && <> &mdash; searched back to {deep.oldestTS.toLocaleDateString()}</>}
                    </>
                  ) : (
                    <>only what's loaded is searched so far</>
                  )}
                </span>
                <button
                  type="button"
                  class="chalk-search-deep-btn"
                  onClick={onStartDeep}
                  title="fetches and decrypts this channel's entire history on this device"
                  data-testid="search-deep-start"
                >
                  {deep?.phase === "stopped" || deep?.phase === "error"
                    ? "keep searching"
                    : "search full history"}
                </button>
              </>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
