# Phase 133 — polish: semantic tokens and a refined shell in every theme

**Status:** built, 133-1 to 133-12 (2026-11-08).
133-7 changed no code. The phase closed at 133-7 and was reopened for the voice
room. See "The voice room" below. After the owner watched a live demo, the
phase was reopened once more for 133-12.
`web/src/theme-palette.test.ts` tests the contrast floors of the palette and
of the derived tokens. `web/src/theme-tokens.test.ts` tests two rules: every
custom property the stylesheet reads is declared, and no `var()` carries a
fallback on a token that the sheet always declares. The manual checklist at
the end of this file is open.

**Tags:** `#themes`, `#roster`, `#composer` → `tools/where.sh -g themes`

## The problem

An outside reviewer looked at the desktop UI and sent a mockup and a design
brief. The brief asks for a refinement, not a redesign: one coherent header
surface, softer region boundaries, a contract for the states of a navigation
row (hover, selected, unread, focus), a 4px spacing grid, a small radius
scale, one composer with a prominent send button, a friendlier empty state,
and all of it through semantic tokens, so that every theme benefits.

chalk already had most of the token architecture. The gaps were small:

- A theme is eleven palette tokens, and `web/src/theme-palette.test.ts` holds
  them to contrast floors. There were 15 themes.
- The spacing tokens `--chalk-s1` to `--chalk-s6` exist and are used in 511
  places.
- There was one radius token, `--chalk-radius: 2px`. The lcars theme set it to
  10px.
- There was no token for hover, selected, a strong border, an accent hover,
  text on an accent fill, or a duration.
- `--chalk-bg-hover` was read in three rules and declared nowhere.
  `--chalk-size-body` was read in 11 rules and declared nowhere.
- Each theme block tuned the background of the selected sidebar row by hand.
- No global `:focus-visible` rule existed. Some controls used the browser
  outline.
- 24 `transition` declarations used a literal duration.

A `var()` with no fallback and no declaration does not fail. The browser drops
the whole declaration, and the rule draws nothing. No test caught this.

### The voice room (133-8 to 133-12)

The owner received a second design review. It covers the voice room on a
desktop and on a phone. The review makes these points:

- The voice view has no balanced composition, most of all with one participant.
- A participant with audio only gets a large empty video rectangle.
- The scratchpad must be the main text area. It must fill the unused space,
  keep the composer at the bottom, and keep its ephemeral behavior.
- The empty scratchpad needs a restrained empty state.
- Explanatory text that repeats other text must go.
- The participant tiles and the scratchpad must stay distinct.
- The room must support calls with audio only, with cameras, with a screen
  share, and with a mix of these.

The code survey found these causes:

- Audio-only, camera, and screen tiles share one 16:9 box. The rule
  `aspect-ratio: 16/9` is on `.chalk-voice-peer--grid`, `--big`, and
  `--strip`. A voice call of two people therefore shows one large empty
  rectangle in the spotlight.
- The scratchpad notice renders at all times, also before you join.
- The empty scratchpad collapses to zero height.
- No test covers the stage layout.
- The stage and the call rail each built a tile list. This was the open item
  of phase 131.

## The design

The 11-token palette stays the personality of a theme. Every new token is
derived from the palette on `:root`, so no theme block needs an edit. The
browser floor (Chromium 137, Firefox 129, Safari 17) supports `color-mix()`
without a fallback.

Four decisions came from the operator before the work started:

1. The default green theme adopts the palette of the review. It is not a
   separate theme.
2. The regions stay flush. There are no floating cards.
3. The radius scale is 4px, 6px, and 8px. The lcars theme keeps its 10px pills.
4. On a desktop, the composer tools become one row. The phone keeps the 2x2
   block from [phase 94](PHASE-94-PHONECOMPOSER.md).

Three decisions came from the owner when the phase reopened for the voice
room:

1. The scratchpad notice ("text here is for the call ... everything is deleted
   for everyone once the last person leaves ...") moves into the empty state
   of the scratchpad. When the scratchpad has text, a one-line caption stays
   above it. The caption says that the text goes when the last person leaves.
2. Desktop and phone share one layout. Each slice is checked at phone width.
3. The duplicate tile list of the stage merges into the tested builder of the
   call rail first, as its own slice. This approval closes the open item of
   [phase 131](PHASE-131-CALLRAIL.md).

### Tokens and the green palette (133-1)

The default palette is now a near-black ground with soft mint body text. The
unread green `#24f077` is the emphasis color and the accent. The review gave
these values:

| Token | Value |
|---|---|
| `--chalk-bg` | `#050805` |
| `--chalk-bg-elev` | `#0a110b` |
| `--chalk-bg-elev-2` | `#0f1c11` |
| `--chalk-fg` | `#88ffc9` |
| `--chalk-fg-dim` | `#74b08a` |
| `--chalk-fg-bright` | `#24f077` |
| `--chalk-fg-muted` | `#3c6b52` |
| `--chalk-border` | `#143a25` |
| `--chalk-accent` | `#24f077` |
| `--chalk-warn` | `#ffc64d` |
| `--chalk-error` | `#ff5252` |

`--chalk-unread` was already `#24f077`, so it now equals the accent. The green
swatch in the theme picker, the `theme-color` in `web/index.html`, and the
`background_color` and `theme_color` in `web/manifest.json` use `#050805`.

Seven derived tokens come from one rule in `web/src/theme.css`. The rule
mixes palette tokens with `color-mix(in srgb, ...)`:

| Token | Derivation |
|---|---|
| `--chalk-bg-hover` | `--chalk-fg` 8% over `--chalk-bg-elev` |
| `--chalk-bg-selected` | `--chalk-accent` 20% over `--chalk-bg` |
| `--chalk-border-strong` | `--chalk-accent` 50% over `--chalk-border` |
| `--chalk-accent-hover` | `--chalk-accent` 85% over `--chalk-fg` |
| `--chalk-accent-dim` | `--chalk-accent` 55% over `--chalk-bg` |
| `--chalk-on-accent` | `--chalk-bg` |
| `--chalk-focus` | `--chalk-accent` |

A custom property resolves on the element that declares it. The warmwhite
theme re-declares its palette on `.chalk-sidebar`, and a derived token set on
`:root` would keep the page values inside the rail. The rule therefore also
names `[data-theme="warmwhite"] .chalk-sidebar`, so the rail derives its own
tokens from its own palette.

A theme block can override any one derived token with a hex. The palette test
then uses that hex.

Other tokens in this slice:

- `--chalk-radius-sm` (4px), `--chalk-radius-md` (6px), and `--chalk-radius-lg`
  (8px). `--chalk-radius` stays as an alias of `-md`. The lcars block sets the
  three radii to 10px.
- `--chalk-dur-fast` (100ms) and `--chalk-dur` (160ms). One
  `@media (prefers-reduced-motion: reduce)` rule sets both to 0ms, so every
  transition written on a token stops without a guard of its own.
- `--chalk-size-body`, an alias of `--chalk-size-base`.

133-1 is not visually neutral beyond the palette. The 98 rules that read
`--chalk-radius` go from 2px to 6px, so buttons, inputs, and rows are rounder
in every theme except lcars.

#### The contrast floors of derived tokens

`web/src/theme-palette.test.ts` has a small evaluator for `color-mix(in
srgb, ...)`. It is a per-channel linear mix of two hex values. Every palette
block must clear these floors:

| Text | Ground | Floor |
|---|---|---|
| `--chalk-fg` | `--chalk-bg-hover` | 3:1 |
| `--chalk-fg` | `--chalk-bg-selected` | 4.5:1 |
| `--chalk-fg-bright` | `--chalk-bg-selected` | 3:1 |
| `--chalk-on-accent` | `--chalk-accent` | 4.5:1 |
| `--chalk-on-accent` | `--chalk-accent-hover` | 4.5:1 |
| `--chalk-focus` | `--chalk-bg` | 3:1 |

The hover floor is 3:1 and not 4.5:1. The existing policy gives the top
surface `--chalk-bg-elev-2` the same 3:1, and a hovered row is a surface of
that kind. In solarized-dark, body text reads 4.28:1 on the derived hover, so
a 4.5:1 floor would force an override that the policy does not ask for. The
selected row carries body text, so it gets 4.5:1. The send label is small
text, so `--chalk-on-accent` gets 4.5:1 on both accent states.

Two themes needed an override. Both are in the solarized-dark block:

- `--chalk-bg-selected: #053749`. This is the selected row that the theme
  already had by hand, 12% accent over the page. It gives body text more than
  4.5:1. The derived 20% mix gave 4.29:1.
- `--chalk-on-accent: #001e26`. Solarized blue is a mid-tone. The page color
  base03 reads 4.08:1 on it, and white reads 3.7:1. The darker `#001e26` gives
  about 4.7:1.

#### Undefined tokens

`web/src/theme-tokens.test.ts` fails when `theme.css` reads a custom property
that the sheet never declares and that no non-test `.ts` or `.tsx` file under
`web/src` sets. The first run found five tokens besides the two that were
already known. They were replaced by tokens that exist:

| Read | Now |
|---|---|
| `--chalk-danger` | `--chalk-error` |
| `--chalk-mono` | `--chalk-font-mono` |
| `--chalk-bg-alt` | `--chalk-bg-elev` |
| `--chalk-row-hover` | `--chalk-bg-hover` |
| `--chalk-surface` | `--chalk-bg` |

Two rules that read `--chalk-danger` had no fallback, so they drew no color.
These are the hover of `.chalk-btn-danger` and the weakest label of the
password-strength meter. They show the theme error color now. The delete item
in the message menu, and the remove and leave actions in the member list, had
a fixed red as fallback. They now follow the theme error color. The three
rules that read `--chalk-bg-hover` are the hover of `.chalk-btn`, the hover of
`.chalk-auth-button`, and the hover of `.chalk-members-add-friend`. The first
two drew no hover background. The third had a near-transparent fallback
(`--chalk-row-hover`).

### Dead fallbacks and green tints (133-2)

The plan was to replace the literals of the old green. The slice removed more:
every `var()` fallback on a token that the sheet always declares. That is 143
fallbacks in `web/src/theme.css`. The tokens are the palette tokens,
`--chalk-bg-hover`, and `--chalk-rail-w`. A fallback on such a token never
applies, because the token always has a value. Many fallbacks held the old
green (`#1f2a1f`, `#14201a`, `#5cffb1`, `#c8ffc8`, `#6effa1`), so they
misled anyone who read the sheet.

Fallbacks stay on variables that the client TypeScript writes inline, for
example `--chalk-sidebar-w`, `--chalk-composer-h`, and `--chalk-shell-h`.
There the fallback applies until the script sets the value.

Five fixed green tints became tokens. Before, light themes and themes that are
not green showed a green tint on hover in these places:

| Rule | Now |
|---|---|
| `.chalk-presence-menu-item:hover` | `var(--chalk-bg-hover)` |
| `.chalk-presence-menu-item--active` | `var(--chalk-bg-selected)` |
| `.chalk-members-reshare:hover` | `color-mix(in srgb, var(--chalk-accent) 8%, transparent)` |
| `.chalk-verify-mark:hover` | the same `color-mix` |
| `.chalk-verify-confirm-yes:hover` | the same `color-mix` |

Two rules keep a literal color on purpose, and each has a comment that says
why. `.chalk-noscript` is the notice for a browser with no JavaScript. The
script applies themes, so the notice cannot use a token. Its colors, `#88ffc9`
on `#050805`, now equal the new default palette. The matrix flair frame keeps
`#00ff41`, because matrix green is one color in every theme.

`web/src/theme-tokens.test.ts` has a second test. It fails when `theme.css`
writes a fallback on a token that the sheet always declares and that no
non-test `.ts` or `.tsx` file sets.

### The interaction contract (133-4)

One look for hover, selected, unread, and keyboard focus applies across the
shell. The derived tokens from 133-1 carry it.

The selected sidebar row is a filled row. It has `--chalk-bg-selected` as its
fill and a 1px inset ring: `box-shadow: inset 0 0 0 1px
var(--chalk-border-strong)`. The 2px left border is gone. The ring is an inset
shadow and not a border, so no row changes height. Channel rows stay 32px and
friend rows stay 26px (measured). The first plan was a transparent 1px border
on every row. A border adds to the height, so it was rejected.

These rules have `--chalk-radius-md` and a transition on background-color,
color, and box-shadow at `--chalk-dur-fast`:

- `.chalk-sidebar-item`
- `.chalk-sidebar-threads`
- `.chalk-sidebar-parking`, whose active state has the same ring
- `.chalk-sidebar-group-header`, which is now inset like the rows and has a
  `--chalk-bg-hover` hover
- `.chalk-members-row`
- The presence and status menu items, which have `--chalk-radius-sm`

An unread channel name is `--chalk-fg-bright` at weight 700, so it stands out
beside its envelope.

The slice deleted 13 per-theme rules of the form `[data-theme="X"]
.chalk-sidebar-item--active`. The plan said 15. The real number is 13. Nine
tinted the row with the accent of the theme, and the derived
`--chalk-bg-selected` does that now. Four tinted it with the emphasis color of
the theme and not the accent. These are cyberpunk (magenta), lcars (orange),
blade-runner (scarlet), and exchalk (white). Their palette blocks now override
`--chalk-bg-selected` with a hex and `--chalk-border-strong` with a mix from
`--chalk-fg-bright`. The hex values are `#270931`, `#291800`, `#2c0c0d`, and
`#3a3a3a`. The palette test holds the hex values to the contrast floors. It
reads only hex, so it does not test the `--chalk-border-strong` mixes.

The exchalk value is a correction found in the browser. The first value was the
old tint of 10% white over the black page. That color matched the raised
sidebar `#1a1a1a`, so the selected fill vanished. The value `#3a3a3a` is 14%
white over the sidebar.

Other changes in this slice:

- The transition at `--chalk-dur-fast` is on `.chalk-call-rail-btn`,
  `.chalk-voice-ctlbtn`, `.chalk-composer-tool`, `.chalk-sidebar-new`, and
  `.chalk-presence-trigger`.
- The hover of the call-rail buttons and of the composer tools is
  `--chalk-bg-hover`.
- The sidebar "+" and the presence trigger have `--chalk-radius-sm`. The
  trigger had a fixed 3px.
- `.chalk-call-rail-btn.is-on` shares the rule of `.chalk-voice-ctlbtn.is-on`.
  A live screen share on the rail has the warn color now.

A global focus rule sits near the top of the sheet:
`:where(button, a, input, textarea, select, summary, [tabindex]):focus-visible`.
It draws a 2px outline in `--chalk-focus` with a 1px offset. `:where()` gives
the selector no specificity of its own, and `:focus-visible` adds the
specificity of one pseudo-class. Every per-selector focus rule therefore still
wins. The rule covers controls that had no focus style, such as the composer
tools, send, and the call-rail buttons. They used the browser default before.

`.chalk-status-dot--connecting` pulsed with no reduced-motion guard. The guard
now stands directly after that rule. It must stay after the rule. A media query
adds no specificity, so a guard earlier in the sheet loses to the later
animation rule. `theme-sidebar.test.ts` tests the order.

### Surfaces and spacing (133-3)

The shell has two surfaces with flush regions:

- The page (`--chalk-bg`) holds the header, the feed, and the composer.
- The raised surface (`--chalk-bg-elev`) holds the sidebar, the call rail,
  the phone drawer, and the channel header.

`.chalk-sidebar` gets `background: var(--chalk-bg-elev)`. The phone drawer
moves from `--chalk-bg` to `--chalk-bg-elev`. The scoped rail block of the
warmwhite theme still wins with its own dark ground.

The channel header and `.chalk-channel-headwrap` move to `--chalk-bg-elev`.
The header row gets `--chalk-s3` of horizontal padding, so the title does not
sit on the edge of the band. The offset shadow strip under the header stays
`--chalk-bg`, because it paints the gap under the pinned header in the page
color. The band sits inside the main column. It is 12px from the sidebar and
8px short of the scrollbar lane on the right.

The divider lines in the sidebar are gone:

- `.chalk-sidebar-header--channels` and the voice, threads, and parking
  sections lose `border-top` and `padding-top`. Their top margin is
  `--chalk-s4`.
- A channel group heading loses its hairline, and the first group no longer
  needs a rule that hides it. This reverses part of
  [phase 106](PHASE-106-CHANNELNAMES.md), which gave a group heading three
  cues. Two cues remain: air above each group, and the letter-spacing. The
  design review asked for fewer competing divider lines.
- The space and the lowercase section titles carry the grouping.

Rows and fields:

- `.chalk-sidebar-item` has `6px` of vertical padding and an inline margin of
  `--chalk-s1`, so a hovered or selected row stands clear of the column edge.
  Friend rows keep the 3px that [phase 132](PHASE-132-FRIENDCOLUMNS.md) set.
- `.chalk-sidebar-threads` and `.chalk-sidebar-parking` have the same inline
  margin, and their width is `calc(100% - 2 * var(--chalk-s1))`.
- Paddings and margins in these ranges move to the `--chalk-s*` tokens.
- `.chalk-sidebar-filter-input` and `.chalk-voice-dock` move to `--chalk-bg`.
  They are inset fields on the raised sidebar.
- `.chalk-call-rail` keeps only its right border.

A `--chalk-bg-elev` hover is not visible on a `--chalk-bg-elev` sidebar. Every
hover in these areas therefore uses `--chalk-bg-hover`. These are the sidebar
rows, the "+" buttons, the threads and parking rows, the channel search and
guests buttons, and the presence trigger. The selected channel row and the
selected parking row use `--chalk-bg-selected`. The 2px left border of the
selected row stayed until 133-4.

`.chalk-header`, `.chalk-header-left`, and `.chalk-channel-header` change
`align-items` from `baseline` to `center`. The height of the header does not
change, so the season canvas, which is sized from the header, is not affected.

The slice also fixes one bug. The root derives `--chalk-unread` from the dark
page text. The warmwhite rail is dark, so the unread envelope has been
invisible on the rail since 132-3. The warmwhite rail block now sets
`--chalk-unread: var(--chalk-fg)`.

### The composer (133-5)

On a desktop, `.chalk-composer-tools` is one flex row with a 2px gap and 3px
of padding. The row sits on one surface: `--chalk-bg-elev`, a 1px
`--chalk-border`, and `--chalk-radius-md`. The tool buttons have no border.
They are 28px tall, with `--chalk-radius-sm`. In the icon style they are
28px squares. The phone block goes back to the 2x2 grid of
[phase 94](PHASE-94-PHONECOMPOSER.md), with the 1px border on each button, so
the phone composer looks as it did.

The tool block is always mounted. During an edit it gets the class
`chalk-composer-tools--hidden` (`visibility: hidden`) and
`aria-hidden="true"`. One row of tools is about 120px wide. The old 2x2 grid
needed only the 56px of an empty rail. If the block were unmounted during an
edit, the field would slide sideways. The hidden buttons also leave the tab
order. Measured in the browser, the x position of the field is 442px before
an edit and 442px during an edit. `.chalk-composer-rail` lost its
`min-width: 56px`, because the hidden tools hold the width.

The GIF tool shows only when GIF search is enabled. Without it, the row has
three tools.

A new `IconEmoji` (a stroked smiley, with the stroke style of the other
icons) replaces the character in the icon style. The text style is
unchanged. All four icons are now 16px, and were 14px.

The textarea has `--chalk-radius-md` and a `--chalk-border` edge. Its focus
outline is `--chalk-accent`, and was `--chalk-fg`. Send is a filled button:
`--chalk-accent` background and border, `--chalk-on-accent` text, weight 700,
and `--chalk-accent-hover` on hover. When the field is empty, send is
transparent, with a `--chalk-border` edge and muted text. It has no opacity.
Send is the one prominent control of the composer, and it is filled only when
there is something to send. The height rule of
[phase 94](PHASE-94-PHONECOMPOSER.md) stays: send is as high as the field.

The slice deleted `.chalk-composer--editing .chalk-composer-send` and its
hover rule. They colored the label with the accent. On the new accent fill,
the label of "save" was invisible. The browser showed this. Send is now the
accent in both modes. The editing strip and the accent ring on the field
still mark an edit.

The `rows`, the stretch, and the `--chalk-composer-h` clamp do not change, so
`composer-height.ts` needs no edit.

### The empty states (133-6)

An empty text channel shows the chalk mark, the title "no messages yet", and a
hint. The mark and the title are not shown while the hint is the loading text
"loading history...". The thread panel and the voice scratchpad pass no title,
so they keep the one-line hint. The screen for "no channel open" shows the
same stack. Its title is "no channels yet" if the user has no channel, and
"no channel open" if they have one. The text has no glow and no animation.

`Logo.tsx` has a new prop `tone`. The default "brand" keeps the green
gradient, and the header uses it. The tone "theme" draws all three gradient
stops as `currentColor`. The mark is 72px and takes `--chalk-accent`, so it
follows the theme, for example scarlet and cyan in blade-runner. The review
asked for a centred picture, a short title, and a quiet hint, and no large
art.

`MessageList.tsx` has a new prop `emptyTitle`. Only a titled empty feed takes
the tall layout (`50vh`) through `:has(.chalk-empty)`. The italic text of
`.chalk-main-empty` is now upright.

The plan said "be the first to write something in #<name>". The built hint
uses the name of the channel without a "#", because the header shows
a glyph and not a "#". A direct message has its own hint: "be the first to
write to <name>.".

`web/src/theme-empty.test.ts` has two tests. One tests the mark and its
colour. One tests that only a titled feed takes the tall layout, and that the
thread panel passes no title.

### The theme sweep (133-7)

The sweep checked the contract in every theme. It changed no code. On the dev
stack at 1280 by 800, the desktop shell was screenshotted in all 15 themes:
green, light, snazzy-light, warmwhite, vscode-light, catppuccin-latte,
cyberpunk, solarized-dark, tokyo-night, lcars, blade-runner, azeroth, darkord,
exchalk, and catppuccin-mocha. Each theme has two shots. The first shows an
empty channel with an unread channel in the sidebar. The second shows a
channel with messages, an unread divider, and a selected row. The green theme
was also screenshotted at a phone width of 390px, with the feed and with the
drawer open.

Every theme reads correctly. The selected row, the hover, the unread name, the
mark of the empty state, the filled send button, and the raised channel header
take the colors of the theme. No theme needed a token override in 133-7. The
133-4 exchalk value and the 133-1 solarized-dark overrides are the only
per-theme corrections of the phase.

One result is accepted and not fixed. In solarized-dark, darkord, and
exchalk, `--chalk-border` equals `--chalk-bg-elev`, or nearly so. The sidebar
"+" buttons and the bottom rule of the channel header therefore show no
outline on the raised surfaces. The buttons still read as controls, because
they have a "+" glyph and a hover fill. The design review asked for fewer
outlines, so the palettes stay as they are. This closes the solarized-dark
note of 133-3.

### One tile list (133-8)

The stage and the call rail built the same list of tiles twice. The builder
`railTiles` in `web/src/voice/rail-tiles.ts` has tests. The `stageTiles` memo
in `VoiceCallPanel.tsx` kept its own copy of about 90 lines. Both lists had
the same order and the same fields: you first, then the roster, then media with
no roster entry, then one tile for each screen share.

The memo now calls `railTiles(snap, roster, selfUserID, selfDeviceID)`. It has
the same dependency list as before, including `nowTick`, which keeps the
live-video flags current. The type `StageTile` is now an alias of `RailTile`.
The helper `rosterFor` and the import `SessionRemoteTile` had no other use and
are gone.

One difference existed. On camera tiles, the stage left `isScreen` and
`hasAudio` undefined, and the rail sets them to `false`. Every read of these
fields in the stage is a truthiness check, so the result does not change. A
screenshot of a two-person voice room before and after the change is identical.

A test in `web/src/voice/rail-tiles.test.ts` reads `VoiceCallPanel.tsx`. It
checks that the panel calls `railTiles` and has no `interface StageTile`.
133-9 and the slices after it build on this single list.

### The adaptive stage (133-9)

The old automatic rule chose the grid or the spotlight by head count alone. A
voice-only call of two people therefore showed one large empty 16:9 box and a
small one. The new function `resolveStageMode(layout, tiles)` in
`web/src/voice/grid.ts` reads the media. It returns one of four modes, by
these rules in order:

1. If no tile has live video, it returns "cards". This holds when the viewer
   forced a layout, because a forced grid or spotlight with no video is only
   empty boxes.
2. If the viewer forced "grid" or "spotlight", it returns that layout.
3. If a screen share has live video, it returns "spotlight".
4. Otherwise it returns "mixed".

`resolveGridMode` stays exported and tested. Nothing outside its tests imports
it now.

`VoiceCallPanel.tsx` puts the mode on the stage as `data-stage-mode`:

- In "cards", everyone is a card in `.chalk-voice-cards`.
- In "mixed", the tiles with live video are 16:9 grid tiles in
  `.chalk-voice-videos`. The attribute `data-count` is 1, 2, or "many". A
  click pins the tile into the spotlight, as before. The people without video
  are cards below.
- "grid" and "spotlight" render as before.

`StagePeer` has a new prop `card`. A card shows the avatar and the label, and
has no video surface. Its title has no "click to focus". The volume slider
shows on a card and on the big tile. Before, the slider was on the big tile
only. In "cards" no tile is big, so an audio-only call would have lost the
volume control.

The "tiles" toggle now cycles auto, grid, spotlight, and back to auto. Before,
it flipped between the grid and the spotlight, and only unpinning returned to
auto. The toggle is hidden in "cards", because nothing is left to arrange. When
the viewer forced the spotlight, its title says "switch back to the automatic
layout".

The CSS is in `web/src/theme.css`, after `.chalk-voice-peer--grid`:

- `.chalk-voice-videos` is a responsive grid,
  `repeat(auto-fit, minmax(min(100%, 280px), 1fr))`. Its maximum width is
  960px, and 640px for one camera.
- `.chalk-voice-cards` is a centred grid of cards 180px to 240px wide.
- A card has the raised theme surface, the medium radius, and a grid of avatar
  and label. The speaking card has its border in the accent color. The avatar
  is a 40px circle.
- The rule is `.chalk-voice-peer.chalk-voice-peer--card`, with two classes.
  The base `.chalk-voice-peer` rule comes later in the sheet, and with one
  class it painted its black video background over the card. The light theme
  showed this in a browser.
- The card label points the `--voice-on-video*` variables at theme tokens.
  The white-on-black palette of the bar is for text over video. A card sits on
  the theme surface.

Measured on the dev stack at 1280 by 800:

| Call | Before | After |
|---|---|---|
| Two people, voice only | One large 16:9 box and a small one | Two cards, 240px by 61px |
| One camera on | Not measured | A 640px by 360px camera tile and one card below |

The stage was seen in the green and light themes, and at a phone width of
390px with a camera on. Three cases were not seen. They are in the checklist
and in 133-11.

The slice has three tests for `resolveStageMode` in `grid.test.ts`, and one
test for the card and video-grid rules in `theme-voice-pane.test.ts`.

### The scratchpad and a quieter call panel (133-10)

The notice under the call was a paragraph that showed at all times. It
repeated what a user already knew once the scratchpad had text. The owner chose
"empty state plus short caption":

- When the scratchpad is empty, the empty state gives the full explanation.
  The title is "scratchpad". The hint is "notes for this call. only what fits
  stays on screen, and it is all deleted for everyone when the last person
  leaves." `App.tsx` passes both for a voice channel. The loading state still
  has no title.
- The caption is one line: the tag "scratchpad" and the text "deleted for
  everyone when the last person leaves". It renders in the lobby and in the
  call. The rule
  `.chalk-main--voice:has(.chalk-messages--ephemeral.chalk-messages--empty)`
  hides it while the scratchpad is empty, so the same words do not show twice.
  A person who types before anyone joins sees the caption after the first note.
- The caption lost its dashed top rule and has a muted color. The tag is dim, not
  the warn color.

The flags for muted, deafened, camera on, and screen share on a tile are now
the shared `VoiceBadges` icons: `MicOffIcon`, `DeafIcon`, `CamIcon`, and
`ScreenIcon`. The call rail, the sidebar, and the hover card use the same
icons. The deafened icon still stands in place of the muted icon. The local
"M" (muted by you) stays a letter in a box, so it stays distinct from what the
person did themselves. The flag has a transparent border, and the local flag
keeps its colored border through its own rule. The deafened flag lost its
border color. The peer tile has the medium radius and the panel has the large
radius.

The scratchpad empty state differs from the empty state of a text channel. It
has no 50vh floor, because the call needs the height. It has a 40px mark and a
title of the base size.

Two bugs were found in a browser, not by a test:

1. The empty state sat at the right edge. The feed anchors its content to the
   bottom with `justify-content: flex-end`. In the voice room this pushed a
   grid track to the right edge. The rule `justify-content: center` on the
   empty scratchpad stops it.
2. One camera at 640px by 360px pushed the audio-only card out of the clipped
   stage at 800px height. The rules for `.chalk-voice-videos` with
   `data-count` 1 and 2 now cap the width from the height that the pane can
   spare:

   | Cameras | Width cap | With a row of cards below |
   |---|---|---|
   | One | `min(640px, calc((100dvh - 480px) * 16 / 9))` | 530px reserve |
   | Two | `min(960px, calc((100dvh - 480px) * 32 / 9))` | 530px reserve |

   The 480px and the 530px were measured by hand at 1280px by 800px. They are
   the rest of the pane: the header, the channel header, the bar, the caption,
   the row of cards, the floor of the scratchpad, and the composer. With the
   cap, the camera is 480px by 270px and everything fits. 133-11 widened the
   cap to any number of cameras. If the pane gets another fixed part, the two
   constants must change.

   133-12 replaced the two constants with a measured height. See "Every
   participant stays visible (133-12)".

This is the method that the open item "A four-tile call does not fit a window
under ~850px tall" proposes for the grid. See `docs/open-items.md`.

Seen on the dev stack at 1280px by 800px in the green theme: the empty
scratchpad with the centred explanation under two cards, the caption after one
note, and the mixed view whole. Cards and the empty state were seen at a phone
width of 390px. The slice has two tests in `theme-voice-pane.test.ts`: one for
the caption and the empty-state rules, and one for the camera height cap.
133-11 saw the rest. See the next section.

### The voice room sweep (133-11)

The sweep ran on the dev stack at 1280px by 800px. A Playwright probe in the
probe slot of the run-chalk skill registers up to five users, makes them
friends, and puts all of them in one voice room with the fake camera and
microphone of Chromium. The probe steps through these cases and reports for
each if the stage clips its content:

- Five people with no camera.
- The cards in six themes: green, light, warmwhite, cyberpunk,
  solarized-dark, and lcars.
- The speaking highlight, seen with two users. The card of the speaker has the
  accent border and the dot.
- Two, three, and five cameras.
- A screen share. The capture source is selected automatically.
- A phone width of 390px with five cameras.

The sweep found three faults. Each has a fix.

1. Three or more cameras clipped the stage. The cap of 133-10 applied to one
   and two cameras only. Three or five tiles of 397px by 223px stacked into
   rows taller than the window.
   `videoGrid(count)` in `web/src/voice/grid.ts` now returns the columns and
   rows: 1 by 1, 2 by 1, 2 by 2, 3 by 2, 3 by 3, and then four columns. The
   panel sets `--voice-video-cols` and `--voice-video-rows` on
   `.chalk-voice-videos`. The CSS uses the columns for `grid-template-columns`.
   On a desktop (`min-width: 768px`) it sizes the width of the grid from the
   window height divided by the rows:
   `min(960px, max(320px, calc((100dvh - 480px) / rows * 16 / 9 * cols)))`.
   The reserve is 530px when a row of cards is below. The rules for one camera
   stay at 640px. The phone keeps columns that fit to the width, 140px at the
   least. Measured after the fix: three cameras are 236px by 133px with two
   cards below, and five cameras are 262px by 147px. Nothing clips.
   133-12 replaced the reserves of 480px and 530px with a measured height.
2. On small camera tiles the long labels "popout" and "mute for me" squeezed
   the name to one letter. `StagePeer` has a new prop `compact`. With it, a
   grid tile uses the short labels of the strip tile: the glyph alone to pop
   out, "mute" and "unmute", and "hide" and "show". The mixed grid sets
   `compact` when three or more cameras are on.
3. In solarized-dark the cards and their slider tracks vanished into the call
   panel. In that theme `--chalk-border` equals `--chalk-bg-elev`, and the card
   was on `--chalk-bg-elev` too. A card is now `--chalk-bg-elev-2`, the next
   surface step, and the palette test already covers its text contrast. The
   avatar circle is `--chalk-bg-elev`, one step down, so it reads on the card.
   The slider track on a card is `--chalk-fg-muted`.

The slice changed two tests in `theme-voice-pane.test.ts`. The test for the
card and video-grid rules now expects the variable columns and the
`--chalk-bg-elev-2` card. A new test checks the compact labels and the column
variables. `grid.test.ts` has a test for `videoGrid`.

The sweep did not cover three cases:

- The speaking highlight with five people did not start in the timing of the
  probe.
- The forced "tiles" grid. It still has two columns and the `56vh / rows` cap,
  so it can crop on a short window. 133-12 closed this point.
- More than five people.

### Every participant stays visible (133-12)

The owner watched a live demo of a voice room with five people and one camera
on, in a window of about 1229px by 790px. The fourth card of a person with no
camera was cut off under the camera tile. The owner asked to find a way to see
all participants, with none cut off. The owner also showed a mockup in which
the call bar, the scratchpad caption, and the buttons share one row.

The cause was the reserve of 133-10 and 133-11. The CSS sized the camera grid
from the window height minus 480px, or minus 530px with cards. The two values
assumed one row of cards and a window of 800px. In a narrower window, four
cards wrap to two rows, and the reserve is wrong.

The design replaces the reserve with a measurement:

- The panel watches the voice pane (`.chalk-main--voice`) and itself with a
  `ResizeObserver`. The effect runs again when the mode or a tile count
  changes. It writes the height that the camera grid can have to the panel as
  `--voice-media-h`.
- The height is the current height of the grid, plus the height of the
  scratchpad above its floor, minus the height that the stage clips now. The
  floor of the scratchpad is its CSS `min-height`, and at least 84px. While
  the scratchpad is empty the floor is 160px, so its explanation stays whole.
  The result is rounded down, reduced by a safety margin of 8px
  (`MEDIA_SAFETY_PX`), and at least 120px.
- The value changes only when the new height differs by more than 2px. This
  ends the feedback loop. A change of the grid moves the scratchpad by the same
  amount in the other direction, so the measurement settles in one pass.
- The effect does nothing without `ResizeObserver`, and when there is no camera
  grid (cards only, or the spotlight).
- The desktop caps of `.chalk-voice-videos` use `var(--voice-media-h, 56vh)`.
  56vh is the height before the first measurement. The two rules for "with a
  row of cards" are gone, because the measurement includes any number of rows
  of cards.
- The forced "tiles" grid (`.chalk-voice-grid`) has the same kind of cap, from
  `--voice-media-h` and `--voice-grid-rows`. The rule `max-height: calc(56vh /
  var(--voice-grid-rows, 1))` on `.chalk-voice-peer--grid` is gone, because it
  bent the 16:9 tiles when it applied. The forced grid passes `compact` to its
  tiles from three tiles up, like the mixed grid.
- A grid tile is an inline-size container. On a tile that is 220px wide or
  less, a container query hides the pop-out and mute-for-me buttons, so the
  name and the status icons keep their room. On 133px tiles the names were gone
  even with the short labels. The buttons stay on larger tiles.
- In a call, the scratchpad caption sits in the call bar, between the duration
  and the buttons, on one line with an ellipsis. In the lobby it stays below
  the panel. This saves one row, as in the mockup of the owner.

The margin came from a second demo. The window was about 1229px by 790px,
with one camera, four cards in two rows, and one note in the scratchpad. The
last card still lost its bottom few pixels. Rounding down and the 2px
tolerance let the measurement land a few pixels too high. The margin converges:
if the grid shrinks by 8px, the scratchpad gains 8px, and the next measurement
returns the same value.

The probe ran on the dev stack with five users and fake cameras, at 1280px by
800px, 1229px by 790px, 1229px by 700px, and 1440px by 900px. The cases were
one camera with four cards, two cameras with three cards, three cameras with
two cards, five cameras, and the forced grid. The sweep has a note in the
scratchpad. The clip check flags any tile or card whose bottom passes the
bottom of the stage, not only `scrollHeight > clientHeight`. No case clipped.
These tile sizes were measured:

| Window | One camera | Three cameras | Five cameras |
|---|---|---|---|
| 1280px by 800px | 446px by 251px | 277px by 156px | 262px by 147px |
| 1229px by 790px | 428px by 241px | 268px by 151px | 262px by 147px |
| 1229px by 700px | 268px by 151px, with four cards | 188px by 106px | 250px by 140px |

At 1229px by 700px, the forced grid of five showed every name, with an
ellipsis on long names. The tiles are small at a height of 700px with an empty
scratchpad, because the scratchpad keeps 160px for its explanation.

The slice replaced the reserve test of 133-10 in `theme-voice-pane.test.ts`
with a test for the measured height. It also checks that no `100dvh - NNNpx`
reserve remains and that the caption sits in the bar. A second new test covers
the container rule for small tiles.

## What was rejected

- Floating card panels. The sticky header, the season canvas, the drawer, and
  the desktop title bar all depend on the flush grid.
- Channel-header actions for pin, members, share, and more. Only search exists.
- A separate "+" attach button.
- The idle and busy presence states of the mockup. chalk has online, away, and
  offline.
- A header height of 60px to 64px. The season bitmap is sized from the header,
  and the height stays 56px.
- JetBrains Mono as the default face. The font is a preference of the device,
  and Hack stays the default.
- The token names of the review (`--bg-app`, `--text-primary`). The
  `--chalk-*` names stay, with the missing roles added.
- A separate theme for the new green. The review palette replaces the default
  green.
- A 4.5:1 floor for the hover surface. See the contrast floors above.

## The slices

- **133-1 — tokens and the green palette.** The palette, the derived-token
  rule, the radius scale, the durations, `--chalk-size-body`, and the
  reduced-motion rule in `theme.css`. The two solarized-dark overrides. The
  lcars radii. The swatch, `index.html`, and `manifest.json`. The derived
  floors in `theme-palette.test.ts`. `theme-tokens.test.ts`. The seven
  replaced tokens. `docs/theming.md`. Done.
- **133-2 — dead fallbacks and green hover tints.** Done. See the section
  below.
- **133-3 — surfaces and spacing.** The two surfaces, no sidebar dividers,
  the spacing tokens, `--chalk-bg-hover` and `--chalk-bg-selected` on the
  raised sidebar, and the warmwhite unread fix. All in `theme.css`. Done.
  Measured on the dev stack at 1280 by 800:

  | Part | Size |
  |---|---|
  | Header | 56px |
  | Channel header | 49px |
  | Channel row | 32px |
  | Friend row | 26px |
  | Sidebar | 220px |

  In solarized-dark, `--chalk-border` equals `--chalk-bg-elev`. The outlines
  of the sidebar "+" buttons and the bottom rule of the channel header vanish
  on the raised surfaces. The result reads acceptably. 133-7 accepted it.
- **133-4 — the interaction contract.** The inset ring on the selected row,
  the radius and transition on the row-like rules, the 13 deleted per-theme
  rules, and the four emphasis overrides in cyberpunk, lcars, blade-runner,
  and exchalk. The unread name, the `.chalk-call-rail-btn.is-on` rule, the
  transition on five button rules, the global focus rule, and the
  reduced-motion guard for `.chalk-status-dot--connecting`. Two tests in
  `theme-sidebar.test.ts`. All in `theme.css`. Done.
- **133-5 — the composer.** The tool row on one surface, the tool block
  mounted and hidden during an edit, `IconEmoji`, the 16px icons, the filled
  send button, the accent focus outline, and the deleted edit-mode send rules.
  The phone block keeps the 2x2 grid. Four tests in `theme-composer.test.ts`.
  `Composer.tsx` and `theme.css`. Done.
- **133-6 — the empty states.** `MessageList.tsx`, `App.tsx`, and
  `theme.css`, `Logo.tsx`, and two tests in `theme-empty.test.ts`. Done. Seen
in a browser in the empty channel in green, light, and blade-runner. The
"no channel open" screen was not seen in a browser. A new account opens in the
Parking Lot, which has its own large mark from an earlier phase, and the
screen shows only when no channel and no parking lot is open. The type-check
and the test cover it.
- **133-7 — the theme sweep.** Screenshots of the desktop shell in all 15
  themes and of the green phone layout. No theme missed the contract, so the
  slice changed no code. The weak outlines in solarized-dark, darkord, and
  exchalk are accepted. Done.
- **133-8 — one tile list.** The stage calls `railTiles`. `StageTile` is an
  alias of `RailTile`. About 90 lines, `rosterFor`, and one import are gone
  from `VoiceCallPanel.tsx`. One test in `rail-tiles.test.ts`. No visible
  change. Done.
- **133-9 — an adaptive stage.** People with audio only get compact cards.
  People with a camera get 16:9 tiles. A screen share keeps the main area. A
  mixed call combines both. `resolveStageMode`, the `card` prop of
  `StagePeer`, the toggle cycle, and the rules for `.chalk-voice-videos` and
  `.chalk-voice-cards`. Four tests. Done. See the section above.
- **133-10 — the scratchpad and a quieter call panel.** The notice becomes
  the empty state, and a one-line caption stays once the scratchpad has text.
  The flags for muted, deafened, camera, and screen become icons. One and two
  cameras get a height cap. `VoiceCallPanel.tsx`, `App.tsx`, `theme.css`, and
  two tests in `theme-voice-pane.test.ts`. Done. See "The scratchpad and a quieter call panel (133-10)".
- **133-11 — the voice room sweep.** Five users in one room, with no camera,
  with two, three, and five cameras, with a screen share, in six themes, and
  at phone width. It found three faults, and the slice fixes them: the stage
  clipped with three or more cameras, long labels hid the names on small
  tiles, and the cards vanished in solarized-dark. `videoGrid`, the `compact`
  prop, the width cap for any number of cameras, and the card surface. Two
  tests changed in `theme-voice-pane.test.ts`, and `grid.test.ts` has one new
  test. Done. See "The voice room sweep (133-11)".
- **133-12 — every participant stays visible.** After a live demo the fourth
  card was cut off in a window of 1229px by 790px. The panel measures the
  height of the camera grid and sets `--voice-media-h`. The measured height
  replaces the reserves of 133-10 and 133-11 and caps the forced grid. Small
  tiles hide the pop-out and mute-for-me buttons. The scratchpad caption sits
  in the call bar. `VoiceCallPanel.tsx`, `theme.css`, and two tests in
  `theme-voice-pane.test.ts`. Done. See "Every participant stays visible
  (133-12)".

## Left open

- The "no channel open" screen was not seen in a browser. A new account opens
  in the Parking Lot. See the checklist.
- The thread pane composer is narrower than the main one. It was not seen in a
  browser with all four tools. See the checklist.
- After a live resize from a phone width back to a desktop width, the header
  measured 59px and not 56px. A reload restores 56px. 133 does not cause it.
  It is not investigated.
- The channel header band stops 8px short of the scrollbar lane on the right.
  133-3 left it as it is.
- The remaining items of the manual checklist.
- The speaking highlight with five people was not seen. It was seen with two.
- A call of more than five people was not swept.

## Manual checklist

The 133-7 sweep looked at the empty channel, the selected row, the unread
channel, and the filled send in 15 themes at 1280 by 800. The sweep did not
open the checklist items below, except where an item names an empty channel
or a selected row in a theme that the sweep covered.

Open after 133-9:

- Open a voice room on a phone with no camera on. The cards must fit the
  width and show the name and the volume slider.
- Speak in a voice room with no camera on. The card of the speaker must have
  its border in the accent color.
- Share a screen in a room with cards. The share must take the main area.

Open after 133-6:

- Open the shell with no channel and no parking lot open. The mark, the
  title, and the hint must show, centred, in the colors of the theme.
- Do the same in a light theme and in blade-runner. The mark must follow the
  accent of the theme.
- Open an empty text channel and an empty direct message. The hints must name
  the channel or the person.
- Open an empty thread panel. It must keep the one-line hint.

Open after 133-5:

- Open a thread pane. Its composer is narrower than the main one. All four
  tools must fit in it.
- Set the tool style to text on a desktop. The labels must fit the row.
- Edit a message. The field must not move.
- Look at send in a light theme and in a dark theme. It must be filled when
  the field has text, and its label must be readable.

Open after 133-4:

- Press Tab through the sidebar, the channel header, and the composer in the
  green theme and in a light theme. A ring must show on every control.
- Select a channel in cyberpunk, lcars, blade-runner, and exchalk. The row
  must keep its emphasis color, and the fill must show.
- Share a screen during a call. The call-rail button must show the warn color.

Open after 133-3:

- Open the shell at a phone width and open the drawer. It must sit on the
  raised surface.
- Look at a channel group heading. It must still read as a heading without
  the hairline.
- Open the warmwhite theme. The unread envelope must show on the dark rail.

Open after 133-2:

- Open a light theme and a theme that is not green. Hover and select an item
  in the presence menu. The colors must follow the theme, with no green tint.
- In the same themes, hover the reshare button in the member list and the
  verify buttons. The highlight must follow the accent of the theme.

Open after 133-1:

- Look at the default theme on an OLED screen. Body text, the muted tier, and
  the selected row must read well.
- Compare the shape of buttons, inputs, and rows in the default theme with
  the build before 133-1. Corners are now 6px.
- Open the lcars theme. The pills must keep their 10px radius.
- Open the solarized-dark theme and select a row. The selected row must read
  clearly, and the label of a filled accent control must be dark.
- Open the warmwhite theme. The dark rail must show its own hover color.
- Turn on reduced motion in the operating system. Transitions on
  `--chalk-dur` and `--chalk-dur-fast` must stop.
- Hover a button, a login button, and a row in the add-friend list of the
  member panel. The hover background must show. Hover the remove and leave
  actions in the member list. They must turn red.
