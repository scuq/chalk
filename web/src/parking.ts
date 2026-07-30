// chalk-web -- the parking lot: somewhere to put chalk when someone walks up
// behind you.
//
// One click and the conversation pane is a logo on an empty field. Chalk stays
// connected, the call keeps running, the window keeps its shape -- there is
// simply nothing left in it to read. Leaving is picking any channel again.
//
// Two things live here: the name the row carries (an account pref, so the
// title you chose follows you to your other devices -- see
// selectParkingLotPrefs in state/types.ts) and whether this browser is
// currently parked, which is per-device by nature and survives a reload. That
// last part matters: without it, F5 drops you straight back into the last
// channel you had open, which is the one moment you least want it.

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

const PARKED_KEY = "chalk.parked.v1";

export function loadParked(): boolean {
  try {
    return window.localStorage.getItem(PARKED_KEY) === "1";
  } catch {
    // Private-browsing localStorage throws. Not being parked is the safe
    // reading of "we don't know": the user is one click from parking again.
    return false;
  }
}

export function saveParked(parked: boolean): void {
  try {
    if (parked) window.localStorage.setItem(PARKED_KEY, "1");
    else window.localStorage.removeItem(PARKED_KEY);
  } catch {
    // Same as above: parking just won't survive the reload.
  }
}
