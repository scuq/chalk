# Phase 125 — the channel header survives the phone keyboard

**Status:** 125-1 built (2026-09-13). Unit-tested by
`web/src/viewport.test.ts`, which checks the pure height function and
asserts the CSS declarations against the stylesheet. Not yet checked on a
real iPhone — see the manual checklist.

**Tags:** `#mobile` → `tools/where.sh -g mobile`

## The problem

On a phone below the 767px mobile breakpoint, a tap into the composer opens
the on-screen keyboard. The whole page then moves up. The channel header,
with its back button, leaves the top of the screen, and the user cannot
reach it until the keyboard closes. This was seen on an iPhone in iOS
Safari. The composer stays visible throughout — that part is by design, not
the bug.

The cause is the app shell's fixed height. `.chalk-app` is pinned to
`height: 100dvh`, and `html` and `body` carry `min-height: 100dvh`. iOS
Safari does not shrink the layout viewport or `dvh` when the keyboard
opens — only the visual viewport shrinks. The document then measures taller
than the visible area, and Safari scrolls the window up to bring the
focused text area into view. The header scrolls off along with it.

Composer auto-focus is not involved. `App.tsx` already passes
`focusKey={null}` on mobile, and the keyboard opens only from a direct tap.

## The design (125-1)

- `web/src/viewport.ts` (new): `shellHeight` reads the visual viewport
  height, rounds it, and caps it at the layout viewport height. It falls
  back to the layout viewport height when the visual height is not a
  usable number, or when the page is pinch-zoomed, because a zoom also
  shrinks the visual viewport and must not shrink the shell.
  `useKeyboardSafeShell` listens for `visualViewport` resize and scroll,
  throttled to one animation frame, and writes the result to a CSS custom
  property on the root element. It writes through the CSSOM rather than a
  style attribute, since chalk's style-src stays strict. When the page is
  not zoomed and the window has scrolled, it resets the scroll position to
  zero, undoing Safari's own scroll-into-view. While inactive, without a
  `visualViewport`, or on unmount, it removes the property, so the
  stylesheet's `100dvh` fallback applies and the desktop layout is
  untouched.
- `web/src/components/App.tsx` calls `useKeyboardSafeShell(isMobile)`.
- `web/src/theme.css`, inside the phone media query: `html` and `body` take
  their height from the same property instead of a fixed `min-height`, and
  the app shell rule gains the same `height` declaration alongside its
  existing one.

Rejected:

- `interactive-widget=resizes-content` in the viewport meta tag. Chrome on
  Android reads this value. iOS Safari ignores it, and iOS is where the bug
  shows.
- Removing or gating the composer's focus calls on mobile. The user reports
  the keyboard opens only from a tap. Focus was never the cause.
- Moving the shell by `visualViewport.offsetTop` instead of resetting the
  scroll position. This adds a moving part and fights Safari's own scroll
  behavior instead of replacing it.

## Known edge, not closed

The mobile thread panel and the roster drawer are each `position: fixed`
with `inset: 0`, or `top: 0` and `bottom: 0`. They size to the layout
viewport, not to the new property, so the keyboard can still cover the
bottom of the thread panel, including its reply composer. The scroll reset
still keeps the page itself from moving. This is tracked here as an open
edge, not fixed by 125-1.

## Manual checklist

- [ ] iPhone Safari: open a channel, tap the composer. The header and the
      back button stay on screen.
- [ ] iPhone Safari: type a message and send it. The keyboard closes and
      the shell returns to full height.
- [ ] Installed home-screen app (standalone mode): same two checks.
- [ ] Pinch-zoom with the keyboard closed, then open the keyboard. The
      shell does not collapse.
- [ ] Rotate to landscape with the keyboard open.
- [ ] Open a thread and tap its reply composer. The known edge above can
      still show.
- [ ] Android Chrome: repeat the first two checks.
