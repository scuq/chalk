// chalk-web -- the parking lot: somewhere to put chalk when someone walks up
// behind you.
//
// One click and the conversation pane is a logo on an empty field. Chalk stays
// connected, the call keeps running, the window keeps its shape -- there is
// simply nothing left in it to read. Leaving is picking any channel again.
//
// It is also the startup screen: every session begins parked (see initialState
// in state/types.ts), so a reload or restart never opens a conversation on its
// own -- F5 with someone behind you lands here, not in the channel you had
// open. What lives in this file is the name the row carries, an account pref
// so the title you chose follows you to your other devices -- see
// selectParkingLotPrefs in state/types.ts.

export const PARKING_LOT_DEFAULT_NAME = "Parking Lot";

// Long enough for a phrase, short enough that the sidebar row still ellipsises
// rather than becoming the widest thing in the column.
export const PARKING_LOT_NAME_MAX = 32;

// parkingLotName normalizes a stored title: one line, trimmed, capped, and
// never empty -- an all-whitespace name would leave an unlabelled row.
export function parkingLotName(raw: unknown): string {
  if (typeof raw !== "string") return PARKING_LOT_DEFAULT_NAME;
  const cleaned = raw.replace(/\s+/g, " ").trim().slice(0, PARKING_LOT_NAME_MAX);
  return cleaned || PARKING_LOT_DEFAULT_NAME;
}
