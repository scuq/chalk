// chalk-web -- message search over what this client holds.
//
// Pure and structurally typed, on the threadinbox.ts precedent. Client-side
// is the only option that exists: bodies are ciphertext on the server, so it
// cannot match on them and is deliberately not asked to. The corpus is
// honestly limited to what this device has decrypted -- state.messages plus
// whatever deep search (61-3) pages in.

import {
  PLACEHOLDER_NO_KEY,
  PLACEHOLDER_FAILED,
  PLACEHOLDER_PLAINTEXT_BLOCKED,
} from "../crypto/channel-crypto";
import { parseGiphyBody } from "../giphy/giphy";
import { parseLinkPreviewBody } from "../linkpreview/linkpreview";
import { parseCodeBody } from "../code/code";

// decryptAll (App.tsx) has its own placeholders outside ChannelCrypto: the
// deleted-message tombstone and the "crypto not built yet" variant (note the
// ASCII dashes -- it is NOT the same string as PLACEHOLDER_NO_KEY).
const DELETED_BODY = "[message deleted]";
const NO_CRYPTO_BODY = "[encrypted message -- key not available yet]";

// The structural subset of a state Message that search needs: enough to
// match, order, and render a result row. Thread fields ride along so the
// panel can route reply results into their thread.
export interface SearchableMessage {
  id: string;
  channelID: string;
  seq: number;
  senderUserID?: string;
  ts: Date;
  body: string;
  deleted?: boolean;
  parentID?: string;
  threadID?: string;
}

export type SearchScope = { kind: "channel"; channelID: string } | { kind: "all" };

// Names resolved from app state -- like the thread-inbox filter, matching on
// channel name and sender handle is part of the contract ("what did ana say
// about the deploy" is a real query).
export interface SearchLabels {
  channelNames: Record<string, string>;
  handles: Record<string, string>;
}

export const SEARCH_RESULT_CAP = 200;

// isUndecryptableBody reports whether a body is a decrypt-failure
// placeholder: a real message exists but this device cannot read it (key
// epoch never held here, or corrupt ciphertext). Deep search counts these so
// "full history searched" can honestly add "except these N". The
// plaintext-blocked placeholder is NOT counted -- that message was refused on
// policy, not lost to a missing key.
export function isUndecryptableBody(body: string): boolean {
  return body === PLACEHOLDER_NO_KEY || body === PLACEHOLDER_FAILED || body === NO_CRYPTO_BODY;
}

// searchableText extracts the text a query should match from a plaintext
// body, or null when the row has nothing searchable: tombstones and
// placeholders are chrome, not content. Sentinel bodies need parsing --
// a giphy body is sentinel+URL (match the URL, people remember "that cat
// gif from tenor... giphy"), and a link-preview body embeds payload JSON
// before the user's text, which a naive substring over the raw body would
// false-match on keys like "site_name".
export function searchableText(body: string): string | null {
  if (
    body === DELETED_BODY ||
    body === PLACEHOLDER_PLAINTEXT_BLOCKED ||
    isUndecryptableBody(body)
  ) {
    return null;
  }
  const giphy = parseGiphyBody(body);
  if (giphy) return giphy.url;
  // 74-4: the snippet is searchable along with its caption -- "which channel
  // was that retry loop pasted in" is exactly the question search is for.
  const code = parseCodeBody(body);
  if (code) {
    return [code.text, code.payload.code].filter((s) => s !== "").join(" ");
  }
  const lp = parseLinkPreviewBody(body);
  if (lp) {
    const p = lp.preview;
    return [lp.text, p.title, p.description, p.site_name, p.url]
      .filter((s) => s !== "")
      .join(" ");
  }
  return body;
}

// searchMessages runs parsed terms (threadQueryTerms) over the held corpus.
// Terms are ANDed against a haystack of body text + sender handle + channel
// name. Results come newest-first -- a search is usually "find that thing
// from recently", and with deep search appending ever-older pages, newest-
// first keeps the top of the list stable while the crawl runs. `total` is
// the full match count so the panel can say "showing first 200 of N".
//
// Empty terms return nothing, unlike the inbox filter which shows all: an
// empty search box listing every message ever held is noise, not a result.
export function searchMessages<T extends SearchableMessage>(
  messagesByChannel: Record<string, T[]>,
  scope: SearchScope,
  terms: string[],
  labels: SearchLabels,
  cap: number = SEARCH_RESULT_CAP,
): { results: T[]; total: number } {
  if (terms.length === 0) return { results: [], total: 0 };

  const channelIDs =
    scope.kind === "channel" ? [scope.channelID] : Object.keys(messagesByChannel);

  const matches: T[] = [];
  for (const cid of channelIDs) {
    const msgs = messagesByChannel[cid];
    if (!msgs) continue;
    const channelName = labels.channelNames[cid] ?? "";
    for (const m of msgs) {
      if (m.deleted) continue;
      const text = searchableText(m.body);
      if (text === null) continue;
      const handle = (m.senderUserID && labels.handles[m.senderUserID]) || "";
      const hay = `${text} ${handle} ${channelName}`.toLowerCase();
      if (terms.every((t) => hay.includes(t))) matches.push(m);
    }
  }

  matches.sort((a, b) => b.ts.getTime() - a.ts.getTime() || b.seq - a.seq);
  return { results: matches.slice(0, cap), total: matches.length };
}

export interface SnippetSegment {
  text: string;
  hit: boolean;
}

const SNIPPET_MAX_LEN = 160;

// snippetSegments cuts a ~maxLen window out of a matched body, centred on
// the first term hit, and splits it into hit/miss runs so the panel renders
// <mark> spans without doing any regex work in JSX. Overlapping term hits
// merge into one run ("dep"+"deploy" doesn't nest). A row that matched on
// metadata alone (sender, channel) has no body hit; it gets the plain head
// of the text. Ellipses are part of the edge segments, not the caller's
// problem.
export function snippetSegments(
  text: string,
  terms: string[],
  maxLen: number = SNIPPET_MAX_LEN,
): SnippetSegment[] {
  const lower = text.toLowerCase();

  let firstHit = -1;
  for (const t of terms) {
    const i = lower.indexOf(t);
    if (i >= 0 && (firstHit < 0 || i < firstHit)) firstHit = i;
  }

  // Window placement: centre the first hit, clamped to the text bounds.
  let start = 0;
  if (text.length > maxLen && firstHit > maxLen / 2) {
    start = Math.min(Math.floor(firstHit - maxLen / 2), text.length - maxLen);
  }
  const end = Math.min(text.length, start + maxLen);

  // Every term occurrence inside the window, merged into disjoint ranges.
  const ranges: { s: number; e: number }[] = [];
  for (const t of terms) {
    let from = start;
    for (;;) {
      const i = lower.indexOf(t, from);
      if (i < 0 || i >= end) break;
      ranges.push({ s: i, e: Math.min(i + t.length, end) });
      from = i + 1;
    }
  }
  ranges.sort((a, b) => a.s - b.s || a.e - b.e);
  const merged: { s: number; e: number }[] = [];
  for (const r of ranges) {
    const last = merged[merged.length - 1];
    if (last && r.s <= last.e) last.e = Math.max(last.e, r.e);
    else merged.push({ ...r });
  }

  const out: SnippetSegment[] = [];
  const pushMiss = (s: string) => {
    if (s !== "") out.push({ text: s, hit: false });
  };
  let cursor = start;
  let head = start > 0 ? "…" : "";
  for (const r of merged) {
    pushMiss(head + text.slice(cursor, r.s));
    head = "";
    out.push({ text: text.slice(r.s, r.e), hit: true });
    cursor = r.e;
  }
  pushMiss(head + text.slice(cursor, end) + (end < text.length ? "…" : ""));
  return out;
}
