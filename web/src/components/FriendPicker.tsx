// FriendPicker: render the caller's friends as checkboxes. Used inside
// CreateChannelModal. Phase 08b.
//
// singleSelect=true switches to radio-like behavior (selecting one
// deselects the others). Used when isDM in the parent modal.

import type { Friend } from "../state/types";

interface Props {
  friends: Friend[];
  selected: Set<string>;
  singleSelect: boolean;
  onChange: (s: Set<string>) => void;
}

export function FriendPicker({ friends, selected, singleSelect, onChange }: Props) {
  const toggle = (uid: string) => {
    const next = new Set(selected);
    if (singleSelect) {
      // Radio-like: select only this one.
      next.clear();
      if (!selected.has(uid)) {
        next.add(uid);
      }
    } else {
      if (next.has(uid)) next.delete(uid);
      else next.add(uid);
    }
    onChange(next);
  };

  return (
    <ul class="chalk-friend-picker" data-testid="friend-picker">
      {friends.map((f) => (
        <li
          key={f.userID}
          class={`chalk-friend-picker-item ${selected.has(f.userID) ? "chalk-friend-picker-item--selected" : ""}`}
          data-testid="friend-picker-item"
          data-user-id={f.userID}
          data-selected={selected.has(f.userID) ? "true" : "false"}
          onClick={() => toggle(f.userID)}
        >
          <input
            type={singleSelect ? "radio" : "checkbox"}
            name="friend-picker"
            checked={selected.has(f.userID)}
            readOnly
            tabIndex={-1}
            aria-label={f.userID}
          />
          <span class="chalk-friend-picker-id">@{f.userID.slice(0, 8)}</span>
        </li>
      ))}
    </ul>
  );
}
