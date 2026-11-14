# Phase 135 — phone: the chat list is the phone layout, with a call bar and a call view

**Status:** built in code. All eight slices are built. 135-1 and 135-2 are built (2026-11-13). 135-3 to 135-8 are built (2026-11-14). The owner chose to build 135-6 after 135-7. The device checks of 135-3 to 135-8 are open, in the manual checklist.
**Tags:** `#zucker`, `#mobile`, `#roster`, `#themes`, `#voice`, `#websocket` → `tools/where.sh -g zucker`

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

- A tap on a voice room in the list opens the call view over the list. A text room opens its chat.
- A tap on the call bar opens the call view over the current screen. The screen does not change, so back returns to it.
- The chat button in the call view opens the chat of the room and closes the view.
- A tap on a room the user is already in opens the call view. It does not join a second time.
- On the phone, a selection does not join. The join button in the call view joins. Desktop still joins on a selection.
- A swipe down on the head (past 90 px), the arrow, or the back gesture closes the call view.
- Only the leave button ends the call. A leave also closes the view of the room that the user left.
- A move takes 160 ms.

### Design decisions of 135-5

- The call view is an overlay with its own history layer. Back closes it and returns to the screen under it, whether that screen is the list or a chat.
- The phone has a join screen and no auto-join. A tap on a voice room opens the view, and the join button joins.
- On the phone, the page of a voice room is its chat. A "call" button in its header opens the view.
- The new CSS block sits above the seasonal section. The seasonal and flair tests expect their own reduced-motion block to be the last in their section.

### Call view layout (135-5)

- In an audio call (no camera on), each person has a compact card with a name, a picture, and a level meter. Eight cards fit without a scroll.
- When another person has a camera on, video takes the room: up to four videos on the stage, and everybody else in a strip. The user's own camera is a corner preview. The user's own camera alone does not switch the view to video. The user's own screen share is not shown back to the user.
- The speaker has a thin moving border and three level bars. With reduced motion, nothing moves.
- The controls are rounded-square buttons: mute, deafen, camera, share, and leave. A muted button has an amber tint. The leave button has a red tint.
- Settings moves to the header of the call view.
- The share button is absent where the browser cannot share the screen.
- The whole tile is the tap target. A tap opens a sheet with volume (0 to 200 %), mute for me, and show large for a video. A double tap on a video also shows it large. A video waits 280 ms for a second tap before it opens the sheet.
- Before the user joins, the view shows:
  - Who is here.
  - The join button.
  - A note when the user is in another room.
  - The key wait.
  - The join error.
- The footer has a chat button with an unread dot, and the controls.

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

### Design decisions of 135-6

- The liveness check is a `ping` frame of the chalk protocol, answered with `pong`. A browser cannot see the WebSocket protocol ping, so the page cannot tell a dead socket from a quiet one without its own frame.
- Any answer with the ref of the ping proves the socket. A `pong` counts. An `error` frame with the ref also counts, because a server that does not know `ping` answers with one. A guest gets this `error` frame, because `ping` is not on the guest allowlist in `guest_ws.go`. The guest fence test passes unchanged.
- The client does not wait for the close event of a silent socket. A frozen socket can fail to fire it. `abandon` detaches the handlers, closes the socket with code 4000, and dials at once.
- A socket that answers the ping missed nothing, so it is kept. The catch-up is the existing resync on a fresh welcome.
- The handlers run on desktop too. A laptop that wakes from sleep has the same problem.
- The connect timeout is 5 s, because iOS can leave a new WebSocket in CONNECTING after a resume (WebKit bug 308073).

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
  On the phone `ZuckerCallBar` had the room, the duration, the nudge, and leave until 135-5 replaced it.
  `App.tsx` mounts `<VoiceSinks key="voice-sinks">` once, as the first child of the `.chalk-app` element, before the header, at a position that does not depend on `isMobile`.
  The position matters. A remount creates new `<audio>` elements in the middle of a call, and a rotated phone can cross the 767 px breakpoint.
  The `AdminPanel` early return still unmounts the sinks, as before.
  The `<aside class="chalk-sidebar">` (the `Sidebar` and the `SidebarResizer`) renders only when `!isMobile`, so the phone no longer mounts `Sidebar`.
  `web/src/theme.css` lost these rules:
  the phone rule `.chalk-sidebar { display: none }` and its comment, the phone `.chalk-sidebar-item` rule with its heading, and the `.chalk-voice-ctl-mini` and `.chalk-voice-ctl-wide` rules (only `CtlLabel` used them).
  It also lost the reduced-motion rule for the sidebar transition. The transition was the drawer's.
  The `.chalk-voice-dock*` rules stayed, because `ZuckerCallBar` still used them. 135-5 removed them.
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
- **135-5 — phone call bar and call view.** Built 2026-11-14.
  New files: `web/src/voice/phone-call.ts` (pure, tested in `phone-call.test.ts`), `web/src/components/PhoneCallBar.tsx`, and `web/src/components/PhoneCallSheet.tsx`.
  The pure functions are:
  `callLayout` (audio mode: one card for each tile. Video mode: up to four videos of other people on the stage, everybody else in a strip, the own camera in the corner. The own screen share is not shown. The own camera alone does not switch to video. A "show large" key puts one video alone on the stage),
  `stageGrid`,
  `cardColumns` (one column up to two people),
  `barLine` (the second line of the bar. In order: the sound nudge, "joining…", the people who speak, "you are muted", "in the call"),
  and `canShareScreen` (needs `getDisplayMedia`, which iOS Safari does not have).
  `PhoneCallBar` shows above the composer on every phone screen except the call view, while the user is in a call or joining one.
  It has the room name and duration, the bar line, a level meter, mute, and leave. A tap on the room opens the call view.
  `PhoneCallSheet` is a full-screen layer (`position: fixed`, `z-index` 60, below dialogs at 100).
  Its head has the arrow down (close), the room name, the duration, and settings.
  Before the user joins, it shows who is here and the join button.
  It also shows a note when the user is in another room, the key wait, and the join error (`describeJoinError`, now exported from `VoiceCallPanel.tsx`).
  In the call it shows audio cards or the video layout. The foot has the chat button with an unread dot, and the controls: mute, deafen, camera, share (only where the browser can share), and leave.
  A drag down on the head past 90 px closes the view.
  `web/src/nav/phone-stack.ts` has a new layer `call` and a new step `close-call`. The call layer is above a thread and below a panel.
  `App.tsx` has a `callView` state, the room whose view is open.
  A tap on a voice room in the list sets the room active and opens the view over the list.
  The selection loads the room key for the join button.
  The bar opens the view over the current screen without a change of screen.
  On the phone, the auto-join on a selection is off. Desktop keeps it.
  On the phone, a voice room's page is its chat. It has no `VoiceCallPanel` and no `chalk-main--voice` class, and its header has a "call" button that opens the view.
  `VoiceCallPanel` renders on desktop only.
  Removed: `ZuckerCallBar.tsx`, the footer voice control band, and the `VoiceControls` component. `VoiceControls.tsx` keeps the icons and `toggleCamOrEnable`.
  Removed CSS: `.chalk-voice-dock*` with its container query, `.chalk-voice-controls*`, `.chalk-voice-ctlbtn`, `.chalk-voice-live`, `.chalk-zucker-callbar*`, and `.chalk-footer-left`. The two `.chalk-call-rail-btn` rules are one rule now.
  The new CSS block "135-5" sits above the seasonal section.
  The seasonal and flair tests expect their own reduced-motion block to be the last in their section, so a block after them breaks those tests.
  Tests: `web/src/voice/phone-call.test.ts`, `web/src/theme-phone-call.test.ts` (bar and button sizes, the fixed layer, control colors, reduced motion, the removed surfaces), and the call layer cases in `web/src/nav/phone-stack.test.ts`.
  `theme-sidebar.test.ts` and `theme-zucker.test.ts` changed for the removed classes. The call bar margin test of 126-2 is gone with the bar.
  The call view has no board, no pop-outs, no layout toggle, and no debug drawer.
  The layout and the navigation rules are above.
- **135-6 — resume from the background.** Built 2026-11-14, after 135-7 (the owner's choice).
  When the page shows again, the client reconnects at once or checks the open socket with a ping. It then catches up through the resync of a fresh welcome.
  Server: `internal/proto/frames.go` has `TypePing` and `TypePong`. In `internal/server/ws.go`, the read loop answers `ping` with `pong` and the same ref (`pongFrame`, `sendPong`). A `pong` has no payload.
  Client: `proto.ts` has the two names. The new `web/src/resume.ts` has `resumeAction({ state, stopped, reconnectPending })`, which returns `none`, `reconnect-now`, `probe`, or `wait`.
  `ws-client.ts` has a 5 s connect timeout: a dial with no welcome after 5 s is given up and dialed again at once.
  It has a public `nudge()`. If a reconnect waits on its backoff timer, `nudge()` dials now and resets the backoff. If the socket is open, it sends a ping, and it gives the socket up when no answer with the ref comes within 3 s. A second `nudge()` while a ping waits sends no second ping.
  The private `abandon(reason)` detaches the handlers, closes the socket with code 4000, sets the state to closed, resets the backoff, and dials at once. The connect timer is cleared on welcome, on close, and on `stop()`.
  `App.tsx` has one effect that calls `nudge()` on `visibilitychange` to visible, on `pageshow` with `persisted`, and on `online`.
  Not built from the plan: a new header element, because the header status already shows the connection state.
  Also not built: detection of a frozen page by timer drift.
  Also not built: an HTTP catch-up fallback, or a forced reload for the stuck iOS socket beyond the connect timeout.
  Tests: new `web/src/resume.test.ts` and new `internal/server/ping_test.go`.
  Seven new cases in `web/src/ws-client.test.ts` cover the connect timeout and a welcome that clears it.
  They also cover `nudge()` that skips the backoff, a ping answered by pong, an error answer, no answer in 3 s, and no second ping.
  The fake `clearTimeout` in that file now removes the timer from the list, so the older tests count only live timers.
- **135-7 — call hygiene.** Built 2026-11-14, before 135-6 (the owner's choice).
  The phone keeps the screen on during a call, shows the call on the lock screen, and flips between the front and the back camera.
  A one-line note on an iPhone or an iPad says that the call pauses in the background.
  Everything here runs on the phone only. App.tsx installs the wake lock and the media session when `zuckerActive` is true, next to `installVoiceHotkeys`. The desktop does not change.
  Wake lock: `web/src/voice/wake-lock.ts`. `wantWakeLock(inCall, visible)` is true only in a call with a visible page. `installWakeLock(session, nav, doc)` asks for a screen wake lock in that case.
  The browser releases the lock when the page hides, so it asks again when the page shows. It releases the lock when the call ends. Where `navigator.wakeLock` is absent, it does nothing.
  Research: Chromium has the API. Installed web apps on iOS have it since 18.4.
  Lock screen: `web/src/voice/media-session.ts`. `mediaSessionPlan` computes the title `chalk · <room>` and the state of the microphone and the camera. `installMediaSession(session, mediaSession, MediaMetadata, actions)` sets the metadata, the two states, and the `togglemicrophone`, `togglecamera`, and `hangup` handlers while in a call. It clears them when the call ends.
  Each call is in its own try block, because support differs. Chromium 93 has the microphone and camera actions, and so has iOS 18.4. The `hangup` action is not on iOS.
  Camera flip: `facing` (`""`, `"user"`, or `"environment"`) is a new field of `DevicePrefs` in `device-prefs.ts`. `normalizeDevicePrefs` turns any other stored value into `""`.
  `cameraConstraints` returns `{ facingMode }` when `facing` is set. `facing` wins over `cameraId`. It is a plain hint and not `exact`, so a phone without that camera uses the one it has.
  `flippedFacing` returns the other camera. With no facing chosen, the flip goes to the back. `cameraChanged` compares `cameraId` and `facing`.
  The camera picker in `MicSettings.tsx` clears `facing` when the user picks a camera. The flip button clears `cameraId` and sets `facing`.
  `call.ts` recaptures when `cameraChanged` is true. For a change of `facing`, it asks the camera chain to stop the old camera first.
  `CameraChain.recapture(prefs, stopFirst?)` in `camera-chain.ts` has a stop-first path, because many phones cannot open both cameras at the same time. If the new camera fails, the old camera opens again and the error goes on to the caller. The new private `adopt` holds the tail that both paths share.
  The call view (`PhoneCallSheet.tsx`) has a "flip" button beside "chat" while the user's camera is on. The back camera is not mirrored.
  In the call on an iPhone or an iPad, the view shows the note "the call pauses while chalk is in the background". `isAppleMobile` in `phone-call.ts` decides. An iPad reports a Mac platform, so a Mac with touch points counts too. The style is `.chalk-pcall-ios` in `theme.css`.
  Tests: new `wake-lock.test.ts` and `media-session.test.ts`, with fakes for the browser APIs. New cases in `device-prefs.test.ts` (facing, `flippedFacing`, `cameraChanged`, the facing constraint) and in `phone-call.test.ts` (`isAppleMobile`).
- **135-8 — row menu on the phone list.** Built 2026-11-14.
  A long press on a list row, or a right-click, opens a bottom sheet for that row. A tap still opens the conversation.
  `long-press.ts` holds `LONG_PRESS_MS` (500), `LONG_PRESS_SLOP_PX` (10), and the pure `pressMoved`. A press held 500 ms without a move of more than 10 px opens the sheet.
  `ZuckerList.tsx` has the new prop `onRowMenu`. A `fired` flag stops the click that ends a long press from also opening the conversation. The `contextmenu` event opens the sheet and cancels the browser menu.
  In `theme.css` the list row has `user-select: none` and `-webkit-touch-callout: none`, so a press does not select text or raise the browser callout.
  `PhoneRowSheet.tsx` is the sheet. It has:
  - Notifications: `PrioritySelect`, with the same notification rules as the sidebar.
  - "hide until a new message" and "hide". For a hidden row, the sheet has "show in the list again" in place of both.
  - Group, for text channels only. It is a text field with the known groups, and a reset when the group is overridden.
  - Name and short name, for the owner of a non-DM channel that is not in democratic mode. The server enforces the same rule.
  The CSS is `.chalk-prow-*` in the 135-5 block. The sheet reuses the sheet rows of the call view. It does not move with reduced motion.
  `channel-groups.ts` has the new pure `groupDraftChange`. It returns what a typed group name changes. If the name is the suggestion of the creator again, it clears the override. Otherwise it sets the canonical name, or changes nothing. The sidebar group commit uses it, and its behavior does not change.
  In `App.tsx` the group, rename, and hide handlers moved out of the sidebar props into the named functions `setChannelGroupPref`, `updateChannelMeta`, and `setChannelHiddenPref`. The sidebar and the phone sheet both call them.
  The sheet is a history layer. `menu` in `phone-stack.ts` is closed first, by the step `close-menu`, so the back gesture closes the sheet.
  Tests: new `long-press.test.ts`. Two new tests in `channel-groups.test.ts`. A menu layer in `phone-stack.test.ts`. `theme-phone-call.test.ts` checks that reduced motion includes the row sheet.

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

## Verification of 135-5

Live probe: Playwright with iPhone 14 touch emulation, 390x664. The phone user was in a room with three desktop users. 14 of 14 checks passed:

- There is no bar before a call.
- A tap on the room opens the join screen at history depth 2, with no join.
- Join shows four audio cards.
- A camera turns the view to video, with one video and three chips.
- A tap on a person opens their sheet.
- Every button in the view is 44 px or more.
- Back returns to the list, and the bar shows.
- The mute button of the bar toggles.
- In a chat, the bar sits above the composer.
- The bar opens the view over the chat at depth 3, and back returns to the same chat.
- A tap on the room the user is in opens the call, not the join screen.
- The chat button opens the room chat with the composer and the bar.
- Leave ends the call and closes the view.

The probe found one layout bug and the change fixes it. Card names sat in the middle of the card, over the picture, because a button centres its content.

Not verified:

- The drag-down close and the double tap. They are pointer gestures, and the probe did not drive them.
- Real devices.
- Screen share on an Android phone.
- Eight audio cards without a scroll (the probe had four).
- The `ui-sweep.mjs` probe with `--phone`. Its voice shots now land in the call view and not in the old room page. Its step that clicks `voice-cam` finds nothing. That step was already inside a catch.

## Verification of 135-7

The full client chain passed, with 1868 client tests.
Live probe: Playwright with iPhone 14 emulation, a fake camera, and three desktop users. 8 of 8 checks passed:

- The metadata title of the lock screen is `chalk · lounge` in the call.
- The iPhone note shows.
- There is no flip button while the camera is off.
- The flip button shows while the camera is on.
- A flip stores `facing` as `environment`, and the camera stays on with a live track and no error.
- The back camera is not mirrored.
- A second flip stores `user`.
- After leave, the metadata is null.

The probe did not observe the wake lock. The browser was headless Chromium, where `navigator.wakeLock` exists. Only the unit tests cover the wake lock.

Not verified on a device:

- That the screen stays on.
- The lock-screen buttons on Android and on iOS.
- That a real phone flips without a black frame or a failure.
- The wake lock in an installed iOS 18.4 app.

## Verification of 135-6

The full chain passed, with 1876 client tests.
Live probe: Playwright with iPhone 14 emulation and a second user. The socket of the phone user ran through a switch that can drop all frames in both directions while the socket stays open. 5 of 5 checks passed:

- The socket is open.
- A resume with a live socket gets the `pong` and keeps the socket. No new dial starts in 4 s.
- A silenced socket misses a message from the other user.
- A resume gives the silent socket up and dials once.
- The missed message shows 3328 ms after the resume. The limit in the probe was 8 s.

Not verified on a device:

- A real iPhone or Android phone that returns from the background.
- An installed iOS app with WebKit bug 308073.
- A laptop that wakes from sleep.

### Design decisions of 135-8

- The gesture is a long press, with a right-click as the second way in. Both open the same sheet. A plain tap is unchanged.
- The sheet calls the handlers of the sidebar. A group, a hide, or a rename on the phone is the same setting as on the desktop. The server rules do not change.
- The sheet is a history layer, so the back button and the back gesture close it, as for every other layer.
- Group is in the sheet, although the phone list shows no groups. It is the same synced setting, and it files the channel in the sidebar on a desktop.
- The order within a group is not in the sheet. The phone list sorts by newest activity and shows no groups, so an order has no effect there.
- The channel header image is not in the sheet. Its editor is a desktop dialog.
- The nick colour of a friend is not on the phone. It is in the friend-row menu of the sidebar.

## Verification of 135-8

The full chain passed, with 1880 client tests.
Live probe: Playwright with iPhone 14 emulation and a mouse long press. 10 of 10 checks passed:

- A long press opens the sheet and not the chat, at history depth 2.
- The owner sees the rename and group fields.
- Back closes the sheet.
- Hide moves the row to the hidden shelf.
- A hidden row offers "show in the list again".
- Show puts the row back.
- A rename shows in the list.
- A right-click opens the sheet.
- A plain tap still opens the chat.
- The group set on the phone shows in the sidebar on the desktop.

Not verified on a device: a real finger long press on iOS and on Android. The probe used a mouse press. Touch pointer events and the iOS text-selection callout behave differently on a device.

## Left open

- The 135-5, 135-6, 135-7, and 135-8 device checks are open. See the manual checklist.
- The row sheet answers the loss of hide, group, and rename that 135-1 caused. Three things are still not on the phone: the order within a group, the channel header image, and the nick colour of a friend.
- 135-6 has no HTTP catch-up fallback and no forced reload for a stuck iOS socket beyond the connect timeout. It has no detection of a frozen page by timer drift.
- The call view has no board, no pop-outs, no layout toggle, and no debug drawer. The desktop panel keeps them.

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
- [ ] 135-5: a real iPhone and a real Android phone. Join from the call view, and the audio plays. The bar shows on the list and on a chat.
- [ ] 135-5: a drag down on the head closes the view, and a short drag does not. A double tap on a video shows it large, and a single tap opens the sheet after a short wait.
- [ ] 135-5: screen share on an Android phone. On an iPhone the share button is absent.
- [ ] 135-5: the system back, the Android back gesture, and the iOS edge swipe close the call view. Each returns to the screen under it, and the call continues.
- [ ] 135-5: eight people in a call. All cards show without a scroll.
- [ ] 135-5: on a small phone, the controls of the call view are 44 px or more. The foot clears the home indicator.
- [ ] 135-7: a call on an Android phone and on an iPhone. The screen stays on. Lock the phone and unlock it. The screen stays on again.
- [ ] 135-7: an installed iOS 18.4 app. The screen stays on during a call.
- [ ] 135-7: lock the phone in a call. On Android, the lock screen shows the call with the microphone, camera, and hang up buttons. On iOS, it shows the microphone and camera buttons. Each button works.
- [ ] 135-7: tap "flip" on a real phone. The back camera shows without a black frame or an error. A second tap returns to the front camera.
- [ ] 135-7: pick a camera in the settings after a flip. The picked camera shows, and a phone without the back camera keeps the camera it has.
- [ ] 135-7: an iPhone. The note about the background shows in the call.
- [ ] 135-7: an interrupted call, such as an incoming phone call.
- [ ] 135-7: an audio route change, such as a headset plugged in or removed.
- [ ] 135-7: recovery after the user denies and then allows the microphone permission.
- [ ] 135-6: a real iPhone and a real Android phone. Send a message from another account, put chalk in the background for a minute, and return. The message shows within a few seconds.
- [ ] 135-6: an installed iOS app, after a long time in the background. The app does not stay on a stale list. If it does, record it, because the connect timeout is the only guard for a stuck dial.
- [ ] 135-6: a laptop that wakes from sleep with chalk open. The connection state returns to open and the missed messages show.
- [ ] 135-6: switch the phone from Wi-Fi to mobile data and back. The app reconnects when the network returns.
- [ ] 135-8: a real iPhone and a real Android phone. A finger long press on a list row opens the sheet. The iOS text-selection callout does not show. A scroll that starts on a row does not open the sheet. A tap on a row still opens the chat.
- [ ] 135-8: on a device, the back gesture closes the sheet. After a hide, a group change, or a rename, the list shows the change.
