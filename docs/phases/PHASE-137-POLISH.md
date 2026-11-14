# Phase 137 — phone polish from the external design review

**Status:** in progress. 137-1 to 137-5 are built (2026-11-14). 137-6 and 137-7 are not started. The device checks of 137-1 to 137-5 are open, in the manual checklist.
**Tags:** `#composer`, `#mobile` → `tools/where.sh -g composer`

## The problem

An external review examined the phone layout of chalk as an iPhone standalone PWA.
The review asks for an evolution of the current interface, not a new design.
Its four main items are the composer, the conversation list, message grouping, and consistent navigation.
Phase 136 is the planned iOS wrapper, so this phase has the next free number.

Much of the review is already true, and this phase does not build it again:

- The shell follows `visualViewport` (`web/src/viewport.ts`).
- The header and the footer have the safe-area insets.
- The fields have a 16 px floor, the targets are 44 px, and a 500 ms long press opens the message menu.
- The feed stays at the bottom only while the reader is near it (`PINNED_THRESHOLD_PX` in `MessageList.tsx`).
- The conversation list stays mounted and restores its scroll position.

## The design

Each slice puts its rules in the phone block of `web/src/theme.css` (`@media (max-width: 767px)`).
These constraints apply to each slice:

- The desktop layout does not change.
- No color, theme variable, or theme definition changes. Each rule uses the existing tokens.
- No new dependency.
- Motion uses the duration tokens. The reduced-motion rule sets them to 0 ms, so no slice adds its own reduced-motion rule.

### 137-1 Composer: full-width field, tools row below

Before 137-1, the phone showed a 2x2 block of tools to the left of a 72 px field.
The composer is now one outlined box with two rows.
The field is on top at full width.
The four tools (attach, GIF, emoji, and code) are below it on the left, and send is below it on the right.
GIF shows only when Giphy is on.

- `.chalk-composer-row` is a grid with the areas `"input input"` and `"tools send"`. The DOM order does not change, so the desktop markup stays the same.
- The row draws the one outline. The field has none. Focus or edit mode turns the outline to the accent color.
- Each tool and send is 44 px high. Each tool is 44 px wide.
- The field has a minimum height of two lines. The maximum is 40 % of `--chalk-shell-h`, so the cap follows the keyboard. Past the maximum, the field scrolls inside.
- The field grows with the draft. `composerAutoHeight(scrollHeight, min, max)` in `web/src/chat/composer-height.ts` is a pure function that limits the height. A layout effect in `Composer.tsx` runs it on the phone. On desktop, the effect clears the inline height, so the 91-1 drag height applies again.
- The emoji picker was `position: fixed` with `bottom: 96px`, a number tied to the old composer height. A `ResizeObserver` in `Composer.tsx` writes the composer height to `--chalk-composer-block`, on the phone only. The picker sits above the composer by that height, with 132 px as the fallback, plus the safe-area padding of the footer.
- In edit mode, the tools keep `visibility: hidden`, so the row height does not change and save stays on the right.
- The thread panel uses the same `Composer`, so it gets the same layout.

Measured in a headed iPhone 14 emulation:

- An empty field is 56 px high.
- A draft of 14 lines grows the field to 266 px, and then it scrolls.
- Clearing the draft returns the field to 56 px.
- At 320 px there is no horizontal overflow.
- The emoji picker bottom is 8 px above the composer.

### 137-2 Message grouping and phone typography

Before 137-2, each row showed its time and its sender.
Now the phone shows them on the first row of a group only.
Desktop does not change.

- A new pure module, `web/src/chat/message-runs.ts`, has `continuesRun(prev, cur)` and `RUN_GAP_MS` (five minutes). `continuesRun` returns true when all of these are true:

  - Neither message is deleted.
  - Both messages have the same non-empty author.
  - The second message is 0 ms to `RUN_GAP_MS` after the first. The limit is inclusive.
- The author is the user id. If the user id is empty, the author is the device id. If both are empty, as for a purged sender, the author is empty and the message never joins a run. Two devices of one account are one author.
- `MessageList.tsx` sets a `cont` flag for each row and adds the class `chalk-message--cont` when it is true. A day mark or the unread divider at that index always starts a new run. The time and the sender stay in the DOM for screen readers and for desktop.
- The phone CSS gives each row a top padding of `--chalk-s2`. A continued row has 1 px, and its time and sender are hidden.
- `MessageList.tsx` passes `m.ts.toLocaleString()` to `MessageMenu` as the new optional prop `when`. The menu shows it as its first line (`.chalk-msgmenu-when`). The base rule hides that line, because desktop keeps the time on every row and in its title tooltip. Only the phone block shows it.
- The row of an open menu has `--chalk-bg-hover` as its pressed state.
- On the phone, `.chalk-message-body` is 15 px times `--chalk-font-scale`, with `line-height: 1.5`. The existing rule `overflow-wrap: anywhere` stays.

Measured in a headed iPhone 14 emulation:

- The first row of a group is 51 px high. A follow-up row is 28 px high.
- The body text is 15 px.
- A long URL and a long unbroken string wrap with no horizontal overflow at 390 px and at 320 px. No new wrap rule was necessary.
- A long press on a follow-up row opens the menu with the full timestamp as its first line, inside the viewport.

### 137-3 Conversation rows

Before 137-3, the unread dot was the last child of the row button, a column of its own.
On an unread row, the time ended about 22 px further left than on a read row.
Now the dot sits at the end of the preview line, under the time, and every row ends its time at the same edge.

- `ZuckerList.tsx` adds the class `chalk-zucker-row--unread` to an unread row.
- A new `<span class="chalk-zucker-row-bottom">` holds the preview (or the voice occupants) and the unread dot. It is a flex row. The preview and the occupants take `flex: 1 1 auto`.
- A row is at least 64 px high (it was 56 px). Its horizontal padding is 16 px, `--chalk-s4` (it was `--chalk-s3`).
- A row has `touch-action: manipulation`, so a double tap does not zoom and a tap has no delay.
- `-webkit-tap-highlight-color` is transparent, so the grey flash of iOS does not show. A pressed row (`:active`) has `--chalk-bg-hover` as its background, with a `--chalk-dur-fast` transition.
- An unread name has `font-weight: 700`. A read name keeps the regular weight and its color.
- The head, the pinned rows, the filter, the friend rows, and the "no friends yet" line have the same 16 px edge. The friend rows keep their double indent, now 2 x `--chalk-s4`.
- The last row of a shelf has no bottom border, because the shelf draws one. The two lines no longer double up.

The plan gave a read name a weight of 600.
That was dropped.
Every bundled font has only a 400 face and a 700 face. The fonts are Hack, JetBrains Mono, Fira Code, and Cascadia Code. A weight of 600 renders bold.
Every name would look unread.
The name still leads its row through the base size and `--chalk-fg-bright`, against the small, muted preview.

Measured in a headed iPhone 14 emulation, at 390 px and at 320 px:

- Every row is 64 px high.
- The head title, the pinned labels, and the row badges share one left edge.
- An unread name has weight 700. A read name has weight 400.
- A long channel name ends in an ellipsis.
- The times and the dots end at the same x position on every row.
- There is no horizontal overflow.

### 137-4 List section rows

The pinned rows are parking, friends, voice, threads, and hidden.
Only friends, voice, and hidden expand.

- The three rows that expand get a chevron as the last child: `<span class="chalk-zucker-chevron" aria-hidden="true"><ChevronIcon /></span>`. Parking and threads get no chevron, because they open a screen.
- `ChevronIcon` is new in `web/src/components/icons.tsx`. It is 14 px with the fine stroke, in the shared icon family. The plan named a text glyph. An SVG icon matches the other icons and turns without a font change.
- The chevron is decoration. The row button carries `aria-expanded`.
- The hidden row drops its old text glyph (a down or right triangle before the word) and keeps the word "hidden".
- The chevron is dim and sits at the right end of the row. It turns 90 degrees under `[aria-expanded="true"]` on the `--chalk-dur` transition.
- When a note or an unread dot comes first, they take the auto margin and the chevron sits beside them.
- The label of an expanded row is `--chalk-fg-bright`. This is an understated mark of the open section.
- A pinned row has `touch-action: manipulation` and a transparent `-webkit-tap-highlight-color`. A pressed row (`:active`) has `--chalk-bg-hover` as its background, with a `--chalk-dur-fast` transition.
- The friends list and every shelf (`.chalk-zucker-friends` and `.chalk-zucker-rows--shelf`) fade in with a 4 px slide (`chalk-zucker-shelf-in`, `--chalk-dur`). The collapse stays instant.

The slice also fixes an older fault.
The note and the unread dot both had `margin-left: auto`, so the free space split between them.
On the voice and hidden rows the dot floated in the middle of the row.
The rule `.chalk-zucker-pinned-note ~ .chalk-unread-dot { margin-left: 0 }` fixes it.

Measured in a headed iPhone 14 emulation at 390 px:

- Each section row is 44 px high.
- The right edge of the friends chevron is at 366 px. This is the edge of the conversation-row times.
- The collapsed chevron has `transform: none`. The expanded chevron has `matrix(0, 1, -1, 0, 0, 0)`, which is 90 degrees.
- The friends list runs the `chalk-zucker-shelf-in` animation.
- There is no horizontal overflow.
- The voice row was not seen, because voice rooms are off on the dev stack. It has the same markup and the same rules.

### 137-5 Headers

Before 137-5, the global header could wrap onto two rows when the username was long.
Now it is one row on the phone, and a long username ends in an ellipsis.
In the channel header, a long channel name pushed the buttons off the screen.
Now only the name shrinks.

- `StatusBar.tsx` puts the text "you (name)" of the account menu trigger in `<span class="chalk-status-menu-name">`, with " ▾" after it. The trigger is an inline-flex button on the phone. `text-overflow` cannot cut a bare text node inside a flex container, but it can cut a span. A flex container also drops the space before the arrow, so the trigger has a gap of `--chalk-s1`.
- `.chalk-header` has `flex-wrap: nowrap` and `min-width: 0`. The brand cluster (`.chalk-header-left`) and the presence picker have `flex: 0 0 auto`. `.chalk-status`, `.chalk-status-menu`, and the trigger have `min-width: 0` and can shrink. The trigger stays 44 px high.
- `SearchIcon` is new in `web/src/components/icons.tsx`. It is 18 px with the fine stroke, in the shared icon family. The plan did not have it. On the phone, the search button of the channel header shows the icon. It is a square icon button like the other buttons of the header. On desktop it shows the word "search". The button keeps `aria-label="search messages"`. The voice room button "call" keeps its text.
- In the channel header, `.chalk-channel-header-name` has `flex: 1 1 auto`, and every other child has `flex-shrink: 0`. Only the name gives way. The back button, the mode badge, the encryption indicator, and search are each 44 px by 44 px and stay grouped on the right.
- The comment of the header rule named a "☰ button". That button no longer exists, so the comment now says the header fits in one row.

The key finding is the grid item.
`.chalk-header` is a grid item of `.chalk-app`, so its automatic minimum width is the sum of what its children need.
`min-width: 0` on the children does not lower that sum.
Without `min-width: 0` on the header, a 32-character username made the header 471 px wide on a 390 px screen.
The grid then pushed the whole column 81 px off the left edge.
The first demo run showed this.

Measured in a headed iPhone 14 emulation, with a 32-character username and a 52-character channel name:

- At 390 px, the header is one row, 61 px high, inside the screen.
- At 390 px, the brand is 79 px wide, the presence picker is 73 px, and the account trigger is 206 px with the name cut by an ellipsis.
- At 320 px, the account trigger is 136 px.
- In the channel header, the back button, the mode badge, the encryption indicator, and search are each 44 px by 44 px.
- The channel name is 129 px wide at 390 px and 59 px at 320 px, with an ellipsis.
- There is no horizontal overflow at either width.

### 137-6 Empty states

The parking lot mark is `min(55%, 45vh)` wide at an opacity of 0.28.
A phone rule sets the width to 96 px.
The opacity and the color do not change.
The titled empty feed has a 72 px mark and stays as it is.

### 137-7 List and chat transition

The switch between the list and a chat is an instant `hidden` toggle.
A live swipe-back drag exists (`web/src/chat/use-swipe-back.ts`).

- The slice has enter animations only. No unmount is delayed, and `web/src/nav/phone-stack.ts` does not change.
- The chat content slides in from the right when the list hides. The list slides in from the left when it shows. The duration is the `--chalk-dur` token.
- A back navigation that the swipe completed must not play the list animation again. The swipe completion signal skips it.
- If the two motions cannot work together without a change to the swipe logic, stop and ask the owner.

## Decisions

- The phase covers the full review, in slices.
- The phone toolbar keeps all four tools: attach, GIF, emoji, and code.
- A follow-up message in a group shows its time in the long-press menu.
- The list and the chat get a short slide transition, as the last slice (137-7).

## What was rejected

- A toolbar with three tools. The owner chose to keep all four.
- A tap on a message to show the time of a follow-up message. The time goes in the long-press menu.
- CSS `field-sizing`. 137-1 sizes the field with a script.
- An animated collapse of a list section. The sublists mount and unmount, so an animated collapse needs a delayed unmount. That is a logic change, and the review excludes it.

## Slices

| Slice | Status | Content |
|---|---|---|
| 137-1 | built | Composer: full-width field, tools row below |
| 137-2 | built (2026-11-14) | Message grouping and phone typography |
| 137-3 | built (2026-11-14) | Conversation rows |
| 137-4 | built (2026-11-14) | List section rows |
| 137-5 | built (2026-11-14) | Headers |
| 137-6 | not started | Empty states |
| 137-7 | not started | List and chat transition |

## Left open

- Only a real iPhone PWA shows the keyboard behavior. The device checks of 137-1 are open.
- The device checks of 137-2 are open, in the manual checklist.
- The device checks of 137-3 are open, in the manual checklist.
- The device checks of 137-4 are open, in the manual checklist.
- The device checks of 137-5 are open, in the manual checklist.
- The index row of phase 136 links `docs/phases/PHASE-136-IOS.md`. This phase does not change it.

## Manual checklist

- [ ] 137-1: an iPhone with chalk installed to the home screen. Tap the field. The composer stays above the keyboard, with no gap.
- [ ] 137-1: an iPhone. The page does not jump when the field gets focus.
- [ ] 137-1: an iPhone, with the keyboard open. Type a long draft. The field grows, stops at 40 % of the shell height, and then scrolls inside. The feed does not move off the screen.
- [ ] 137-1: an iPhone. Clear the draft. The field returns to two lines.
- [ ] 137-1: an iPhone, with the keyboard open. Open the emoji picker. It sits above the composer and does not overlap the field.
- [ ] 137-1: an Android phone in Chrome. The same five checks give the same results.
- [ ] 137-1: edit a message on a phone. The tools are hidden, the row keeps its height, and save stays on the right.
- [ ] 137-1: open a thread on a phone. The thread composer has the same layout.
- [ ] 137-2: a phone. Long-press a follow-up row. The menu shows the full time of that message as its first line, inside the screen.
- [ ] 137-2: a phone, with timestamps turned off in settings. Messages still group, and a long press still shows the time.
- [ ] 137-2: a phone. Open a thread. The reply head row shows its name and time, and the replies group as in a channel.
- [ ] 137-3: a phone. Press a conversation row and hold. The row shows the pressed shade. The shade clears when you lift your finger or a tap opens the chat.
- [ ] 137-3: a phone, with a voice room that has people in it and an unread message. The row shows the names of the people, and the unread dot is at the right end of that line, under the time.
- [ ] 137-3: a phone, with the hidden shelf open. The last row of the shelf has no doubled bottom line.
- [ ] 137-4: a phone, with a live voice room and an unread dot. The voice row shows the live count, then the dot, then the chevron. The dot is not in the middle of the row.
- [ ] 137-4: a phone, with hidden conversations and an unread one among them. The hidden row shows its count, the dot, and the chevron, with no text triangle.
- [ ] 137-4: a phone. Tap each of the three rows. The chevron turns, the label gets brighter, and the sublist fades in. A second tap closes it at once.
- [ ] 137-4: a phone, with reduced motion turned on. The sublist appears with no fade and the chevron turns with no animation.
- [ ] 137-5: a phone, with a long display name. The header is one row, the name ends in an ellipsis, and the page does not move sideways.
- [ ] 137-5: a phone. Tap the account menu trigger. The menu opens and fits inside the screen.
- [ ] 137-5: a phone, in a voice room. The channel header shows the "call" button, and all buttons stay inside the screen beside a long room name.
- [ ] 137-5: a phone, in a direct message. The header shows the "dm" tag, and a long name ends in an ellipsis with the buttons in place.
