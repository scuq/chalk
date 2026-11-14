# Phase 137 — phone polish from the external design review

**Status:** built (all twelve slices). The device checks of 137-1 to 137-12 are open, in the manual checklist.
**Tags:** `#composer`, `#mobile`, `#parking`, `#zucker` → `tools/where.sh -g composer`

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

Changed by 137-10: parking and threads are head buttons and no longer rows. The pinned rows that remain are friends, voice, and hidden.

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

The parking lot mark was `min(55%, 45vh)` wide at an opacity of 0.28.
On a 390 px phone this is about 205 px, half the screen.
Now a phone rule sets the width to 96 px.
The opacity and the color do not change, and desktop keeps `min(55%, 45vh)`.
The titled empty feed has a 72 px mark and stays as it is.

- The rule has its own `@media (max-width: 767px)` block, right after the base `.chalk-parking-mark` rule in `web/src/theme.css`.
  The base parking rules come after the main phone block in the file.
  A rule in the main phone block has the same weight, so the base rule would win.
  `web/src/theme-parking.test.ts` checks the order.
- The parking lot has no description text.
  It is a privacy screen, and nothing on it asks to be read.
  It already has an `aria-label` for screen readers.

Measured in a headed iPhone 14 emulation:

- The mark is 96 px by 96 px at 390 px and at 320 px.
- The mark sits in the center of the pane, with an opacity of 0.28.
- There is no horizontal overflow.
- At 1280 px the mark is 360 px wide, as before.

### 137-7 List and chat transition

Before 137-7, the switch between the list and a chat was an instant `hidden` toggle.
A live swipe-back drag exists (`web/src/chat/use-swipe-back.ts`), and it already moves the chat off to the right.
Now the chat and the list slide in for a short time.

- The slice has enter animations only. It delays no unmount. `web/src/nav/phone-stack.ts` and `use-swipe-back.ts` do not change.
- `.chalk-main` and `.chalk-footer-main` play `chalk-phone-chat-in` when the shell is on the chat screen. The chat starts at opacity 0 and 24 px to the right.
- `.chalk-phone-list` plays `chalk-phone-list-in` when the shell is on the list screen. The list starts at opacity 0 and 24 px to the left.
- Both animations run on `--chalk-dur` with `ease-out`. Reduced motion sets the token to 0 ms, so the slice has no reduced-motion rule.
- The animations restart with no script. The class changes in the same render as the screen, and the list and the footer come back from `display: none`, which restarts an animation.
- The transform exists only inside the keyframes. There is no fill mode. A transform at rest makes `.chalk-main` the containing block of the fixed message menu and the lightbox (see the 64-12 comment in `theme.css`). A long press takes 500 ms, so the menu cannot open during the 160 ms animation.
- A completed swipe must not play the list animation, because the swipe already showed the list. `App.tsx` has a `backBySwipe` state. `swipeBackToList` sets it and then calls `backToList`. `useSwipeBack` receives `swipeBackToList`.
- The hook calls its back callback only when a swipe completes. A cancel, a rescue, or a finger that interrupts the settle never calls it. The wrapper is therefore an exact signal.
- While `backBySwipe` is true, the shell has the class `chalk-app--back-by-swipe`, and the list rule does not match. An effect clears the state when `zuckerScreen` becomes `"chat"`.
- The header back button and the system back do not set the state, so they get the slide.
- When chalk opens on a phone, the list is the first screen, so it fades in once.

Measured in a headed iPhone 14 emulation, with real touch events for the swipe:

- A tap on a row runs `chalk-phone-chat-in`. It was caught at +12 px. After 500 ms, `.chalk-main` has no transform.
- The back button runs `chalk-phone-list-in`. It was caught at -20 px. No transform remains after it.
- A completed swipe leaves the list shown with the state set and no animation running.
- Entering a chat again clears the state. The back button then slides the list in again.
- There is no horizontal overflow.
- Reduced motion was not checked in the emulation. The token covers it.

### 137-8 Friends at a glance

Before 137-8, the closed "@ friends" row showed only a label.
Now one line of friend chips sits under it.
137-11 changed this layout. See "Changed by 137-11" below.
A chip is a button with a presence dot and the name of a friend. A tap opens the chat with that friend, through the same `onFriendSelect` as the full list.

- The order is the order of `buildFriendList`: online, then away, then offline, and by name inside each group.
- A name is cut at 10ch with an ellipsis. The name is bright for an online friend and dim for an offline friend.
- Chips that do not fit fold into a last "+N" chip. A tap on it opens the full list, and the chips go.
- An open row shows the full list and no chips, so a name never shows twice.
- The row gets `chalk-zucker-pinned--chips` when it shows closed with at least one friend. It then has no bottom border, and the chips line carries it.
- `FriendChips.tsx` is new in `web/src/components/`. `FRIEND_CHIPS_MAX` (24) and the pure `chipsThatFit(widths, available, gap, moreWidth)` are in `web/src/chat/zucker.ts`.
- `chipsThatFit` returns the full count when every chip fits, and keeps no room for "+N". Otherwise it returns the largest count that leaves room for "+N". That count can be 0.
- The component measures before paint. It renders every chip, up to `FRIEND_CHIPS_MAX`, and the "+N" chip with `visibility: hidden` (`chalk-zucker-chips--measuring`). A layout effect reads the widths, and `chipsThatFit` gives the count to keep.
- It measures again when the friends or their names change, and when the width of the line changes (`ResizeObserver`). While a chat covers the list, the width is 0, so it measures again when the list returns.
- The observer effect depends on `empty`, because the line does not exist while there are no friends. The first demo run had an effect that ran only at the first render. It never attached, and at 320 px the third chip ran past the edge.
- The CSS is in the phone block of `web/src/theme.css`. The line is one `nowrap` row, 44 px high, with 16 px side padding and `overflow: hidden` as a guard. It sits 4 px up toward the row. A chip is a 44 px transparent target around a bordered pill, and a pressed chip shades the pill. Each rule uses the existing tokens.
- The chips do not use `WaveName`, so a waving name does not show on a chip.

Changed by 137-11: the chips no longer sit in one line under a row with a label. They wrap to two lines inside the friends bar, and the bar has no "@ friends" label while it shows chips. `chipsThatFit` is gone, and `fitFriendChips` replaces it. A name no longer ends at 10ch with an ellipsis. The component shortens names to reach eight chips. `chalk-zucker-pinned--chips` is gone. The text above is the history of 137-8.

Measured in a headed iPhone 14 emulation, with six friends, three online and three offline:

- The row and the chips line together are 84 px high.
- At 390 px, three chips and "+3" show. At 320 px, two chips and "+4" show. Nothing passes the 16 px edge.
- Each chip is 44 px high.
- A tap on "+N" opens the full list and the chips go.
- A tap on a chip opens the chat with that friend.
- Not seen: an away friend, because the emulation cannot stage one. Also not seen: more than 24 friends, and a waving name.

### 137-11 Friends bar: two lines of chips and a count button

A marked-up screenshot of the phone list asked for three changes.
The "@ friends" label goes, and its space goes to the chips.
The list shows at least eight chips, and names are shortened where necessary.
The online count and the expand control sit at the far right, in as little space as possible.

- The friends row is now `.chalk-zucker-friendsbar`. The chips are on the left. A compact toggle button is on the right (`data-testid="zucker-friends"`, `aria-expanded`).
- The toggle shows only "online/total", for example "5/9", and the chevron. Its `aria-label` and its `title` carry the words, for example "friends, 5 of 9 online".
- The "@ friends" label shows only when there are no chips: when the list is open, or when the user has no friends. The open list does not change.
- The chips wrap to two lines. `.chalk-zucker-chips` has `max-height: 88px` and `overflow: hidden` as a guard.
- The bar has 16 px of left padding. Its right padding is 16 px minus the 13 px that the toggle keeps inside. So the right edge of the chevron lines up with the head icons and the row times.
- `fitFriendChips(input)` in `web/src/chat/zucker.ts` replaces `chipsThatFit`. The new constants are `FRIEND_CHIPS_LINES` (2) and `FRIEND_CHIPS_WANT` (8). `FRIEND_CHIPS_MAX` (24) stays.
- The target is eight chips. It is all friends if there are fewer. It is the count that fits at the name floor if eight cannot fit.
- A binary search over whole pixels finds the widest name cap that still reaches the target. The search cuts names only as far as necessary, and spare width goes back to the names. A name is never widened and never cut below `minName`.
- With no friends or no width, `fitFriendChips` returns a count of 0.
- `FriendChips.tsx` reads these widths: each name, the overhead of a chip, the gap, "+N", the line, and the mean character. The line width is 1 px under the real width. A rounded fraction then cannot wrap a line.
- The component turns the cap into a whole number of characters, never under 4 (`MIN_NAME_CHARS`). It renders each name cut to that many characters as text. The CSS variable `--chalk-chip-name-max` stays as a guard for a proportional font, where the mean width is only an estimate.

The demo tried two cuts and rejected both:

- An ellipsis. It costs one letter of a four-letter name.
- A CSS clip as the only cut. It slices a glyph in half.

Measured in a headed iPhone 14 emulation, with nine friends, five online and four offline, and names of 6 to 21 characters:

- At 390 px, eight chips in two lines and "+1" show. The names show four letters, for example "bob_" and "fran". The bar is 89 px high with its border.
- At 320 px, six chips and "+3" show.
- The toggle is 55 px wide and reads "5/9".
- The right edge of the chevron equals the right edge of the last head icon. It is 366 px at 390 px, and 296 px at 320 px.
- An open bar shows the "@ friends" label and the list of nine, and no chips.
- The page does not move sideways.
- Not seen: eight or fewer friends with full names (the unit tests cover it), an away friend, and a proportional font.

### 137-12 DM row: the dot replaces the "@"

The owner asked for one change in the phone list.
A direct conversation showed "@bob".
It now shows "bob".

The reason is that the badge column of a DM row already holds the presence dot of the partner.
A channel has its glyph in the same column.
So the dot marks a DM, and the "@" said the same thing twice.

- `rowLabel(row)` in `web/src/chat/zucker.ts` returns the name that the row shows. For a DM whose name starts with "@" and has more than one character, it returns the name without the "@". Otherwise it returns the name as it is.
- A channel keeps a leading "@" in its name. A name that is only "@" stays, so a row never has an empty name.
- `ZuckerList.tsx` renders `rowLabel(r)` in the row name.
- `ZuckerRow.name` does not change. So the filter still matches the "@" form, and "@bob" still finds the DM.
- The DMs chip, the friend chips, the channel header ("@bob"), and the desktop sidebar do not change.

Measured in a headed iPhone 14 emulation, with two DMs and one channel:

- The DM rows show the plain names, with an online dot and an offline dot in the badge column and no glyph.
- The channel row keeps its glyph and its name.
- The name filter with "@bob" still shows the DM row.

### 137-9 Filter bar

The magnifier in the list head opens one filter bar.
Changed by 137-10: the button is now a funnel icon, and the bar rules below are unchanged.
The bar sits directly under the head.
It holds the name field (placeholder "name…") and one chip for each kind: all, unread, mentions, channels, DMs, and voice.
The chips reuse the chip classes of 137-8.
The chosen chip has `aria-pressed` and `chalk-zucker-kind--on`.

- The kind and the text must both match. The text is a trimmed, case-insensitive substring match.
- The kinds are in `web/src/chat/zucker-filter.ts`. A row counts as a mention only while it is unread. A channel is a row that is not a DM and not a voice room.
- With no kind and no text, `filterZuckerRows` returns the same array.
- The text matches `matchText` of a row, or its `name` when it has none. `buildConversationList` takes `matchTextFor` as an optional last parameter. `App.tsx` passes `filterText(channel)` for a channel, which holds the full name and the short name. It passes nothing for a DM.
- This fixes an older fault. The phone filter matched only the label on screen, so with the short name style the full name of a channel did not match.
- The conversations, the voice shelf, and the hidden shelf each go through `filterZuckerRows`.
- While a filter is active, the voice shelf and the hidden shelf each open when they have a hit. They close when they have none. Before, a hit in a closed hidden shelf stayed invisible.
- "no matches" shows only when all three lists are empty under an active filter. Before, it ignored the hidden shelf.
- While the bar is open, the rows that are not conversations do not render. These are the parking lot, the friends row with its chips and list, and the threads row. Since 137-10 only the friends row is left, because the parking lot and the threads are head buttons. The bar then sits directly above the rows it narrows. The list keeps its height when the keyboard is up. The voice row stays, because it can hold hits.
- Closing the bar with the magnifier clears the text and the kind, so no hidden filter stays active.
- Opening the bar still focuses the name field (the behavior of 64-5). The owner decided that it keeps this automatic focus.
- The CSS is in the phone block of `web/src/theme.css`. `.chalk-zucker-filter` has no bottom padding, because the 44 px chip row takes its place. `.chalk-zucker-kinds` is one `nowrap` line that scrolls sideways with no scrollbar. Negative margins pull it to the screen edges, so the chips scroll under the 16 px padding. Each rule uses the existing tokens.

Measured in a headed iPhone 14 emulation, with three channels and one DM. Two channels were unread, and one of them had a mention:

- The bar is 82 px high, directly under the head and directly above the first row.
- The six chips are 44 px high each.
- The chip row is 398 px of content in 374 px, so "voice" is partly off the screen and the row scrolls.
- The name field has focus when the bar opens.
- Unread shows the two unread channels, mentions shows one, channels shows three, and DMs shows one. Voice shows "no matches".
- The text "sign" finds the channel design-review. The text "sign" with the DMs chip shows "no matches".
- Closing the bar restores the four rows and the three pinned rows.
- Not seen: a voice room, because voice is off on the dev stack. Also not seen: a hit in the hidden shelf, and a channel with a short name. A unit test covers the short name.

### 137-10 Head buttons with icons

A marked-up screenshot of the phone list asked for two changes.
The Parking Lot and the threads move out of their full-width rows into buttons in the list head.
Every head button gets a better icon that a user remembers.
Before 137-10, the head held the title and three bordered buttons with text glyphs: a magnifier, "@+", and "+".
Now the head holds the title and five icon buttons, and the list has 88 px more height.

- The order is parking lot, threads, filter, add a friend, and new channel. The parking lot button shows only when `parkingName` is not null.
- The parking lot button has the name of the parking lot as its `title` and `aria-label`, because a user can rename it. The icon alone does not say it.
- The threads button has `aria-label` "threads". With unread replies, a dot (`.chalk-zucker-add-dot`, 8 px, `--chalk-unread`) shows on the button, and the label is "threads, unread replies".
- `ParkingIcon` takes an optional `size`. The default is 14, the size of the desktop sidebar. Above 14 it uses the fine stroke.
- Four icons are new in `web/src/components/icons.tsx`. They are 18 px with the fine stroke, in the shared family:

  - `ThreadsIcon`: a reply arrow that goes down and then right, the shape of the old "↳".
  - `FilterIcon`: a funnel.
  - `AddFriendIcon`: a person with a plus.
  - `NewChannelIcon`: a speech bubble with a plus.

  Each icon is decoration. The button carries the label.
- The two pinned rows and their markup are gone. The filter bar rule "hide the rows that are not conversations" now concerns only the friends row.
- The test ids do not change: `zucker-parking`, `zucker-threads`, `zucker-filter-toggle`, `zucker-add-friend`, and `zucker-new-channel`.
- In the phone block of `web/src/theme.css`, `.chalk-zucker-add` is a 44 px square with no border. Five bordered boxes and the title do not fit 375 px. The composer tools lost their boxes for the same reason in 137-1. A pressed button shows `--chalk-bg-hover`. The buttons have no gap.
- The active filter button has `--chalk-bg-elev` and the accent color.
- The head has a right padding of 16 px minus 13 px. An 18 px icon in a 44 px button has 13 px of air on each side. The last icon then ends on the same edge as the row times.
- The title can shrink with an ellipsis. Below 360 px it does not show, and the five buttons spread over the row.

Measured in a headed iPhone 14 emulation:

- The head is 61 px high.
- At 390 px and at 375 px the title shows in full, and the five buttons are each 44 px by 44 px.
- The right edge of the last icon equals the right edge of the row times. It is 366 px at 390 px, 351 px at 375 px, and 296 px at 320 px.
- At 320 px the title is hidden and the buttons spread over the width.
- The only pinned row left is friends.
- The threads button opens the thread inbox. The parking button opens the parking lot.
- There is no horizontal overflow.
- Not seen: the unread dot on the threads button, and the head with no parking lot (four buttons).

## Decisions

- The phase covers the full review, in slices.
- The phone toolbar keeps all four tools: attach, GIF, emoji, and code.
- A follow-up message in a group shows its time in the long-press menu.
- The list and the chat get a short slide transition (137-7).
- A second mock-up asked for two more slices on the phone list: friends at a glance (137-8) and a filter bar (137-9).
- A second marked-up screenshot asked for 137-11. The "@ friends" label goes. The list shows at least eight chips with shortened names. The count and the expand control sit at the far right.
- A marked-up screenshot of the phone list asked for 137-10. The Parking Lot and the threads become head buttons. Every head button gets an icon.
- The name field of the filter bar keeps its automatic focus when the bar opens (137-9).
- The rows that are not conversations stay hidden while the filter bar is open (137-9).

## What was rejected

- The "favorites" and "mod" filters of the second mock-up. The owner dropped both. Chalk has no favorite concept. The client does not receive the role of the viewer in a channel, so it cannot tell a mod channel from another.
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
| 137-6 | built (2026-11-14) | Empty states |
| 137-7 | built (2026-11-14) | List and chat transition |
| 137-8 | built (2026-11-14) | Friends at a glance: a line of friend chips under the friends row (layout changed by 137-11) |
| 137-9 | built (2026-11-14) | Filter bar behind the magnifier: name field and kind chips |
| 137-10 | built (2026-11-14) | Head buttons with icons: parking lot and threads leave their rows |
| 137-11 | built (2026-11-15) | Friends bar: two lines of chips, no label, and a compact count button at the right |
| 137-12 | built (2026-11-15) | DM row: the presence dot replaces the "@" before the name |

## Left open

- Only a real iPhone PWA shows the keyboard behavior. The device checks of 137-1 are open.
- The device checks of 137-2 are open, in the manual checklist.
- The device checks of 137-3 are open, in the manual checklist.
- The device checks of 137-4 are open, in the manual checklist.
- The device checks of 137-5 are open, in the manual checklist.
- The device checks of 137-6 are open, in the manual checklist.
- The swipe settle uses a hard-coded 160 ms (`theme.css` and `SWIPE_SETTLE_MS` in `use-swipe-back.ts`). Reduced motion does not turn it off. This gap is older than 137-7 and is outside the slice.
- The device checks of 137-7 are open, in the manual checklist.
- The device checks of 137-8 are open, in the manual checklist.
- The device checks of 137-9 are open, in the manual checklist.
- The device checks of 137-10 are open, in the manual checklist.
- The device checks of 137-11 are open, in the manual checklist.
- The device checks of 137-12 are open, in the manual checklist.
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
- [ ] 137-6: a phone. Park chalk and unpark it. The mark is small, centered, and dim, and the screen does not move sideways.
- [ ] 137-6: a phone, with a light theme. The dim mark is still visible on the parking lot.
- [ ] 137-7: a phone. Tap a conversation row. The chat slides in from the right for a short time, and the message menu still opens on a long press.
- [ ] 137-7: a phone. Tap the back button of the chat. The list slides in from the left.
- [ ] 137-7: a phone. Swipe back from the left edge of a chat. The list shows with no second slide.
- [ ] 137-7: a phone, with reduced motion turned on. Opening a chat and tapping the back button show no slide.
- [ ] 137-7: a phone. Tap a notification for a text conversation. The chat opens with the same slide from the right as a row tap.
- [ ] 137-8: a phone, with an away friend. The dot of that chip shows the away state.
- [ ] 137-8: a phone, with a friend who has a long name. The chip stays inside the screen. Since 137-11 the name is cut with no ellipsis.
- [ ] 137-8: a phone. Rotate it. The chips measure again, and "+N" shows the right count.
- [ ] 137-8: a phone. Tap the chip of a friend with no chat yet. A chat with that friend opens.
- [ ] 137-9: a phone. Tap the filter button. The filter bar shows under the head, and the name field has focus.
- [ ] 137-9: a phone. Swipe the chip row sideways. It scrolls, and "voice" comes fully into view.
- [ ] 137-9: a phone, with a hidden conversation. Type part of its name. The hidden shelf opens and shows it, and "no matches" does not show.
- [ ] 137-9: a phone, with the short name style and a channel that has a short name. Type part of the full name. The channel shows.
- [ ] 137-9: a phone, with a live voice room. Tap the voice chip. The voice list opens and shows the room.
- [ ] 137-10: a phone. Look at the five head icons without their labels. They are easy to tell apart.
- [ ] 137-10: a phone, with an unread reply in a thread. The threads button shows the dot, and a screen reader says "threads, unread replies".
- [ ] 137-10: the narrowest phone available. The head shows the five buttons inside the screen, each button is easy to hit, and the page does not move sideways.
- [ ] 137-10: a phone, with the parking lot renamed. The parking button is still found, and its label is the new name.
- [ ] 137-10: a phone, with the parking lot hidden in the settings. The head shows four buttons.
- [ ] 137-11: a phone, with eight friends or fewer. The chips show full names.
- [ ] 137-11: a phone, with nine friends or more. The chips show at least eight names in two lines, and "+N" shows the rest.
- [ ] 137-11: a phone. The count button at the right is easy to hit, and a tap opens the full list.
- [ ] 137-11: a phone, with a proportional font. The chips do not wrap to a third line.
- [ ] 137-11: a phone. Rotate it. The chips measure again, and the count of chips fits the new width.
- [ ] 137-12: a phone, with a friend in a DM. The row shows the dot and the name with no "@". The dot changes when the friend goes away or offline.
