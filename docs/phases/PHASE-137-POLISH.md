# Phase 137 — phone polish from the external design review

**Status:** in progress. 137-1 is built (2026-11-14). 137-2 to 137-7 are not started. The device checks of 137-1 are open, in the manual checklist.
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

No grouping exists today. Each row shows time and sender.

- A new pure module, `web/src/chat/message-runs.ts`, has `continuesRun(prev, cur)`. It returns true when all of these are true:

  - The two messages have the same sender.
  - The two messages are five minutes or less apart.
  - Neither message is deleted.
  - No day divider and no unread divider is between them.
- `MessageList.tsx` adds the class `chalk-message--cont` when `continuesRun` is true. The time and sender stay in the DOM for screen readers and for desktop.
- The phone CSS hides the time and the sender of a continued row. A row that starts a group gets a larger top padding. The body text gets `line-height: 1.5`.
- `MessageMenu.tsx` gets the formatted time of the message and shows it as a first line. Only the phone block shows that line.
- Check `.chalk-message-code` and long URLs at 320 px. Add a wrap rule to the phone block only where the check shows an overflow.

### 137-3 Conversation rows

- `ZuckerList.tsx` adds the class `chalk-zucker-row--unread` when a row is unread.
- A row is at least 64 px high, has 16 px of horizontal padding, and has an `:active` state. The name is bold, and bolder when unread.
- The head, the pinned rows, and the filter get the same 16 px padding, so all rows share one left edge.
- The last row of a shelf loses its bottom border, because the shelf has one.

### 137-4 List section rows

The pinned rows are parking, friends, voice, threads, and hidden.
Only friends, voice, and hidden expand.

- The three rows that expand get a chevron as the last child. The chevron turns 90 degrees when the row is expanded. Parking and threads get no chevron, because they open a screen.
- The hidden row drops its text glyph and keeps the word "hidden".
- An expanded sublist has a short enter animation. The collapse stays instant.

### 137-5 Headers

- The global header is one row that does not wrap on the phone. A long username gets an ellipsis, so it cannot break the row. The trigger stays 44 px high.
- In the channel header, the back button, the icons, and search are 44 px by 44 px with one gap token. The action buttons do not shrink.

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
| 137-2 | not started | Message grouping and phone typography |
| 137-3 | not started | Conversation rows |
| 137-4 | not started | List section rows |
| 137-5 | not started | Headers |
| 137-6 | not started | Empty states |
| 137-7 | not started | List and chat transition |

## Left open

- Only a real iPhone PWA shows the keyboard behavior. The device checks of 137-1 are open.
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
