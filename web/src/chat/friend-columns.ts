// 132-2: the width of the widest friend row, for the two-column grid.

/** The fields of a friend that decide the width of its row. */
export interface FriendLabel {
  handle?: string | null;
  userID: string;
}

/** The text a friend row shows, the same rule as the Sidebar row. */
export function friendLabel(f: FriendLabel): string {
  return f.handle || f.userID.slice(-8);
}

/** longestFriendName returns the character count of the longest row label. */
export function longestFriendName(friends: readonly FriendLabel[]): number {
  let n = 0;
  for (const f of friends) {
    const len = friendLabel(f).length;
    if (len > n) n = len;
  }
  return n;
}

// The parts of a row beside the name: the 8px dot, the 0.5rem gap, 8px of
// padding on each side and the 2px active border. With roster avatars on,
// the 16px picture and its 8px margin add to this.
const FIXED_PX = 8 + 16 + 2;
const AVATAR_PX = 16 + 8;

/**
 * friendColumnMinWidth returns the CSS length of a row that shows `chars`
 * monospace characters, for the grid's --chalk-friend-col.
 */
export function friendColumnMinWidth(chars: number, avatars: boolean): string {
  const fixed = FIXED_PX + (avatars ? AVATAR_PX : 0);
  return `calc(${chars}ch + 0.5rem + ${fixed}px)`;
}
