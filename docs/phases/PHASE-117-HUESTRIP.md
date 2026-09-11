# Phase 117 — the name colour picker: a hue strip, since hue is all that is kept

**Status:** built, 117-1 (2026-09-12). Verified against a running stack:
two fresh accounts friended, 11 checks on the real DOM (the probe in
`.claude/skills/run-chalk/probes/ui.mjs` at the time) — the strip in both
places, a drag committing on release and recolouring the roster name, the
swatch matching that name exactly, reopen landing on the released hue, an
arrow key stepping one hue, "auto" snapping back. The light-theme repaint
below is still a manual check.
**Tags:** `#nickcolor` → `tools/where.sh -g nickcolor`

## The problem

scuq reported the roster's colour picker "always lands on the same point":
pick a pale peach for a friend, close, reopen, and the picker sits on a
saturated orange nobody chose. Drag the hue to green and the green sticks,
but the point stays in that same saturated band.

It was not stale state. 9.7f stores a name colour as a **hue only** — the
theme supplies saturation and lightness so one number per person reads on
every theme, including ones added later (`web/src/chat/nickcolor.ts` has the
full reasoning). The picker, though, was `<input type="color">`: a square
of every saturation and lightness, of which chalk kept one axis and threw
away two. On reopen it was reseeded from the hue through a fixed mid
saturation and lightness (`hexFromHue`), which is the "same point". The
picker offered choices that could not be made, and then looked broken for
having ignored them.

## The design

### 117-1 — offer only what is kept

scuq's framing: *if hue is not kept, show a picker where nothing is shown
that we cannot select.* So the control is a **hue strip**: one native
`<input type="range">` from 0 to 359, its track painted as a gradient of
`hsl(h var(--nick-s) var(--nick-l))` at seven stops. Because the stops use
the theme's own saturation and lightness, every point on the strip is a
colour chat will actually render on the active theme, and switching theme
repaints the strip along with the names. A live preview sits beside it —
the "you" word in the profile picker, the dot swatch in the roster menu —
and follows the drag through local state; the pref commits on `change`
(release), not per pixel, since each commit fans out to the person's other
devices, the same rule the sidebar-width slider follows.

`HueSlider` (`web/src/components/HueSlider.tsx`) is shared by both places
the old input lived: the profile panel's "your color" and the roster's
right-click menu. The roster menu's title swatch moved down beside the
strip, so it is the live one; the buttons take their own row under it.

**Rejected:** storing the picked hex alongside the hue so the full picker
reopens where it was left. It keeps a control whose two useless axes still
have to be explained, and it adds a field to the prefs blob to remember
something chat never uses. **Rejected:** seeding the full picker from the
theme's saturation and lightness instead of fixed values — it would snap to
the colour chat shows rather than a stranger one, but it still snaps.

No storage change, no server change; the hue prefs are read and written
exactly as before, and `hueFromHex` stays for the 9.7e legacy hex rules.

## Manual checklist

- [ ] Right-click a friend: the strip opens at their current hue, the dot
      follows the drag, releasing recolours their name in chat, reopening
      lands on the same spot you released.
- [ ] "auto" snaps the strip and dot back to the hashed hue.
- [ ] Settings → chat → "your color": same, with "you" as the preview.
- [ ] Switch to a light theme: the strip's colours change with the names.
- [ ] Keyboard: focus the strip, arrow keys step one hue and commit.
