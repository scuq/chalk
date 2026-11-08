# Phase 133 — polish: semantic tokens and a refined shell in every theme

**Status:** 133-1 to 133-5 built (2026-11-08). 133-6 and 133-7 planned.
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

### The empty states (133-6, planned)

An empty channel shows the chalk mark, a title, and the existing hint. The
mark and the title are not shown while the hint is the loading text. The page
for "no channel selected" gets the same split. The text has no glow and no
animation.

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

  For 133-7: in solarized-dark, `--chalk-border` equals `--chalk-bg-elev`. The
  outlines of the sidebar "+" buttons and the bottom rule of the channel
  header vanish on the raised surfaces. The result reads acceptably. Decide in
  the theme sweep.
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
  `theme.css`. Any string that `test/e2e` asserts stays. Planned.
- **133-7 — the theme sweep.** Screenshots of the desktop shell in all 15
  themes and of the green phone layout. A theme that misses the contract is
  fixed by an override of one derived token in its block, never by a component
  rule. Planned.

## Left open

- 133-6 and 133-7, as listed above.
- After a live resize from a phone width back to a desktop width, the header
  measured 59px and not 56px. A reload restores 56px. 133 does not cause it.
  It is not investigated.

## Manual checklist

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
