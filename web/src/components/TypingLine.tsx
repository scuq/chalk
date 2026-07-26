// chalk-web -- the "alice is typing..." line above the composer.
//
// Subscribes to the typing store directly rather than reading app state, so
// the store's once-a-second expiry sweep re-renders this one line and nothing
// else. Deciding what the line SAYS is pure and lives in ../chat/typing.ts;
// this file only resolves ids to handles and paints them.

import type { JSX } from "preact";

import { resolveNickHue } from "../chat/nickcolor";
import { typingSegments } from "../chat/typing";
import { useTypists } from "../chat/typing-store";
import type { ChannelMember, ResolvedChatPrefs } from "../state/types";

interface Props {
  channelID: string | null;
  members: ChannelMember[] | undefined;
  isDM: boolean;
  display: ResolvedChatPrefs;
}

export function TypingLine({ channelID, members, isDM, display }: Props): JSX.Element | null {
  // Called unconditionally: hooks can't sit behind an early return. Passing
  // null when the viewer has the feature off unsubscribes rather than
  // rendering blank.
  const typists = useTypists(display.typingIndicators ? channelID : null);

  if (!display.typingIndicators) return null;

  const handleByUser = new Map<string, string>();
  for (const m of members ?? []) {
    if (m.userID && m.handle) handleByUser.set(m.userID, m.handle);
  }
  // Drop anyone we can't name. "someone and bob are typing" reads worse than
  // "bob is typing", and a line of nothing but "someone" spends a row to say
  // nothing. Misses are self-healing: the next channel listing fills the
  // roster in. This also decides the crowd threshold, which counts the names
  // actually shown.
  const handles: string[] = [];
  for (const id of typists) {
    const handle = handleByUser.get(id);
    if (handle) handles.push(handle);
  }

  // 9.7e's per-user color rules are scoped, and "dm" rules apply only in a
  // DM -- the same filter MessageList runs before tinting a sender label.
  const colorByHandle = new Map<string, string>();
  for (const rule of display.userColors) {
    if (!rule.handle || !rule.color) continue;
    if (rule.scope === "dm" && !isDM) continue;
    const key = rule.handle.toLowerCase();
    if (!colorByHandle.has(key)) colorByHandle.set(key, rule.color);
  }

  // The element stays in the tree with nothing to say. The footer is a grid
  // row: letting it grow and shrink would resize the message pane under
  // someone who is reading it.
  return (
    <div class="chalk-typing" aria-live="polite">
      {typingSegments(handles).map((seg, i) => {
        const hue =
          seg.handle === null
            ? null
            : resolveNickHue({
                enabled: display.userColorsEnabled,
                own: false,
                handle: seg.handle,
                selfHue: display.selfColorHue,
                userHues: display.userHues,
                legacyColorByHandle: colorByHandle,
              });
        return (
          <span
            key={i}
            class={hue !== null ? "chalk-message-sender--tinted" : undefined}
            style={hue !== null ? `--nick-h:${hue}` : undefined}
          >
            {seg.text}
          </span>
        );
      })}
    </div>
  );
}
