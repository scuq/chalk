# Theming

chalk's UI is themed entirely via CSS custom properties, all of them in
`web/src/theme.css`. Two layers cascade:

```
:root                ← the default theme (near-black with mint text)
[data-theme="X"]     ← every other built-in theme
```

The chosen theme is a synced user pref (`UserPrefs.theme`), applied by setting
`data-theme` on `<html>`; the default theme is what shows when no attribute is
set. Per-device display prefs (font family, font scale, scrollbars) are a
separate mechanism and win over both layers, because they are written as inline
styles on the same element — see `web/src/display-prefs.ts`.

## Tokens

A theme block redeclares the eleven palette tokens. It can also override any derived token with a hex value. It declares nothing else:

| Token | Role |
|---|---|
| `--chalk-bg` | the page ground |
| `--chalk-bg-elev`, `--chalk-bg-elev-2` | two elevation steps: panels and inputs, then hover rows, badges and code blocks |
| `--chalk-fg` | body text |
| `--chalk-fg-dim` | secondary text — timestamps, hints |
| `--chalk-fg-bright` | emphasis — titles, active states |
| `--chalk-fg-muted` | placeholders and disabled text |
| `--chalk-border` | rules and edges |
| `--chalk-accent` | links, focus rings, selected states |
| `--chalk-warn`, `--chalk-error` | the two signal colors |

Plus `color-scheme`, so form controls and scrollbars follow.

### Derived tokens

Seven more tokens come from the palette through `color-mix()`, in one rule in
`web/src/theme.css`. No theme block needs to declare them. The rule also names
the warmwhite rail, because the rail declares its own palette on
`.chalk-sidebar`, and a derived token must resolve against that palette. To
change one derived token in one theme, set a hex value for it in the theme
block. The palette test then uses that hex.

The cyberpunk, lcars, and blade-runner themes are the worked example.
Their selected row uses the emphasis color and not the accent. Each block sets
`--chalk-bg-selected` to a hex and `--chalk-border-strong` to a mix from
`--chalk-fg-bright`. A theme does not write a component rule for the selected
row.

The exchalk theme sets `--chalk-bg-selected` and `--chalk-bg-hover` to hex
values. It does not set `--chalk-border-strong`, so its selected row has an
accent edge.

| Token | Role |
|---|---|
| `--chalk-bg-hover` | hovered rows and buttons |
| `--chalk-bg-selected` | the selected row |
| `--chalk-border-strong` | the edge of the selected row |
| `--chalk-accent-hover` | the accent control under the pointer |
| `--chalk-accent-dim` | a quiet accent fill |
| `--chalk-on-accent` | text on an accent fill |
| `--chalk-focus` | the keyboard focus ring |

The rest of the token set is theme-independent and lives on `:root`:
type (`--chalk-font-*`, `--chalk-font-scale`, `--chalk-size-*`), spacing
(`--chalk-s1` … `--chalk-s6`), the radius scale, the durations, and the presence colors
(`--chalk-presence-*`), which are a fixed status signal — "online" means the
same green in every theme, so a theme block must not override them. The radius
scale is `--chalk-radius-sm` (4px, badges and chips), `--chalk-radius-md` (6px,
rows, buttons, and inputs), and `--chalk-radius-lg` (8px, panels).
`--chalk-radius` is an alias of the md radius. A theme block can override the
three, as `lcars` does with 10px. The durations are `--chalk-dur-fast` (100ms)
and `--chalk-dur` (160ms). Nick colors
are per-user hues with theme-supplied saturation and lightness
(`--nick-s` / `--nick-l`); see `web/src/chat/nickcolor.ts`.

## Built-in themes

Light: `light` (warm cream), `snazzy-light`, `warmwhite` (dark rail beside a
paper page), `vscode-light`, `catppuccin-latte`.

Dark: the default near-black with mint text, `cyberpunk`, `solarized-dark`, `tokyo-night`,
`lcars`, `blade-runner`, `azeroth`, `darkord`, `exchalk`, `catppuccin-mocha`.

Two of them bend more than color, which is what makes them read as themselves:
`lcars` takes pill radii and uppercase tracked headers, and `warmwhite`
re-declares the palette scoped to `.chalk-sidebar` so the whole subtree
re-tints from one block.

## Contrast policy

Published palettes are tuned for syntax on an editor ground, not for UI text,
and most of them land somewhere under 4.5:1 on at least one tier. The house
rule is to keep the hue and move the lightness, and to say so in the comment
above the block: body, dim and emphasis clear 4.5:1 on `--chalk-bg`, the muted
tier and the signal colors clear 3:1, and nothing drops below 3:1 on
`--chalk-bg-elev-2`. `web/src/theme-palette.test.ts` enforces exactly that, and
also holds the picker and the stylesheet to the same theme names.

The derived tokens have floors of their own, and the same test enforces them:

- `--chalk-fg` clears 3:1 on `--chalk-bg-hover`, the same floor as the top
  surface `--chalk-bg-elev-2`, and 4.5:1 on `--chalk-bg-selected`.
- `--chalk-fg-bright` clears 3:1 on `--chalk-bg-selected`.
- `--chalk-on-accent` clears 4.5:1 on `--chalk-accent` and on
  `--chalk-accent-hover`, because a label on an accent fill is small text.
- `--chalk-focus` clears 3:1 on `--chalk-bg`.

`web/src/theme-tokens.test.ts` adds one more check. Every custom property that
the stylesheet reads must be declared in the sheet or set by TypeScript. A
`var()` with no declaration and no fallback drops its whole declaration
without a message.

## Motion policy

chalk is still by default. Phase 115 added *flair* — the animated mode: a
flame on a busy channel, a wave through a friend's name, animated frames
around profile pictures, a slow drift on the channel banner — and with it
the rules any motion in the sheet follows:

1. **Off unless asked for.** Flair is a per-device switch in
   `web/src/display-prefs.ts`, default off, written as `data-flair` (and one
   `data-flair-<effect>` per effect) on `<html>`. Every flair rule is gated on
   one of those attributes, so with the switch off the section matches
   nothing. The flair section sits at the end of `web/src/theme.css`.
2. **Reduced motion wins.** One `@media (prefers-reduced-motion: reduce)`
   block closes the section and turns every flair animation off, leaving each
   effect's resting shape: a still flame, letters where plain text sits, a
   static ring, the banner at its zoom. There is no override for it, and
   `web/src/theme-flair.test.ts` holds every animated flair selector to that
   block. The convention predates 115 (the parking-lot drift, the resizers)
   and is CSS-only; nothing in TypeScript reads the media query.
3. **Compositor properties only.** Flair animates `transform`, `translate`,
   `scale`, `opacity`, `outline`, `box-shadow` and `filter` — never a
   layout property, and never inside the message feed. The banner drift uses
   the individual `translate`/`scale` properties because `BannerBand` sets
   `transform` inline for its zoom, and the two compose.
4. **Colours come from the tokens** (`--chalk-warn` for heat, `--chalk-accent`
   for the pulse ring) so every theme passes the palette test unchanged. The
   aurora frame is the one deliberate exception: a spectrum is the same
   spectrum in every theme.
5. **Transitions use the duration tokens.** A transition is written on
   `--chalk-dur` or `--chalk-dur-fast`. One `@media (prefers-reduced-motion:
   reduce)` rule in the `:root` section sets both to 0ms, so every transition
   on a token stops without a guard of its own.

## Adding a built-in theme

1. A `[data-theme="yourname"] { ... }` block in `web/src/theme.css` declaring
   all eleven tokens plus `color-scheme` — not a partial override, so nothing
   silently inherits the green theme
2. A comment above it saying where the palette came from and which tones were
   moved to clear the floors above
3. A `.chalk-profile-theme-swatch-preview--yourname` gradient for the picker
   swatch, hard-coded hex so the preview shows its own theme whichever one is
   active
4. The name and a one-line description in the picker array in
   `web/src/components/ProfilePanel.tsx`, and in the `UserPrefs.theme` comment
   in `web/src/state/types.ts`
5. A light theme also wants the modal shadow and softened backdrop the other
   light themes carry, and a place in the `--nick-s` / `--nick-l` selector list
   at the bottom of the sheet
6. `node test.mjs` — the palette test will tell you which tone is short. It
   also checks the floors of the derived tokens. If a derived token misses a
   floor, set a hex value for that one token in the theme block

## Bundled fonts

Four monospace families ship in `web/fonts/`, WOFF2 only, as the unmodified upstream release bytes (no subsetting — the OFL families carry Reserved Font Names):

| Family | Version | Faces | Licence |
|---|---|---|---|
| Hack | 3.003 | regular, bold, italic, bold-italic | MIT + Bitstream Vera |
| JetBrains Mono | 2.304 | regular, bold, italic, bold-italic | OFL 1.1 |
| Fira Code | 6.2 | regular, bold | OFL 1.1 |
| Cascadia Code | 2407.24 | regular, bold, italic, bold-italic | OFL 1.1 |

Fira Code has no italic upstream; browsers oblique its uprights instead. All faces use `font-display: swap`, so the input is interactive immediately with a system fallback while the face loads.

Each family has a stack token in `web/src/theme.css` — `--chalk-font-mono` (Hack), `--chalk-font-jetbrains`, `--chalk-font-fira`, `--chalk-font-cascadia`, plus `--chalk-font-sans` and `--chalk-font-serif` for the system faces. The per-device preference (`web/src/display-prefs.ts`) picks one by setting `--chalk-font: var(--chalk-font-<choice>)` inline on `<html>`; everything else in the sheet reads `--chalk-font`.

Adding a family means: the WOFF2 files and their licence text in `web/fonts/`, a `/*! ... */` legal comment and `@font-face` rules in `theme.css`, a `--chalk-font-<name>` token, a `.chalk-profile-font-sample--<name>` rule for the picker swatch, and an entry in `FONT_CHOICES`. `web/src/theme-fonts.test.ts` checks the token and the file paths line up.

There is no mechanism for users to supply their own font: `font-src 'self'` in the CSP (`internal/server/spa.go`) means a face must be served from chalk itself, which means it must be bundled.
