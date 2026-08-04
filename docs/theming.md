# Theming

chalk's UI is themed entirely via CSS custom properties, all of them in
`web/src/theme.css`. Two layers cascade:

```
:root                ← the default theme (matrix green-on-black)
[data-theme="X"]     ← every other built-in theme
```

The chosen theme is a synced user pref (`UserPrefs.theme`), applied by setting
`data-theme` on `<html>`; the default theme is what shows when no attribute is
set. Per-device display prefs (font family, font scale, scrollbars) are a
separate mechanism and win over both layers, because they are written as inline
styles on the same element — see `web/src/display-prefs.ts`.

## Tokens

A theme block redeclares the eleven palette tokens and nothing else:

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

The rest of the token set is theme-independent and lives on `:root`:
type (`--chalk-font-*`, `--chalk-font-scale`, `--chalk-size-*`), spacing
(`--chalk-s1` … `--chalk-s6`), `--chalk-radius`, and the presence colors
(`--chalk-presence-*`), which are a fixed status signal — "online" means the
same green in every theme, so a theme block must not override them. Nick colors
are per-user hues with theme-supplied saturation and lightness
(`--nick-s` / `--nick-l`); see `web/src/chat/nickcolor.ts`.

## Built-in themes

Light: `light` (warm cream), `snazzy-light`, `warmwhite` (dark rail beside a
paper page), `vscode-light`, `catppuccin-latte`.

Dark: the default matrix green, `cyberpunk`, `solarized-dark`, `tokyo-night`,
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
6. `node test.mjs` — the palette test will tell you which tone is short

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
