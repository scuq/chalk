# Phase 135 — phone: the chat list is the phone layout, with a call bar and a call view

**Status:** in progress. 135-1 and 135-2 are built (2026-11-13). 135-3 to 135-8 are planned and have no code.
**Tags:** `#zucker`, `#mobile`, `#roster`, `#voice` → `tools/where.sh -g zucker`

## The problem

Before 135-1, the chat list (named zuckermode in older documents, `zucker` in the code) was an opt-in.
A missing `roster.viewMode` resolved to `"classic"`.
The classic phone layout put the roster in a drawer behind a menu button.
The owner decided that the chat list is the only phone layout.
That decision made the drawer, its toggle, and the preference dead code.

Voice on the phone has no single in-call surface.
The room page has no mute and no leave.
The footer buttons have 32 px targets.
The desktop got a call rail in phase 131, and the phone needs an equivalent.

Research into WhatsApp, Telegram, Signal, Discord, and Element gave these targets:

- The back button and the back gesture pop one layer, because each layer is a history entry.
- The app catches up at once when it returns from the background. There is no pull-to-refresh.
- A call shows as a bar on every screen, and a tap opens a full-screen call view with large round controls.
- Touch targets are 44 px or more.

## The design

The phone has one list.
A row opens its chat, and the back arrow returns to the list.
A call shows as a bar at the bottom, above the composer, on every screen except the call view.
The bar sits at the bottom because the bottom is in thumb reach.
A tap on the bar opens the call view.

Freshness is resume handling only.
The service worker stays in phase 65.

### Navigation rules of the call view (135-5)

- A tap on the call bar opens the call view.
- The chat button in the call view opens the chat of the room.
- A tap on a room the user is already in opens the call view. It does not join a second time.
- A swipe down, the arrow, or the back gesture closes the call view.
- Only the leave button ends the call.
- A move takes 160 ms.

### Call view layout (135-5)

- In an audio call (no camera on), each person has a compact card with a name, a picture, and a level meter. Eight cards fit without a scroll.
- When a camera is on, video takes the room. People with audio only go to a strip. The user's own picture is a corner preview.
- The speaker has a thin moving border and three level bars. With reduced motion, nothing moves.
- The controls are rounded-square buttons: mute, deafen, camera, share, and leave. A muted button has an amber tint. The leave button has a red tint.
- Settings moves to the header of the call view.
- The share button is absent where the browser cannot share the screen.
- The whole tile is the tap target. A tap opens a sheet with volume, mute for me, and show large. A double-tap on a video also shows it large.

### Text size on the phone (135-4)

On the phone, small text uses the existing dim text level.
The muted level is for decoration only.
The reason is a measurement: the muted colour on the default theme has a contrast of about 3:1.
No theme token changes.

### Not adopted

The call header has no "end-to-end encrypted" line.
No claim about voice security goes on screen before `docs/threat-model.md` is checked for it.

## What was rejected

- A bottom tab bar. One list is enough.
- A top call banner. The bottom is in thumb reach.
- A service worker in this phase. It stays in phase 65.
- A Navigation API branch. `pushState` and `popstate` are enough, and a second branch doubles the paths to test.
- An adaptation of `VoiceCallPanel` for the phone. It is the desktop stage.
- A migration for `viewMode`. The server stores preferences as opaque JSON, and no Go code reads `viewMode`.

## Slices

- **135-1 — the list is the phone layout.** Built 2026-11-13.
  `zuckerActive` in `App.tsx` is `isMobile`.
  Removed: the `roster.viewMode` preference, the Zuckermode check box in settings, and its search keyword.
  Also removed: the phone drawer (menu button, backdrop, drawer head, and the `navOpen` state) and its CSS.
  On a phone, `.chalk-sidebar` was `display: none` but stayed mounted, because the `VoiceDock` inside it held the audio elements of a call. 135-2 changed this.
  The next roster write from a new client drops a stored `viewMode` key.
  A tab that has not reloaded can show the old drawer until the update banner reloads it.
  Tests: `web/src/chat/zucker.test.ts` (a stored `viewMode` is dropped), `web/src/theme-zucker.test.ts` (no drawer rules). 135-2 removed the assertion that the phone block hides the sidebar.
  Also `test/e2e/mobile.spec.ts` (the list is home, a row opens the chat, back returns). The spec file is not executed. Its header says why.
  The probes under `.claude/skills/run-chalk/` moved from the drawer to the chat list: `driver.mjs`, `readme-shots.mjs`, `thread-refresh.mjs`, `unread-landing.mjs`, `reentry-landing.mjs`, and `ui-sweep.mjs`.
  The `--phone` shot of `ui-sweep.mjs` is now `phone-list.png`.
  A new `toPhone` helper opens a row after each resize, because a resize to phone width lands on the list.
- **135-2 — audio sinks leave the sidebar.** Built 2026-11-13.
  The component `VoiceDock` is now `VoiceSinks`. The file keeps the name `VoiceDock.tsx`, because `useVoiceSession` and `useVoiceRoom` are imported from it in several places.
  `VoiceSinks` keeps these parts:
  the remote audio sinks, the program-audio sinks of a screen share, the Ctrl/Cmd+Shift+V jump shortcut, the pop-out cleanup, and the autoplay resume listener.
  The pop-out cleanup runs when the call ends.
  Removed from it: the `bar` prop, the duration ticker, and the `CtlLabel` helper.
  Also removed: the connection bar markup (room button, duration, live dot, leave, the sharing row with stop, and the autoplay nudge row).
  The bar could go. Since 131-7 it rendered only on the phone, and since 135-1 the phone hides the sidebar that held it.
  On desktop the call rail has the duration, the controls, and leave.
  On the phone `ZuckerCallBar` has the room, the duration, the nudge, and leave until 135-5 replaces it.
  `App.tsx` mounts `<VoiceSinks key="voice-sinks">` once, as the first child of the `.chalk-app` element, before the header, at a position that does not depend on `isMobile`.
  The position matters. A remount creates new `<audio>` elements in the middle of a call, and a rotated phone can cross the 767 px breakpoint.
  The `AdminPanel` early return still unmounts the sinks, as before.
  The `<aside class="chalk-sidebar">` (the `Sidebar` and the `SidebarResizer`) renders only when `!isMobile`, so the phone no longer mounts `Sidebar`.
  `web/src/theme.css` lost these rules:
  the phone rule `.chalk-sidebar { display: none }` and its comment, the phone `.chalk-sidebar-item` rule with its heading, and the `.chalk-voice-ctl-mini` and `.chalk-voice-ctl-wide` rules (only `CtlLabel` used them).
  It also lost the reduced-motion rule for the sidebar transition. The transition was the drawer's.
  The `.chalk-voice-dock*` rules stay, because `ZuckerCallBar` still uses them until 135-5.
  Tests: the new `web/src/components/voice-sinks-mount.test.ts` reads the `App.tsx` source.
  It asserts one `<VoiceSinks`, before the header, as a direct child of the `.chalk-app` element, with no `isMobile` or `zucker` between it and the header.
  It also asserts the aside behind `!isMobile` and no `<VoiceDock`.
  The 135-1 test in `web/src/theme-zucker.test.ts` now asserts only that the drawer rules are absent.
  There is no user-visible change, so there is no changelog entry.
- **135-3 — back button and back gesture.** Planned.
  Each layer (list, chat, thread or panel) is one history entry. The URL does not change. State follows history, and the `popstate` handler never calls `pushState`.
  New files: `web/src/nav/phone-stack.ts` (pure functions) and `web/src/nav/use-phone-history.ts`.
  `ZuckerList` stays mounted in its own scroller, so the list keeps its scroll position and filter.
- **135-4 — shell: keyboard, overscroll, tap targets.** Planned.
  The viewport meta gets `interactive-widget=resizes-content`. `viewport.ts` measures again on `focusout` and `orientationchange`.
  The phone block sets `overscroll-behavior: none` and `overflow: hidden` on `html, body`, so the browser has no pull-to-refresh.
  The header, the list head, the back button, and the composer tools get a 44 px floor.
  The text rule above applies here.
- **135-5 — phone call bar and call view.** Planned.
  New `PhoneCallBar.tsx` and `PhoneCallSheet.tsx`, and a pure `web/src/voice/phone-call.ts`.
  `ZuckerCallBar.tsx`, the footer `VoiceControls`, and their CSS go. `VoiceCallPanel` is desktop only.
  The call view has no board, no pop-outs, no layout toggle, and no debug drawer.
  The layout and the navigation rules are above.
- **135-6 — resume from the background.** Planned.
  A 5 s connect timeout and a public `nudge()` in `ws-client.ts`, called on `visibilitychange` to visible, on `pageshow` with `persisted`, and on `online`.
  A `ping` case in `internal/server/ws.go` acknowledges the ref.
- **135-7 — call hygiene.** Planned.
  A screen wake lock during a call, media session actions, and a camera flip through `facing` in `DevicePrefs`.
  A one-line notice on iOS says that the call pauses in the background.
- **135-8 — row menu on the phone list.** Planned.
  A long-press bottom sheet on list rows with hide, group, rename, and order, reusing the sidebar handlers.

## Verification of 135-1

- `driver.mjs --mobile --friend` passed on a fresh account. The list is the home screen with no toggle. The account added a friend, created a channel, opened a row, and sent a message.
- A four-person call probe at 390x664 showed the call bar on the phone. The computed style of the sidebar was `display: none`. All three remote audio elements played with live tracks.
- Only `driver.mjs` ran of the changed probes. The other five were checked for syntax only.

## Verification of 135-2

- The client chain passed: `npx tsc --noEmit`, `node test.mjs` (1834 pass, 0 fail), and `node build.mjs`. The Go chain did not change.
- Live probe: four people in a call, Playwright with iPhone 14 touch emulation. The viewport went 1280, 390, 1280, 390 px during the call. All six audio elements stayed (three remote voices and their three muted raw elements), and none was created.
  The three remote voices kept playing with live tracks.
- `aside.chalk-sidebar` count was 1 on desktop and 0 on the phone.
- Desktop screenshots show the rail, the sidebar, and the stage unchanged.

## Known loss

The phone list has no row menu.
Hide, group, rename, manual order, and the nick colour of a friend are not reachable on a phone until 135-8.
The same loss is in `docs/open-items.md`.

## Left open

- The phone has no call view until 135-5.

## Manual checklist

- [ ] A phone, first load after the update. The list is home, with no menu button. Open a row, then go back.
- [ ] A tab open before the update. After the update banner reloads it, the old drawer is gone.
- [ ] A call on a real iPhone and a real Android phone. The call bar shows on the list and on a chat, and the audio plays.
- [ ] Resize a desktop window across 767 px during a call. The audio does not stop. The 135-2 probe did this with emulation. A real window and a real phone are still open.
- [ ] 135-7: an interrupted call, such as an incoming phone call.
- [ ] 135-7: an audio route change, such as a headset plugged in or removed.
- [ ] 135-7: recovery after the user denies and then allows the microphone permission.
