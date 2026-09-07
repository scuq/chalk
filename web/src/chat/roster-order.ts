// 114-1: what order the roster renders in.
//
// The channel list had exactly one order and nobody chose it: groups
// alphabetically after General (54-3), channels newest-created first because
// that is the order `channels_loaded` puts in state.channelOrder and every
// step since is careful to leave untouched. Creation date is a fact about a
// channel's birth, not about whether you care about it today.
//
// Two axes, deliberately kept apart. Channels inside a group have a SORT MODE
// -- created (today's order), activity (most recent message first), or manual
// (a list this reader wrote). Groups have only one question, your order or the
// default one, so they get a single list of group keys.
//
// Everything here is pure and TOTAL: whatever the stored prefs hold, the
// result is a complete permutation of the input. A manual list is a
// preference ABOUT channels, not the set of them, so it has to survive the
// roster drifting underneath it -- ids that left are skipped on read (and
// pruned on the next write), channels the list has never heard of append at
// the bottom in the order the group would otherwise have. Bottom, not top: a
// manual order says what matters most, and something that just appeared has
// not earned the top of it.
//
// Structurally typed like channel-hide.ts so the sidebar (ChannelSummary),
// the tests (bare objects) and Zuckermode (its own rows) can all call in
// without dragging a reducer along.

export type ChannelSortMode = "created" | "activity" | "manual";

// The two modes that need no stored list. The account-wide default is one of
// these: "manual" is a statement about one group's channels, and there is no
// single list for the flat, ungrouped roster to follow.
export type AutoSortMode = "created" | "activity";

// The account default, as the settings picker offers it.
export const CHANNEL_SORT_CHOICES: {
  value: AutoSortMode;
  label: string;
  desc: string;
}[] = [
  { value: "created", label: "when they were made", desc: "newest first" },
  { value: "activity", label: "recent activity", desc: "newest message first" },
];

// What a group's own menu offers on top of the account default.
export const GROUP_SORT_LABEL: Record<ChannelSortMode, string> = {
  created: "newest",
  activity: "activity",
  manual: "my order",
};

// Anything that isn't a mode reads as the fallback rather than throwing:
// prefs are a blob, and a junk value must not cost you your roster.
export function normalizeSortMode(
  raw: unknown,
  fallback: ChannelSortMode = "created",
): ChannelSortMode {
  return raw === "created" || raw === "activity" || raw === "manual" ? raw : fallback;
}

// The account default collapses "manual" to "created" -- see AutoSortMode.
export function normalizeAutoSortMode(raw: unknown): AutoSortMode {
  return raw === "activity" ? "activity" : "created";
}

// ---- the comparator -------------------------------------------------------

// The structural subset an activity sort needs.
export interface OrderableChannel {
  id: string;
  createdAt: Date;
}

// 62: what "most recent" means, extracted from buildConversationList rather
// than copied, so the phone's conversation list and the desktop roster can
// never disagree about it. Newest activity, falling back to creation for a
// channel that has never said anything; the id tie-break keeps the order
// stable when timestamps collide (bulk backfills, same-millisecond sends).
export interface Activated {
  id: string;
  when: number;
}

export function compareByActivity(a: Activated, b: Activated): number {
  return b.when - a.when || a.id.localeCompare(b.id);
}

export function activityWhen(
  ch: OrderableChannel,
  activity: Record<string, { ts: number }> = {},
): number {
  return activity[ch.id]?.ts ?? ch.createdAt.getTime();
}

// ---- reads ----------------------------------------------------------------

// applyManual is the whole "survives drift" rule in one place: listed items
// first in list order, unknown ids skipped, duplicates ignored, and whatever
// the list never mentioned following in the input order.
function applyManual<T>(
  items: T[],
  keyOf: (item: T) => string,
  manual: string[] | undefined,
): T[] {
  if (!Array.isArray(manual) || manual.length === 0) return items.slice();
  const pending = new Map<string, T>();
  for (const item of items) {
    const k = keyOf(item);
    if (!pending.has(k)) pending.set(k, item);
  }
  const out: T[] = [];
  for (const k of manual) {
    const item = pending.get(k);
    if (item === undefined) continue; // stale id: skipped on read
    pending.delete(k);
    out.push(item);
  }
  for (const item of items) {
    const k = keyOf(item);
    if (pending.has(k)) {
      pending.delete(k);
      out.push(item);
    }
  }
  return out;
}

// orderChannels puts one group's channels in the order this reader asked for.
// The input is the roster's own order (state.channelOrder, newest-created
// first), which is also what "created" means and what leftovers under a
// manual list fall back to.
export function orderChannels<T extends OrderableChannel>(
  channels: T[],
  mode: ChannelSortMode,
  manual: string[] | undefined,
  activity: Record<string, { ts: number }> = {},
): T[] {
  if (mode === "activity") {
    return channels
      .map((ch) => ({ ch, when: activityWhen(ch, activity) }))
      .sort((a, b) =>
        compareByActivity({ id: a.ch.id, when: a.when }, { id: b.ch.id, when: b.when }),
      )
      .map((x) => x.ch);
  }
  if (mode === "manual") return applyManual(channels, (ch) => ch.id, manual);
  return channels.slice();
}

// The structural subset a group ordering needs -- RosterGroup's key, the
// lower-cased name groups already merge and collapse under, so "Dev" and
// "dev" stay one group here too.
export interface OrderableGroup {
  key: string;
}

// orderGroups: listed groups first in list order, the rest in the input order
// (groupRoster's General-then-alphabetical). An empty or absent list is
// exactly today.
export function orderGroups<T extends OrderableGroup>(
  groups: T[],
  manual: string[] | undefined,
): T[] {
  return applyManual(groups, (g) => g.key, manual);
}

// ---- writes ---------------------------------------------------------------

export type MoveTo = "top" | "up" | "down" | "bottom";

// moveInList is what the menu's order row commits. The caller seeds the list
// with the order currently on screen, so "up" always means "up from where I
// can see it", whichever mode the group was in before.
export function moveInList(ids: string[], id: string, to: MoveTo): string[] {
  const from = ids.indexOf(id);
  if (from < 0) return ids.slice();
  const next = ids.slice();
  next.splice(from, 1);
  const at =
    to === "top"
      ? 0
      : to === "bottom"
        ? next.length
        : to === "up"
          ? Math.max(0, from - 1)
          : Math.min(next.length, from + 1);
  next.splice(at, 0, id);
  return next;
}

// placeInList is what a drag commits (114-4): put id immediately before
// `before`, or at the end when it is null. Dropping something onto its own
// position is a no-op rather than an off-by-one.
export function placeInList(
  ids: string[],
  id: string,
  before: string | null,
): string[] {
  const without = ids.filter((x) => x !== id);
  if (before === null || before === id) return [...without, id];
  const at = without.indexOf(before);
  if (at < 0) return [...without, id];
  return [...without.slice(0, at), id, ...without.slice(at)];
}

// The order half of the roster prefs, as stored and as resolved.
export interface RosterOrderState {
  channelSort: AutoSortMode;
  groupSort: Record<string, ChannelSortMode>;
  channelOrder: Record<string, string[]>;
  groupOrder: string[];
}

// The live roster, as the write path sees it: one entry per group that
// currently renders, carrying the channel ids in it.
export interface LiveGroup {
  key: string;
  channelIDs: string[];
}

// pruneRosterOrder is the write path's single gate. Reads tolerate stale ids
// forever; writes never let one accumulate, which is what keeps a list of
// 36-character UUIDs inside the 8 KiB prefs cap. Ids that are no longer in
// their group go (left, deleted, moved out by a 54-4 override, hidden), and
// so do lists and sort overrides for groups that no longer exist.
//
// A group's list survives its mode switching back to an automatic sort --
// "activity for a while, then back to my order" costs nothing. Only the
// menu's "reset order" deletes one.
export function pruneRosterOrder(
  order: RosterOrderState,
  groups: LiveGroup[],
): RosterOrderState {
  const live = new Map(groups.map((g) => [g.key, new Set(g.channelIDs)]));
  const channelOrder: Record<string, string[]> = {};
  for (const [key, ids] of Object.entries(order.channelOrder)) {
    const alive = live.get(key);
    if (!alive) continue;
    const seen = new Set<string>();
    const kept = ids.filter((id) => {
      if (!alive.has(id) || seen.has(id)) return false;
      seen.add(id);
      return true;
    });
    if (kept.length > 0) channelOrder[key] = kept;
  }
  const groupSort: Record<string, ChannelSortMode> = {};
  for (const [key, mode] of Object.entries(order.groupSort)) {
    if (live.has(key)) groupSort[key] = mode;
  }
  const seenGroup = new Set<string>();
  const groupOrder = order.groupOrder.filter((key) => {
    if (!live.has(key) || seenGroup.has(key)) return false;
    seenGroup.add(key);
    return true;
  });
  return { channelSort: order.channelSort, groupSort, channelOrder, groupOrder };
}

// resolveRosterOrder turns whatever the prefs blob holds into the shape the
// reads above expect. It is the only place that trusts nothing: a stored value
// arrives from another device, an older build, or a hand-edited row, and any
// of those must cost the reader an ignored setting rather than a broken list.
export function resolveRosterOrder(raw: {
  channelSort?: unknown;
  groupSort?: unknown;
  channelOrder?: unknown;
  groupOrder?: unknown;
}): RosterOrderState {
  const groupSort: Record<string, ChannelSortMode> = {};
  for (const [key, mode] of Object.entries(plainObject(raw.groupSort))) {
    if (mode === "created" || mode === "activity" || mode === "manual") {
      groupSort[key] = mode;
    }
  }
  const channelOrder: Record<string, string[]> = {};
  for (const [key, list] of Object.entries(plainObject(raw.channelOrder))) {
    const ids = stringList(list);
    if (ids.length > 0) channelOrder[key] = ids;
  }
  return {
    channelSort: normalizeAutoSortMode(raw.channelSort),
    groupSort,
    channelOrder,
    groupOrder: stringList(raw.groupOrder),
  };
}

function plainObject(raw: unknown): Record<string, unknown> {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return {};
  return raw as Record<string, unknown>;
}

function stringList(raw: unknown): string[] {
  if (!Array.isArray(raw)) return [];
  const seen = new Set<string>();
  const out: string[] = [];
  for (const v of raw) {
    if (typeof v !== "string" || v === "" || seen.has(v)) continue;
    seen.add(v);
    out.push(v);
  }
  return out;
}

// ---- the 8 KiB ------------------------------------------------------------

// prefs_set marshals the patch and refuses anything over this (prefsMaxBytes,
// internal/server/ws.go). Every roster write already ships the WHOLE roster
// object, because the server's merge is shallow -- so this phase, the first
// to put lists rather than exceptions in the blob, checks before sending
// instead of letting the server bounce it silently.
export const PREFS_MAX_BYTES = 8 * 1024;

export const ROSTER_ORDER_FULL_HINT =
  "no room left in your saved settings for another order — reset a group's order first";

// Go's encoding/json escapes <, > and & to six-byte \uXXXX sequences, so a
// group name with one in it costs more on the server than JSON.stringify
// suggests. Count it the server's way; being a few bytes pessimistic is the
// safe direction for a cap.
export function prefsPatchBytes(patch: unknown): number {
  const json = JSON.stringify(patch) ?? "";
  const escaped = json.replace(/[<>&]/g, "\\u0000");
  return new TextEncoder().encode(escaped).length;
}

export function prefsPatchFits(patch: unknown): boolean {
  return prefsPatchBytes(patch) <= PREFS_MAX_BYTES;
}
