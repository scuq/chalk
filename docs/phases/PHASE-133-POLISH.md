# Phase 133 — polish: semantic tokens and a refined shell in every theme

**Status:** 133-1 built (2026-11-08). 133-2 to 133-7 planned. 133-1 is
unit-tested by `web/src/theme-palette.test.ts` (the contrast floors of the
palette and of the derived tokens) and by `web/src/theme-tokens.test.ts`
(every custom property the stylesheet reads is declared). The manual
checklist at the end of this file is open.

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

### The interaction contract (133-4, planned)

One rule set applies to every row-like control in the shell: the sidebar
items, the group headers, the member rows, and the presence and status menu
items. Each has a transparent 1px border, `--chalk-radius-md`, and a
transition on `--chalk-dur-fast`. Hover uses `--chalk-bg-hover`. The active
row uses `--chalk-bg-selected`, `--chalk-border-strong`, and
`--chalk-fg-bright`. An unread row uses `--chalk-unread` and a heavier font.

A global focus rule has zero specificity (`:where()`), so every existing
per-selector focus rule still wins. It draws a 2px outline in `--chalk-focus`.
The 15 per-theme blocks that tune the active row are deleted, and the derived
token replaces them.

### Surfaces and spacing (133-3, planned)

The shell has two surfaces. The sidebar, the call rail, and the mobile drawer
sit on `--chalk-bg-elev`. The main pane and the header sit on `--chalk-bg`.
The channel header keeps its `--chalk-bg` shadow strip, because the strip
hides the feed under the sticky gap. The divider lines in the sidebar go, and
a margin of `--chalk-s3` replaces them. The section titles carry the grouping.
Channel rows go from 8px to 6px of vertical padding. Friend rows keep the 3px
that [phase 132](PHASE-132-FRIENDCOLUMNS.md) set. Paddings and margins in
these ranges move to the `--chalk-s*` tokens. A hover background there must
use `--chalk-bg-hover`, because a `--chalk-bg-elev` hover is not visible on a
`--chalk-bg-elev` sidebar.

### The composer (133-5, planned)

On a desktop, `.chalk-composer-tools` is one flex row on a bordered
`--chalk-bg-elev` surface. The tool buttons are borderless squares of 28px.
The textarea gets `--chalk-border` and `--chalk-radius-md`, and its border
turns to `--chalk-accent` on focus. Send is a filled button: `--chalk-accent`
background, `--chalk-on-accent` text, and `--chalk-accent-hover` on hover.
When it is disabled, it is an outline. The tool block stays mounted during an
edit and is hidden with `visibility: hidden`, so the row keeps its width. A
new SVG icon for the emoji tool replaces the character, so the four tools
share one stroke style. The `rows`, the stretch, and the
`--chalk-composer-h` clamp do not change, so `composer-height.ts` needs no
edit. The mobile block goes back to the 2x2 grid of phase 94.

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
  and the height stays 53px.
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
- **133-2 — the old green literals become tokens.** About 63 places in
  `theme.css` hold the old green as a literal or as a `var()` fallback. The
  fallbacks go, hover tints become `--chalk-bg-hover`, and accent literals
  become `--chalk-accent`. Two places keep their literal and get a comment:
  the notice for a browser with no JavaScript, and the matrix flair frame.
  Planned.
- **133-3 — surfaces and spacing.** The two surfaces, no sidebar dividers,
  and the spacing tokens. Planned.
- **133-4 — the interaction contract.** The contract, the global focus rule,
  and the deleted per-theme blocks. A rule for `.chalk-call-rail-btn.is-on`
  and a first rule for `.chalk-sidebar-item--unread`. A reduced-motion guard
  for `.chalk-status-dot--connecting`. Planned.
- **133-5 — the composer.** `Composer.tsx` and the composer rules in
  `theme.css`. Planned.
- **133-6 — the empty states.** `MessageList.tsx`, `App.tsx`, and
  `theme.css`. Any string that `test/e2e` asserts stays. Planned.
- **133-7 — the theme sweep.** Screenshots of the desktop shell in all 15
  themes and of the green phone layout. A theme that misses the contract is
  fixed by an override of one derived token in its block, never by a component
  rule. Planned.

## Left open

- 133-2 to 133-7, as listed above.
- Literals of the old green palette stay in `theme.css` until 133-2.

## Manual checklist

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
