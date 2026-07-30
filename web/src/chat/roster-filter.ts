// 54-1: roster filtering, shared by the sidebar's friends and channels
// sections. Pure so it can be tested without a DOM.

// Show a filter input only when the list is long enough that scanning it
// stops working. Below the threshold the input would be clutter.
export const ROSTER_FILTER_THRESHOLD = 7;

export function showRosterFilter(count: number): boolean {
  return count >= ROSTER_FILTER_THRESHOLD;
}

// Case-insensitive substring match over a caller-supplied display name.
// An empty or whitespace-only query passes everything through (same array,
// so render paths can cheaply detect "not filtering").
export function filterRoster<T>(
  items: T[],
  query: string,
  name: (item: T) => string
): T[] {
  const q = query.trim().toLowerCase();
  if (!q) return items;
  return items.filter((item) => name(item).toLowerCase().includes(q));
}
