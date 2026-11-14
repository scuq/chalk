// chalk-web -- the phone conversation list's filter, as pure data.
//
// A filter has two parts: a kind (one chip of the filter bar) and a text
// (the name field). A row must match both. Pure and structurally typed, so
// it is testable without a DOM.

import type { ZuckerRow } from "./zucker";

// A ZuckerKind is one chip of the filter bar.
export type ZuckerKind = "all" | "unread" | "mentions" | "channels" | "dms" | "voice";

// ZUCKER_KINDS lists the chips in display order, with their labels.
export const ZUCKER_KINDS: readonly { kind: ZuckerKind; label: string }[] = [
  { kind: "all", label: "all" },
  { kind: "unread", label: "unread" },
  { kind: "mentions", label: "mentions" },
  { kind: "channels", label: "channels" },
  { kind: "dms", label: "DMs" },
  { kind: "voice", label: "voice" },
];

type FilterRow = Pick<ZuckerRow, "name" | "matchText" | "isDM" | "isVoice" | "unread" | "mention">;

// matchesKind reports whether row belongs to kind. A row counts as a mention
// only while it is unread. A channel is a row that is not a DM and not a
// voice room.
export function matchesKind(row: FilterRow, kind: ZuckerKind): boolean {
  switch (kind) {
    case "all":
      return true;
    case "unread":
      return row.unread;
    case "mentions":
      return row.unread && row.mention;
    case "channels":
      return !row.isDM && !row.isVoice;
    case "dms":
      return row.isDM;
    case "voice":
      return row.isVoice;
  }
}

// zuckerFilterActive reports whether the kind or the text narrows the list.
// Text of only spaces does not count.
export function zuckerFilterActive(kind: ZuckerKind, query: string): boolean {
  return kind !== "all" || query.trim() !== "";
}

// filterZuckerRows returns the rows that match kind and query. The query is
// trimmed and matched without case, as a substring of matchText, or of name
// when a row has no matchText. When no filter is active, it returns rows
// itself, so a caller can tell that nothing is filtered.
export function filterZuckerRows<T extends FilterRow>(rows: T[], kind: ZuckerKind, query: string): T[] {
  if (!zuckerFilterActive(kind, query)) return rows;
  const q = query.trim().toLowerCase();
  return rows.filter(
    (r) => matchesKind(r, kind) && (q === "" || (r.matchText ?? r.name).toLowerCase().includes(q)),
  );
}
