# Phase 135 — phone: the chat list is the phone layout, with a call bar and a call view

**Status:** in progress. 135-1 and 135-2 are built (2026-11-13). 135-3 and 135-4 are built (2026-11-14), and their device checks are open. 135-5 to 135-8 are planned and have no code.
**Tags:** `#zucker`, `#mobile`, `#roster`, `#themes`, `#voice` → `tools/where.sh -g zucker`

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
No theme token value changes.
The fix is a phone-only override, `.chalk-app { --chalk-fg-muted: var(--chalk-fg-dim); }` in the phone block of `web/src/theme.css`.
Decoration needed its own token, `--chalk-fg-deco`.
Without it, the override would also turn borders, scrollbar colour, and other lines from muted to dim.
The token is declared at `:root` as `var(--chalk-fg-muted)`.
A custom property that uses `var()` resolves where it is declared, so `--chalk-fg-deco` keeps the muted colour inside `.chalk-app`.
The `warmwhite` theme re-tints the muted colour inside the desktop sidebar, so `--chalk-fg-deco` is also declared in that block.
On desktop, `--chalk-fg-deco` equals the muted colour, so the desktop output does not change.
No component uses a portal, so every dialog and panel renders inside `.chalk-app` and gets the override. The sign-in screens render outside it and keep the muted colour.

### Not adopted

The call header has no "end-to-end encrypted" line.
No claim about voice security goes on screen before `docs/threat-model.md` is checked for it.

## What was rejected

- A bottom tab bar. One list is enough.
- A top call banner. The bottom is in thumb reach.
- A service worker in this phase. It stays in phase 65.
- A Navigation API branch. `pushState` and `popstate` are enough, and a second branch doubles the paths to test.
- Restoring the open chat after a reload (135-3). The channels load asynchronously, so a restore would wait for them. A reload lands on the list, as before.
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
- **135-3 — back button and back gesture.** Built 2026-11-14.
  Each layer (list, chat, thread, panel) is one history entry with the same URL.
  New files: `web/src/nav/phone-stack.ts` (pure functions, tested in `phone-stack.test.ts`) and `web/src/nav/use-phone-history.ts`.
  The pure functions are:
  `stackDepth` (the list is 1, and the chat, the thread, and the panel each add one),
  `historyDepth` (reads `history.state.chalkDepth`, and an invalid value counts as 1),
  `hasDepth`,
  `popSteps` (closes the panel first, then the thread, then the chat),
  and `reconcile` (push n entries or go back n).
  Design, in both directions:
  - State follows history. After a `popstate`, the hook calls `onPop` with the steps that close layers. In `App.tsx`, `onPop` dispatches `close_panel` or `close_thread`, or calls `backToList`, which also un-parks.
  - History follows state. When the app opens a layer, the hook pushes entries. When the app closes a layer (the back button in the app, the swipe, or a close X), the hook calls `history.go(-n)`.
  - If the browser lands deeper than the state, the hook goes back again.
  - Each entry stores its depth in `history.state.chalkDepth`. The hook stamps depth 1 on an entry that has none.
  - A `pending` flag covers the time between the hook's own `history.go()` and the `popstate` for it. In that time the hook makes no push and no second `go()`.
  - The hook is on only on the phone, on the chat route, with a signed-in user. On desktop, channel clicks add no history entries.
  Admin: opening the admin page pushes `{ chalkDepth: <current>, admin: true }` at `/admin`, so it is not a layer.
  "Back to chat" calls `history.back()` when the current entry is the admin entry. Otherwise it calls `replaceState` to `/`. Before 135-3, it pushed a new `/` entry, so a later back opened the admin page again.
  Reload: a reload in a chat lands on the list, as before. The history goes back to the entry of depth 1, so the next back leaves the app.
  The list: `App.tsx` keeps `ZuckerList` mounted in `<div class="chalk-phone-list" hidden=...>` while a chat shows. Before, the chat replaced the list.
  The list gets the seasonal scene row only while it shows, so a hidden list never uses up a scene visit.
  `ZuckerList` has a new `shown` prop. It saves the scroll offset of its rows on scroll and restores it when it shows again, because a hidden element loses its scroll offset.
  The filter and the open friends, voice, and hidden sections now survive a visit to a chat.
  `web/src/theme.css` has a new `.chalk-phone-list` rule in the phone block.
  `test/e2e/mobile.spec.ts` now asserts that the list is hidden, and not absent, after a row opens the chat. The spec file is not executed.
  Both landing probes now have a handler that closes the "what's new" note when it opens. The note opened over the list at an unknown time after sign-in and blocked the first tap.
  `unread-landing.mjs` also has a handler for the avatar nudge. `reentry-landing.mjs` closes the nudge itself.
- **135-4 — shell: keyboard, overscroll, tap targets.** Built 2026-11-14.
  The viewport meta in `web/index.html` has `interactive-widget=resizes-content`.
  Chromium browsers (Chrome, and Brave on Android) then shrink the layout when the on-screen keyboard opens.
  iOS Safari does not apply it yet. Research found support only in an iOS 27.3 beta, and `resizes-content` was reported as not working there.
  iOS keeps the `visualViewport` path of 125-1 in `web/src/viewport.ts`.
  125-1 rejected this meta value, because iOS ignored it. 135-4 adds it for Chromium and keeps the 125-1 path for iOS.
  `useKeyboardSafeShell` also measures again on `focusout` and `orientationchange`.
  Some iOS versions send no `visualViewport` event when the keyboard closes, and the shell stayed short.
  The phone block of `web/src/theme.css` sets `overflow: hidden` and `overscroll-behavior: none` on `html, body`.
  The document never scrolls on a phone. Only the panes inside the shell scroll. The browser has no page to pull down, so it does not start pull-to-refresh.
  Contrast: the new token `--chalk-fg-deco` and the phone override are described in the text-size design note above.
  23 decoration rules read `var(--chalk-fg-deco)` now. They are borders, border colours, two backgrounds, the scrollbar colour, a text-decoration colour, and `--voice-on-video-line`.
  On the default theme, message timestamps render `#74b08a` on the phone. The muted colour is `#3c6b52`.
  Tap targets of 44 px:
  the phone composer tools (were 34 px, icons and text labels),
  the rail `min-width` (was 72 px, now `calc(2 * 44px + var(--chalk-s1))`),
  the modal close button (was 32 px),
  and the min-height of the back button of the list (was 34 px).
  A new phone block at the end of `web/src/theme.css` gives 44 px to these controls:
  the header presence button, the user menu, the channel header search button, the mode badge, the encryption indicator, and `.chalk-button`.
  It is last in the file, so no earlier rule of the same weight resets a size.
  Tests: the new `web/src/theme-phone.test.ts` checks the meta, the phone `html, body` rule, and the controls of the last phone block.
  It also checks the token, and that no decoration rule reads the muted colour directly.
  `web/src/theme-composer.test.ts` now expects 44 px phone tools.
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

## Verification of 135-3

Live probe: Playwright with iPhone 14 touch emulation, 390x664, fourteen channels. 10 of 10 checks passed:

- The list is at depth 1.
- A row opens the chat at depth 2.
- The system back returns to the list.
- The list keeps its scroll offset (374 px before and after).
- A search panel over the chat is at depth 3.
- Back closes the panel and keeps the chat.
- A second back returns to the list.
- The back button in the app leaves the history at depth 1.
- A reload in a chat lands on the list at depth 1, and the next back leaves the app.
- On desktop, channel clicks add no history entries.

The landing probes ran one after the other on the 135-3 build:

- `reentry-landing.mjs` reported 5 of 5 entries landed at the bottom.
- `unread-landing.mjs` reported OK for all three alpha entries (first entry, re-entry, and third entry). Each landed 0 px from the bottom with the newest message visible. The first entry showed the unread divider.

The two probes share `/tmp/chalk-probe/` and clear it at the start, so they must run one after the other.

Not verified: a real Android back button, Android predictive back, and the iOS edge swipe in an installed app.
Chrome can skip history entries that a page adds without a user gesture. Every push in 135-3 follows a tap, but this was not tested on a device.

## Verification of 135-4

The full client chain passed, with 1843 client tests.
Live probe: Playwright with iPhone 14 touch emulation, 390x664.
Before the change, these visible controls were under 44 px:

- The header presence button, 72x19.
- The user menu, 130x27.
- The back arrow, 44x34.
- The channel search, 60x19.
- The mode badge and the encryption indicator, 14x14 each.
- The three composer tools, 34x34 each.
- The dialog close button and dialog buttons, 32 to 34 tall.

After the change, the probe found none on the list or in a chat.
The document reports `overflow: hidden` and `overscroll-behavior-y: none`.

Not measured: only the list, a chat, the composer, and one dialog. The settings panel, the friends panel, and other panels are not measured for 44 px.
Not verified on a device:

- The keyboard on Android Chrome and Brave with the new meta. Look for a double resize, where the browser shrinks the layout and `viewport.ts` also shrinks the shell.
- The iOS keyboard close with the `focusout` and `orientationchange` measurement.
- Pull-to-refresh. It is not tested on Android Chrome or in an installed iOS app.

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
- [ ] 135-3: a real Android phone. The back button closes a panel, then a thread, then returns from a chat to the list, then leaves chalk.
- [ ] 135-3: Android with predictive back turned on. The same sequence works.
- [ ] 135-3: an iPhone with chalk installed to the home screen. The edge swipe closes the same layers.
- [ ] 135-3: on a device, the pushed entries stay in the history. Chrome can skip entries that a page adds without a user gesture.
- [ ] 135-3: open the admin page and return with "back to chat". Then press back. The admin page does not open again.
- [ ] 135-4: Android Chrome and Brave. Tap the composer. The message box stays above the keyboard, with no double resize and no gap. Close the keyboard. The shell returns to full height.
- [ ] 135-4: an iPhone. Close the keyboard with a tap outside the field, with the return key, and by rotating. The shell returns to full height each time.
- [ ] 135-4: pull down on a list and on a chat, on Android Chrome and in an installed iOS app. chalk does not reload.
- [ ] 135-4: the settings panel, the friends panel, and the other panels. No visible control is under 44 px.
- [ ] 135-7: an interrupted call, such as an incoming phone call.
- [ ] 135-7: an audio route change, such as a headset plugged in or removed.
- [ ] 135-7: recovery after the user denies and then allows the microphone permission.
