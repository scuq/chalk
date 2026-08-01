# Theming

chalk's UI is themed entirely via CSS custom properties. Three layers cascade:

```
:root              ← default theme (Matrix green-on-black)
[data-theme="X"]   ← built-in alternate themes (light, solarized, amber, ...)
:root              ← user overrides injected at runtime from settings
```

Because the user-override `<style>` is appended last to `<head>`, it wins.

## Token categories

- **Color — surfaces**: `--c-bg`, `--c-bg-elev-1`, `--c-bg-elev-2`, `--c-bg-input`, `--c-overlay`
- **Color — foreground**: `--c-fg`, `--c-fg-dim`, `--c-fg-muted`, `--c-fg-faint`, `--c-fg-inverse`
- **Color — semantic**: `--c-accent`, `--c-link`, `--c-warn`, `--c-error`, `--c-ok`
- **Color — chat**: `--c-self`, `--c-other`, `--c-system`, `--c-mention`, `--c-thread-line`, `--c-selection-bg`, `--c-selection-fg`, `--c-cursor`
- **Color — borders**: `--c-border`, `--c-border-strong`, `--c-focus-ring`
- **Typography**: `--font-mono`, `--font-ui`, `--font-size-base`, `--font-size-sm`, `--font-size-lg`, `--line-height`, `--letter-spacing`
- **Spacing**: `--sp-0` … `--sp-6`
- **Radius**: `--radius-sm`, `--radius-md`, `--radius-lg`
- **Motion**: `--motion-fast`, `--motion-base`, `--motion-slow`, `--easing`
- **Effects**: `--shadow-1`, `--shadow-glow`
- **Layout**: `--sidebar-w`, `--thread-w`, `--composer-min-h`, `--composer-max-h`
- **Semantic aliases**: `--c-board` (alias for `--c-bg`), `--c-chalk` (alias for `--c-fg`), `--c-chalk-dim` (alias for `--c-fg-dim`)

## Built-in themes

| Theme | Vibe |
|---|---|
| (default) | Matrix — bright green on pure black, sharp corners, glow on focus |
| `light` | Accessible light theme, soft radii |
| `solarized-dark` | Solarized base16 |
| `amber` | Retro amber terminal |

Switch via `<html data-theme="...">`. The default theme is applied when no `data-theme` is set.

## User overrides

Each user can override any token from settings. The override map is stored as part of the encrypted settings blob (server doesn't see it) and synced across the user's devices.

```js
applyUserOverrides({
  "--c-fg":  "#ff00aa",
  "--font-mono": "Fira Code",
  "--radius-md": "8px"
});
```

Internally this writes a `<style id="user-overrides">:root { ... }</style>` element appended last to `<head>`. The settings UI lets users edit the most impactful tokens (8 default-visible, full set behind an "advanced" disclosure).

## Adding a built-in theme

1. Add a `[data-theme="yourname"] { --c-bg: ...; ... }` block in `web/themes.css`
2. Override only the tokens you need; the rest cascade from the default
3. Add an entry to the theme picker in `web/settings.js`

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
