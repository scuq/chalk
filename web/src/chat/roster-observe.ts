// chalk -- 83-7: client-derived roster-change notices (D.6).
//
// Membership is server-asserted and its integrity is trusted (claim 1,
// narrowed by R18-01) -- but a database write is a real threat the trust
// model does not defend, and the one thing that must never happen is a
// membership change nobody sees. The 82-8 join notice is emitted by the
// server off its own event stream, so a direct database insert produces no
// event and no notice. This module makes the notice CLIENT-DERIVED: each
// client persists the last roster it observed -- the set of
// (member, current identity fingerprint) -- and diffs every fresh
// observation against it, so the notice fires regardless of how the roster
// changed.
//
// THE PROPERTY, stated precisely (R19/R20's correction -- never "silent
// changes are impossible"): unauthorized roster changes are surfaced to any
// existing client that OBSERVES the changed roster. Detection, not
// prevention; no guarantee for changes that are never observed (inserted
// and removed entirely between two observations), and visibility timing
// follows the refresh flows that already run.
//
// THE FROZEN ORDERING (R19's hardening, kept under R20's framing): fetch
// roster -> compute the diff -> PERSIST and surface additions -> only then
// may auto-reshare wrap to the new roster. The promise is mechanical, not
// human: observe() resolves only after the updated baseline AND its notices
// are persisted, and every wrap path awaits it first -- the record always
// precedes the key, whether the user has read it yet is theirs.
//
// The notice is local UI, not a message: not signed, not sent, and not
// attributable to an actor -- the whole point is that no trustworthy actor
// record exists for a DB insert. It says WHAT changed in the membership this
// client now sees, never WHO did it.

import type { ObservedRosterRecord } from "../crypto/idb";
import type { VerifiedGeneration } from "../crypto/idgen";

export type RosterNoticeKind = "added" | "removed" | "key-rotated" | "key-changed";

export interface RosterNotice {
  kind: RosterNoticeKind;
  userID: string;
  handle?: string;
  at: number;
}

export interface ObservedMember {
  userID: string;
  fpHex: string;
}

/** The pure diff: additions, removals, and fingerprint changes. */
export function diffRoster(
  prev: ObservedMember[],
  next: ObservedMember[],
): {
  added: ObservedMember[];
  removed: ObservedMember[];
  changed: Array<{ userID: string; oldFp: string; newFp: string }>;
} {
  const prevBy = new Map(prev.map((m) => [m.userID, m.fpHex]));
  const nextBy = new Map(next.map((m) => [m.userID, m.fpHex]));
  const added = next.filter((m) => !prevBy.has(m.userID));
  const removed = prev.filter((m) => !nextBy.has(m.userID));
  const changed: Array<{ userID: string; oldFp: string; newFp: string }> = [];
  for (const m of next) {
    const old = prevBy.get(m.userID);
    if (old !== undefined && old !== "" && m.fpHex !== "" && old !== m.fpHex) {
      changed.push({ userID: m.userID, oldFp: old, newFp: m.fpHex });
    }
  }
  return { added, removed, changed };
}

/** Injected dependencies, so the orchestration is testable without idb,
 *  a transport, or WebCrypto. */
export interface RosterObserverDeps {
  /** Current identity fingerprint (hex) for a member; "" when unresolvable
   *  (no published identity / offline) -- tracked as present-with-unknown-key,
   *  never treated as a key change. */
  resolveFp(userID: string): Promise<string>;
  /** The member's VERIFIED generation chain (83-4), for classifying a
   *  fingerprint change as chained rotation vs. the unlinked wall. */
  chainFor(userID: string): Promise<VerifiedGeneration[]>;
  load(channelID: string): Promise<ObservedRosterRecord | null>;
  save(record: ObservedRosterRecord): Promise<void>;
}

const MAX_NOTICES = 50;

export class RosterObserver {
  // one observation at a time per channel; concurrent observers of the same
  // roster would double-report a diff.
  private inFlight = new Map<string, Promise<RosterNotice[]>>();
  // additions/removals already rendered from a NORMAL membership event this
  // session (the 82-8 event-sourced notice): the observed diff skips them --
  // "distinct from an event-sourced notice" cuts both ways.
  private expected = new Map<string, Set<string>>();

  constructor(private deps: RosterObserverDeps) {}

  /** expectChange records that a membership event already told the UI about
   *  this addition ("add") or removal ("rm"), so the next diff stays quiet
   *  about it. */
  expectChange(channelID: string, kind: "add" | "rm", userID: string): void {
    let set = this.expected.get(channelID);
    if (!set) this.expected.set(channelID, (set = new Set()));
    set.add(`${kind}:${userID}`);
  }

  /**
   * observe diffs the roster now visible against the persisted baseline,
   * persists the new baseline together with its notices, and returns ALL
   * undismissed notices for the channel (stored ++ new). Resolves only after
   * the write -- callers gate every wrap on it (the frozen ordering).
   *
   * The FIRST observation of a channel establishes the baseline silently:
   * there is no previous observation to have changed from.
   */
  observe(channelID: string, memberIDs: string[], handles?: Map<string, string>): Promise<RosterNotice[]> {
    const existing = this.inFlight.get(channelID);
    if (existing) return existing;
    const run = this.observeLocked(channelID, memberIDs, handles).finally(() => {
      this.inFlight.delete(channelID);
    });
    this.inFlight.set(channelID, run);
    return run;
  }

  private async observeLocked(
    channelID: string,
    memberIDs: string[],
    handles?: Map<string, string>,
  ): Promise<RosterNotice[]> {
    const now = Date.now();
    const next: ObservedMember[] = [];
    for (const id of [...new Set(memberIDs)]) {
      next.push({ userID: id, fpHex: await this.deps.resolveFp(id) });
    }
    const stored = await this.deps.load(channelID);
    if (!stored) {
      await this.deps.save({ channelID, members: next, notices: [], observedAt: now });
      return [];
    }

    // An unresolvable fingerprint must not erase a known one: keep the old
    // value for the baseline so a later resolution diffs against the truth.
    const prevBy = new Map(stored.members.map((m) => [m.userID, m.fpHex]));
    for (const m of next) {
      if (m.fpHex === "" && prevBy.get(m.userID)) m.fpHex = prevBy.get(m.userID)!;
    }

    const { added, removed, changed } = diffRoster(stored.members, next);
    const expected = this.expected.get(channelID) ?? new Set<string>();
    const fresh: RosterNotice[] = [];
    for (const m of added) {
      if (expected.delete(`add:${m.userID}`)) continue;
      fresh.push({ kind: "added", userID: m.userID, handle: handles?.get(m.userID), at: now });
    }
    for (const m of removed) {
      if (expected.delete(`rm:${m.userID}`)) continue;
      fresh.push({ kind: "removed", userID: m.userID, handle: handles?.get(m.userID), at: now });
    }
    for (const c of changed) {
      // 83-4's chain answers whether the change is the sender's own doing: a
      // chain that verifiably links old to new fingerprint is a rotation (the
      // softer line); anything else is the unlinked identity-changed wall.
      let kind: RosterNoticeKind = "key-changed";
      try {
        const chain = await this.deps.chainFor(c.userID);
        const oldIdx = chain.findIndex((g) => g.fpHex === c.oldFp);
        const newIdx = chain.findIndex((g) => g.fpHex === c.newFp);
        if (oldIdx !== -1 && newIdx !== -1 && oldIdx < newIdx) kind = "key-rotated";
      } catch {
        // unreachable chain: stays the louder kind
      }
      fresh.push({ kind, userID: c.userID, handle: handles?.get(c.userID), at: now });
    }

    const notices = [...stored.notices, ...fresh].slice(-MAX_NOTICES);
    // THE ordering: baseline + notices hit storage before observe resolves,
    // and every wrap path awaits observe. The record precedes the key.
    await this.deps.save({ channelID, members: next, notices, observedAt: now });
    return notices;
  }

  /** dismiss clears the channel's stored notices (the user has seen them). */
  async dismiss(channelID: string): Promise<void> {
    const stored = await this.deps.load(channelID);
    if (!stored || stored.notices.length === 0) return;
    await this.deps.save({ ...stored, notices: [] });
  }
}

/** noticeText renders one notice the way the bar shows it. */
export function noticeText(n: RosterNotice): string {
  const who = n.handle || n.userID;
  switch (n.kind) {
    case "added":
      return `${who} was added to the channel`;
    case "removed":
      return `${who} was removed from the channel`;
    case "key-rotated":
      return `${who} rotated their identity key`;
    case "key-changed":
      return `⚠ ${who}’s identity key changed and cannot be linked to their previous key`;
  }
}
