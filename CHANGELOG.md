# Changelog

What changed in chalk, in plain language — newest first. Version numbers are
the release tags: one `vX.Y.Z` tag builds both the container image and the
matching `chalkctl` binary. Day-of releases are grouped by theme rather than
listed one patch version at a time.

The engineering-level history (which slice shipped what) lives in
[docs/phase-log.md](docs/phase-log.md).

---

## Unreleased

### Fixed
- Swiping back to the conversation list on a phone could leave the screen
  stuck: the conversation slid part-way off and stopped there, showing a mostly
  blank page that swiping again did nothing to fix. It happened when something
  redrew under your finger mid-swipe — a picture finishing loading, a message
  arriving — which made the phone drop the rest of the gesture. Touching the
  screen now always brings the conversation back.

---

## v0.6.2 — 3 August 2026 — Nano markdown, shortcuts in settings, and a saner landing spot

### Added
- Messages can show italics, bold and code, if you want them to. Turn on nano
  markdown in settings under chat, and asterisks and backticks in the messages
  you receive render as emphasis and fixed-width code instead of showing as
  characters. It is your setting and nobody else's: what you type is never
  touched — the composer doesn't rewrite anything and doesn't preview anything
  — and the people you write to see the plain characters unless they have
  turned it on for themselves. Three markers and nothing more: no headings,
  lists, quotes or link syntax. Copying a message still gives you exactly what
  was typed.

### Changed
- The keyboard shortcuts are in settings now, under chat → keyboard shortcuts,
  instead of behind a "?" beside the send button. The composer was running out
  of room on a phone, and a cheat sheet is something you read once rather than
  a button you need next to what you're typing.
- Opening a conversation with a handful of new messages puts you at the newest
  one, with the "new messages" line still on screen above it. Before, any
  unread message at all parked you at that line with the newest message hidden
  below the fold — which on a phone happened nearly every time you came back
  from the conversation list. A run of new messages taller than the screen
  still lands you at the line, where you would otherwise have to scroll up to
  find what you missed.

### Fixed
- Swiping back to the conversation list works when your finger starts on a
  code block. A code card scrolls sideways, so any touch that landed on one
  was treated as panning the snippet — even when it was already at its left
  edge with nothing to pan, which left the gesture dead over every code
  message.

## v0.6.1 — 2 August 2026 — Paste code, see who reacted, and a swipe that follows your finger

### Added
- You can now see who sent a reaction. Hover a reaction under a message and a
  card lists the people behind it; on a phone, press and hold the reaction for
  the same list. Tabbing to a reaction shows it too.
- You can share code without it falling apart. A new CODE button beside emoji,
  file and GIF opens a box to paste a snippet into; it arrives as a block that
  keeps its indentation and line breaks, stays in a fixed-width font whatever
  font you've chosen for the rest of chalk, and scrolls sideways rather than
  wrapping long lines into nonsense. You can label it with a language, write a
  message to go with it, and anyone reading can copy the whole thing back out
  with one click — without the surrounding chatter. Long snippets fold up so
  they don't bury the conversation. Searching finds text inside a pasted
  snippet, not just the message around it.

### Changed
- The keyboard-shortcuts "?" moved from the button block to sit beside the send
  button, and it's now available while you're editing a message too.
- On phones, the swipe back to your conversation list now follows your finger.
  The conversation slides with the touch and settles when you let go, instead
  of the screen changing the instant you crossed some invisible distance — and
  a swipe you think better of halfway puts everything back rather than
  navigating. A quick flick works as well as a long drag.

### Fixed
- Copying a GIF or a link-preview message now copies something useful. "copy"
  on those rows used to hand you a line of internal gibberish instead of the
  link or the text you wrote.
- Desktop notifications for a GIF or link-preview message no longer show that
  same gibberish in the banner.
- You can now swipe your way out of a thread on a phone. An open thread covers
  the whole screen, including the back button, so the small × in its corner was
  the only way out and swiping did nothing. Swiping right leaves the thread, and
  swiping again leaves the conversation. The list of active threads closes the
  same way.
- The back swipe no longer fights the browser's own. Swiping right in a
  conversation could drag the whole page sideways a short distance and snap back
  instead of going back, and which of the two gestures won was unpredictable.
- The conversation list no longer previews an out-of-date message. A row could
  keep showing the message before the newest one — including one you had just
  sent yourself — until you reloaded the page. Sending, reading history and
  receiving now all keep the list current.
- The thread list no longer loses the message text it had already shown. Rows
  went back to blank placeholder lines after the list refreshed itself, and
  once that happened they stayed blank for the rest of the session. Threads
  that appear later, or whose newest reply changes, now fill in too.
- Opening a channel with a lot of unread messages no longer throws you to the
  newest message a moment after landing. The view used to settle on the "new
  messages" line, then jump to the bottom as soon as older history filled in
  behind it — losing the place you were meant to start reading. It now stays
  on the line, and nothing but your own scrolling moves it.
- A channel you have never opened, or one you are hundreds of messages behind
  in, no longer keeps loading older pages by itself until it reaches the very
  beginning. It fills in enough history to give the first unread message some
  context above it and then stops, leaving the usual "load older messages"
  button for going further back.

---

## v0.6.0 — 2 August 2026 — Ask the server how it's doing

### Added
- Anyone running a server can now ask it how it is doing. A single command
  reports how big the database is, how much of it is being served from memory,
  how it has grown month by month, and — more usefully — the things that
  explain a server that feels slow: work left half-finished by a connection
  that walked away, tables being read from end to end because a lookup has no
  shortcut, space taken up by rows that were deleted but never cleared out.
  It reads only the running totals the database already keeps for itself, so
  it costs nothing to ask and is safe on a busy server. Adding `--sample 30s`
  watches for half a minute and reports what is happening right now rather
  than since the server started. Finding out which individual queries are
  slowest is available too, but has to be switched on when setting the server
  up, because measuring that costs a little on every query.

---

## v0.5.9 — 2 August 2026 — Take your server with you, and a maintenance page while you do

### Added
- Your server can now be backed up and moved to another machine. One command
  writes a single password-protected file holding the whole database — every
  message, channel, attachment and account — plus the one server key without
  which nobody's authenticator app would work again. On the new machine you
  set the server up as normal, so it gets its own certificates and you can see
  it working before any of your data is at stake, then point the restore at
  that file. It tells you where the backup came from and asks you to confirm
  before it writes anything, and if anything goes wrong mid-way the existing
  data is left exactly as it was. Everyone stays signed in and keeps their
  history; only passkeys need re-adding, and only if the address changed.
  Taking a backup does not interrupt anyone using the server.
- Servers can now be put into maintenance mode while work is going on. Instead
  of the browser error people used to get when the server was taken down, the
  site shows a proper "chalk is under maintenance" page, with whatever note the
  person running the server wants on it — when it will be back, for instance.
  The address keeps working throughout, so nothing has to be re-trusted or
  re-issued when it comes back, and turning it off puts everyone straight back
  into chalk.

---

## v0.5.8 — 2 August 2026 — Sounds with real chalk grain, and calls that announce themselves

### Added
- Calls now make a sound: one when you connect, one when you leave, and a
  shorter one each time somebody else joins or leaves the room you're in.
  Yours is a warm two-stroke chalk mark, theirs a single light one, and each
  pair rises on the way in and falls on the way out — so you can tell who it
  was about without looking. Like every chalk sound they are generated on the
  device, not sample files. All four are on out of the box and can be turned
  off individually under "chalk's own noises" in notification settings, where
  the play button previews them.

### Changed
- Every chalk sound now has the grain of real chalk. Where they used to be
  smooth little swishes, each one now rasps the way a stick of chalk actually
  does — a fine, irregular crumble as it drags — and opens with the light tick
  of the chalk touching down. They stay in the same warm range as before,
  well clear of the screech; they just sound like chalk on a board rather than
  like a filtered hiss.
- The marker that appears in a backgrounded tab's title when something needs
  you now travels from one end of the name to the other instead of blinking
  in place — easier to catch out of the corner of your eye in a crowded tab
  strip or a long window list. While it is travelling the unread count steps
  aside, and returns as soon as you look at the tab.

## v0.5.7 — 1 August 2026 — Four fonts, tamed scrollbars and a boss key

### Added
- Three more typefaces ship with chalk — JetBrains Mono, Fira Code and
  Cascadia Code — pickable in appearance settings alongside Hack. All three
  are ligature fonts, so arrows and comparison operators render fused. Like
  the existing font setting the choice is per device, and like Hack they come
  with chalk itself: nothing is ever fetched from a font CDN.
- Pressing F9 anywhere in chalk drops you straight onto the parking lot —
  messages, the composer and any open side panel go away in one keystroke,
  even mid-sentence. Pressing it again does not bring the conversation back;
  you return by picking a channel, so a panicked second tap can't undo the
  first. Like the voice keys, it only works while a chalk tab is in front.
- Appearance settings can hide scrollbars entirely, per device. The wheel,
  trackpad and keyboard scroll as before; the bars just stop being drawn and
  the message pane reclaims the strip they sat in.

### Changed
- Scrollbars now follow the active theme — a slim green thumb on a
  transparent track instead of the browser's grey bar — and the message pane
  keeps a small lane for it, so it no longer sits flush against the text or
  crowds the search button in the channel bar.

### Fixed
- The composer's keyboard shortcut sheet no longer renders as a narrow
  column with every description broken across several lines in Safari on
  desktop.

## v0.5.6 — 1 August 2026 — Steady settings and a pinned channel bar

### Changed
- The channel name bar now stays pinned to the top of the message pane on
  desktop while you scroll back, as it already did on phones — you always
  see which room you're reading, and the search button stays in reach.
- The voice & video settings window is organized into tabs — audio, camera,
  calls — instead of one long scroll.

### Fixed
- The profile window changed size and jumped around as you clicked through
  its tabs. Both it and the voice & video window now keep one steady frame
  whichever tab is open.
- On phones the profile window's tabs ran off the right edge and had to be
  scrolled sideways to find. Tabs now wrap into rows, all visible, with
  bigger touch targets.
- On phones there was no visible version number and no way to reach the
  changelog — the version badge next to the logo only shows on wide screens.
  The profile window now carries the version at the bottom of every tab, and
  tapping it opens the changelog, on any screen size.
- On phones, a clipped line of message text could show through the thin gap
  just below the pinned channel bar while scrolling. The gap is solid now.
- Pictures in messages older than a day showed as an empty row — just the
  sender and time, no image — when the message came from scrolling back
  through history (or was simply the latest message in a quiet channel).
  Images now load with the message no matter how old it is.

## v0.5.5 — 1 August 2026 — Tidier settings and shorter links

### Added
- The profile window has a filter box: type "volume" or "passkey" and only
  the matching settings show, whichever tab they live on. Clearing it (or
  tapping a tab) brings the tabs back.
- Long web addresses in messages now show as a compact
  `[example.com/where-it-points…]` label — the start of the address, with
  the tracking gibberish dropped — instead of filling the line. The link
  still opens the full address, hovering shows it, and right-click →
  "copy link address" still copies the real URL. Prefer raw URLs? Switch it
  off under profile → chat.

### Changed
- The profile window's settings are now grouped into five tabs — account,
  appearance, chat, notifications, media — instead of one long scroll.
- Pasting a Twitch or Amazon (amazon.at / amazon.de / amazon.com) link now
  offers a preview card, like YouTube and Steam links already did. As
  always, only the sender's chalk fetches the page, previews are opt-in,
  and you can add or remove sites yourself under profile → link previews.

### Fixed
- On iPhones, swiping back to the conversation list did nothing when the
  swipe started on a picture: the browser began dragging the picture
  instead, and a stray tap could leave you on the black full-screen image
  view with no obvious way out. Pictures no longer drag, so the swipe works
  on them like anywhere else — and the full-screen view itself now closes
  with the same swipe-right (a tap still closes it too).

## v0.5.4 — 1 August 2026 — Off stays off, and tiles you can read

### Added
- Optional latency readout on the video tiles: each person's round trip in
  milliseconds, in the corner of their tile, amber past 150 ms and red past
  300 ms — so "why do we keep talking over each other" has an answer you can
  point at. Off by default; switch it on in voice & video. The number used
  to be reachable only through the debug drawer.

### Changed
- A browser you have never used voice on now starts muted, instead of
  joining your first room with a live microphone. Voice & video has a
  "start muted on a new device" setting that follows your account, so a new
  machine, a private window or a cleared profile all behave the same way. On
  a machine you have already used, the mute button stays in charge —
  whatever you last set it to is what you join with, as before.
- "Mute for me" and the per-person volume sliders in a voice room now
  follow your account instead of living on one browser. Silence someone on
  the laptop and they stay silenced on the desktop, on a new device, and
  after a reinstall — and a change made in one place reaches a call already
  running elsewhere. The list is encrypted on your device before it is
  stored, so the server never learns who you have silenced.

### Fixed
- The controls on a video tile — "mute for me", the volume slider, the
  pop-out button — were too small to read comfortably, and on the light
  themes they were drawn in dark text on the tile's black strip, which made
  them close to invisible. They are larger now and always light against that
  strip whichever theme you use, and the volume slider has a track and handle
  worth aiming at. On the small strip tiles the button reads "mute" instead
  of "mute for me" so the words still fit.
- Joining a voice room with your camera switched off still opened the
  camera: nothing was ever sent, but the browser's camera indicator lit up
  for the whole call, which is impossible to tell apart from actually being
  on film. With the camera off it is now not opened at all, and the
  indicator stays dark. Switching the camera on during a call asks for
  camera permission at that moment the first time, and takes a second to
  reach the others.

## v0.5.3 — 1 August 2026 — Honest unread and a wider back swipe

### Fixed
- The swipe-right gesture back to the conversation list couldn't be
  triggered when the swipe started near the right edge of the screen: it
  demanded more travel than the remaining screen width allowed, so the
  finger ran off the glass first. The required distance now shrinks to fit
  the room the finger actually has (with a floor, so a tap that wobbles
  sideways still never navigates).
- In conversations with images, the view could end up stuck above the
  newest messages and scrolling down never quite reached them: pictures
  finishing their decryption above the view silently pushed the feed down
  under the reader. When you're at the bottom of a conversation, the view
  now stays on the newest message through that late growth.
- On the phone conversation list, messages arriving in the conversation you
  last had open were silently marked read — no unread badge on its row, and
  no "new messages" divider when you went back in. They now stay unread
  until you actually open the conversation.

## v0.5.2 — 1 August 2026 — The back swipe that works

### Changed
- The phone conversation list's quick filter now sits behind a
  magnifying-glass button next to the add-friend and new-channel buttons,
  instead of appearing on its own once the list grows. Tap to show the
  filter, tap again to hide it and clear the query.

### Fixed
- The swipe-right gesture back to the conversation list didn't work on
  iPhones: it required starting the swipe at the very edge of the screen,
  which iOS reserves for its own back gesture, so the app never saw it.
  Swiping right now works from anywhere in the conversation; sideways
  drags on things that pan or slide (wide code blocks, the call volume
  slider) still do that instead of navigating.

## v0.5.1 — 1 August 2026 — Sturdier calls and a handier phone list

### Added
- The phone's conversation-list view now has a pinned "friends" entry that
  expands to your full friends list — everyone with their online status,
  online friends first — so you can find someone without scanning the
  conversation list. Tapping a friend opens your chat with them.
- The phone's conversation-list view now shows a quick filter above the
  conversations once the list is long enough, matching the filter the
  desktop sidebar already had.
- On phones, you can now swipe right from the left edge of a conversation
  to go back to the conversation list, instead of reaching for the back
  button.
- Call tiles now show a green dot while sound is coming from that person, so
  you can see who is talking at a glance. Your own tile shows it while your
  mic is live and unmuted.

### Changed
- Group calls with three or more people now show everyone in a grid of
  equal-size tiles instead of one big picture with small thumbnails — rows
  are added as people join, and past four participants the scratchpad
  shrinks to give the grid more room. Clicking a tile still brings back the
  big-picture view focused on that person (click the big picture to return
  to the grid), and a screen share still takes the spotlight. Two-person
  calls look the same as before.

### Fixed
- A connection dropped for unresponsiveness — easiest to hit during a video
  call on a slow uplink — used to strand the app on a "ping timeout" error
  until you refreshed the page. It now reconnects automatically like any
  other network drop.
- Losing the connection mid-call used to kick you out of the voice room for
  good, with a manual rejoin once you were back online. The room is now
  rejoined automatically as soon as the connection recovers, without
  switching you away from whatever channel you were reading.
- The microphone chosen in settings could silently stop applying — typically
  after a browser restart, or when the chosen headset wasn't connected yet
  at join time — and calls fell back to the built-in mic (most visible on
  macOS with AirPods). The chosen mic is now remembered by name: it is found
  again across restarts, connecting it mid-call switches the call over to it
  automatically, and when it is genuinely absent chalk says so instead of
  switching silently.

## v0.5.0 — 31 July 2026 — Zuckermode and message search

### Added
- **Zuckermode: a WhatsApp-style home screen for phones.** Opt in under
  settings → channel list, and on a phone chalk opens to one list of every
  conversation — people and channels together, newest first, each row
  showing who spoke last and a preview of what they said, plus the usual
  unread dot. Tap a conversation to open it full-screen; the back arrow in
  its header returns to the list. The parking lot and your thread inbox
  stay pinned above the list, and the two "+" buttons for friends and
  channels move into its header. Previews are decrypted on your device
  like everything else — the server still never reads a message. Off by
  default; desktop keeps the classic sidebar either way.
- **Search your messages.** A search button in the channel header — or
  Ctrl/Cmd+K anywhere — finds messages in the current channel or across every
  conversation loaded on this device, matching on text, sender and channel
  name. Clicking a result jumps straight to the message; results from inside
  a thread open that thread. Because chalk is end-to-end encrypted, search
  runs entirely on your device over messages it has already decrypted.
- **Search can go all the way back.** When what's loaded isn't enough, one
  click walks the current channel's entire history — with a live count, how
  far back it has reached, and a stop button — and results appear as they're
  found. Nothing is fetched until you ask; messages this device never had
  the keys for are counted and reported rather than silently skipped.

### Fixed
- **Giphy GIFs are no longer tiny on Safari.** On Safari — desktop and
  iPhone — GIFs in the feed rendered at a fraction of their real size, much
  smaller than in other browsers. They now display at the same size
  everywhere.

## v0.4.10 — 31 July 2026 — Phone polish and real YouTube titles

### Changed
- **Working next to a visible chalk window keeps you online longer.** With
  chalk on screen but another window focused, the away dot now waits 10
  minutes of no interaction instead of 5 before showing you as away.
- **Reactions are easier to hit on phones.** The quick-react emoji row on a
  long-pressed message and the cells of the full emoji picker were sized for
  a mouse pointer; on touch screens they now have proper thumb-sized targets.

### Fixed
- **YouTube link previews no longer show a wrong card.** Pasting a YouTube
  video link sometimes produced a card with an empty " - YouTube" title and a
  generic description in the wrong language, because YouTube served the
  preview fetcher a placeholder page instead of the video. Video previews now
  come from YouTube's own metadata service and show the real title and
  channel name — and when that lookup fails, chalk shows no card rather than
  a wrong one.
- **On phones, the room name now stays visible while you read.** The channel
  or DM title used to sit at the very top of the message history and scroll
  away with it, so mid-conversation there was no way to tell which room —
  or whose direct chat — you were looking at. It now stays pinned above the
  messages, and a very long channel name shortens with an ellipsis instead
  of wrapping the pinned bar over several lines.
- **iPhones no longer zoom the whole page when you tap into a field.** iOS
  Safari auto-zooms any input smaller than 16px and never zooms back out —
  tapping the message box, the sign-in form, the channel-create dialog, or
  the search fields left the page stuck zoomed-in. Every field on a phone
  now renders at 16px, and rotating to landscape no longer inflates text
  unpredictably.

## v0.4.9 — 31 July 2026 — One-click friends and edits that reach back

### Added
- **A "+" next to the friends header lists everyone on the server, addable
  in one click.** Like the channels "+", but for people: it opens the
  friends panel's add tab, which now shows the whole server directory —
  people you've already friended or have a pending request with are marked,
  everyone else has an add button. No more typing an exact username to find
  someone.

### Changed
- **Any of your recent messages can be edited from its menu, not just the
  latest.** The row menu's "Edit" used to appear only on your single most
  recent message, so a typo two messages back was stuck. It now appears on
  every message of yours still inside the 15-minute edit window. Cursor-up in
  an empty composer still jumps to your latest message.

## v0.4.8 — 31 July 2026 — Link previews without the leaks

### Added
- **Links from YouTube and Steam can now unfurl into preview cards.** Paste
  a link from a whitelisted site into the composer and chalk offers a card —
  title, description, thumbnail — that you can inspect and remove before
  sending; everyone then sees the card instead of a bare URL. Built the
  privacy-careful way: it's opt-in (nothing happens until you say yes), only
  *your* self-hosted server ever fetches the page, and the finished preview
  travels inside the end-to-end-encrypted message — the people you send it to
  fetch nothing and are revealed to no one. The card always shows the real
  destination host, since the rest of a preview is the sender's word. In
  settings you can add your own sites to the whitelist, drop the defaults,
  or hide incoming cards altogether; server admins can change the default
  whitelist or switch the feature off for everyone.

## v0.4.7 — 30 July 2026 — Mention autocomplete and a calmer start

### Added
- **Typing `@` now suggests who to mention.** The composer pops up a list
  of the channel's members as soon as you type `@`, narrowing as you keep
  typing — arrow keys or the mouse to pick, Enter or Tab to complete, Escape
  to dismiss. Mentions themselves already worked (a message naming
  `@your_handle` highlights it and marks the channel), but you had to know a
  member's exact handle and type it blind; now the roster comes to you. Works
  in thread replies and while editing a message, too.

### Changed
- **Chalk now starts in the parking lot.** Opening or reloading chalk used
  to drop you straight into a conversation of its own choosing (whichever
  one was created most recently). It now lands on the parking lot screen —
  nothing on display until you pick a channel.

## v0.4.6 — 30 July 2026 — Scrollback reaches all the way back

### Changed
- **Loading older messages is faster in thread-heavy channels.** Each
  "page" of scrollback now brings in a full screen of actual conversation
  instead of sometimes only a message or two — thread replies no longer
  count against what a page can carry.

### Fixed
- **Old messages are reachable again in busy channels.** Scrolling to the
  top of a conversation now loads what came before, page by page, until
  "beginning of channel" says there is nothing older. Channels with lively
  threads used to show only a few minutes of history with no way back —
  each thread reply silently ate a slot in the one page of history that
  ever loaded. The feed also tops itself up automatically when a
  thread-heavy stretch would otherwise leave it near-empty.

---

## v0.4.5 — 30 July 2026 — Channel groups and a roster filter

### Added
- **File a channel under whatever group you like.** The channel's
  right-click menu now has a "group" field: pick one of your existing
  groups or type a new one, and the channel moves there — in your sidebar
  only, on all your devices; everyone else keeps the creator's suggestion.
  A reset button puts it back where the creator filed it.
- **The channel list can fold into groups.** Once your channels live in
  more than one group, the sidebar shows them under collapsible headers —
  click a header to fold a group away, and a dot on the folded header
  still tells you something unread is inside. Which groups you keep
  folded is remembered per device, the filter box always searches across
  all of them, and you can turn grouping off entirely in settings under
  "channel list".
- **Channels can carry a group.** Creating a channel now has an optional
  "group" field — a suggestion for how the channel should be grouped in
  the sidebar. Pick an existing group from the list or type a new one;
  leaving it empty files the channel under "General", where all existing
  channels live too. (Grouped display in the sidebar is coming next; for
  now the group is just remembered.)
- **Filter for a long channel list.** When the sidebar's channel list grows
  past a handful of entries, a filter box appears above it — type a few
  letters and only matching channels stay visible, the same way the friends
  list already works.

## v0.4.4 — 30 July 2026 — Background blur and the parking lot

### Added
- **Somewhere to put chalk when someone walks up behind you.** There's a new
  row in the sidebar, between your friends and your threads, called "Parking
  Lot". Click it and the conversation is gone: no messages, no names, no
  half-typed line in the box — just the chalk mark drifting on an empty field.
  Chalk stays open and connected the whole time, so a call keeps running and
  nobody you're talking to sees you leave. Click any channel to come back
  exactly where you were, draft and all.

  While you're parked, nothing gets marked read and no notification pops up
  with a message in it — a sound still tells you something arrived, without
  saying what. It also survives a reload, so refreshing the page doesn't drop
  you back into the last conversation you had open.

  You can call it something other than "Parking Lot" in settings, and the name
  you pick follows you to your other devices. If you'd rather not have the row
  at all, the same place turns it off.
- **Blur your background on video calls.** There's a "blur my background"
  switch under the camera picker in settings, with a preview button beside it
  so you can see exactly what your camera is about to send before you send it —
  no need to be in a call to set it up, and the preview shows the real thing,
  blur and all. Turn it on and the room behind you goes soft while you stay
  sharp — mid-call, without the picture dropping for anyone watching. It's a
  per-machine setting, so blurring on the desktop doesn't turn it on for your
  phone.

  Where your camera or operating system can blur by itself, chalk lets it —
  that costs nothing and looks better. Everywhere else chalk does it in your
  browser, which means downloading about 3.7 MB the first time you switch it
  on (cached from then on) and using a noticeable amount of processor while
  your camera is on. Nothing about it leaves your machine: the picture is
  separated from the background on your own device, before anything is
  encrypted, and no part of it is ever sent anywhere.

  On a machine that struggles, blur gets out of the way rather than ruining
  the call: it quietly does less work per second — which at worst makes the
  edge around you lag a little — instead of letting your video turn choppy for
  everyone watching. If it still can't keep up it switches itself off and says
  so, and the same goes if it can't start at all. You are always told when
  your camera is unblurred rather than left to guess.

### Fixed
- **The threads marker now keeps up with the threads.** It was a number the
  server worked out when the list was last fetched, so it lagged in both
  directions: a reply landing in a thread you're part of didn't light it up
  until minutes later, and reading that thread didn't put it out. Both now
  happen as they occur, on this device and on your others.

---

## v0.4.3 — 29 July 2026 — Unread indicators and browser hardening

### Added
- **Mark every thread read without reading them.** The threads list has a
  "mark all read" button in its top right. It clears the unread mark on the
  threads it is showing you — so with a filter typed in, it clears only what
  matches — and, like reading a thread, it clears them on your other devices
  too.

### Changed
- **A voice channel's chat no longer nags you from outside the call.** The
  unread dot on a voice channel, and its share of the count on the tab, now
  only appear while you are actually in that room. Text typed during a call is
  destroyed when the call ends, so from the outside there was never anything
  there to go and read.
- **The browser is now told exactly where chalk is allowed to talk.** Every
  page chalk serves carries a policy pinning scripts, styles, fonts and
  network connections to your own server, so nothing that ships inside chalk
  can quietly reach a third party — and a page can no longer be embedded in a
  frame by another site. The one deliberate exception is Giphy: a GIF still
  loads from Giphy's own servers, for the people who turned Giphy on and for
  nobody else. Chalk also stops handing your address to sites you click
  through to, which matters most for the links that carry a one-time token —
  an invite, or an admin claim.

### Fixed
- **An unread dot on a voice channel could outlive the call it belonged to.**
  When everyone left and the call's chat was destroyed, the dot could come
  back on the next reconnect — pointing at a channel with nothing in it, and
  refusing to clear. Emptying the room now marks it read for everybody.
- **Reading a thread left the threads dot sitting there.** The unread marker
  beside "threads" only caught up the next time you opened the list, so
  clearing it appeared to take two visits. It now updates as soon as a thread
  is read, here or on another device.

---

## v0.4.2 — 28 July 2026 — Voice devices and mic tuning

### Added
- **Pick your camera and your speakers, not just your microphone.** The
  settings dialog behind the ⚙ beside the mute button now has a camera picker
  and an output picker alongside the input one. Both appear only when there is
  more than one of that kind plugged in — one webcam and one set of speakers
  needs no choosing. Switching camera works mid-call: the people watching see
  the new one without the call dropping or so much as a black frame. The
  output choice moves call audio *and* notification sounds to that device, so
  a call can live in your headset while the rest of the machine keeps its
  speakers. Choosing an output needs a browser that supports it — Chrome and
  Edge do, Firefox and Safari don't, and there the picker stays hidden rather
  than pretending. Like the microphone, these stay on this computer: they name
  sockets that don't exist on your other machines.

### Changed
- **The microphone dialog is now "voice & video".** Same dialog, same place —
  it just holds more than the microphone.
- **You set the "when i speak" thresholds by dragging them on the level
  meter now.** The two marks that decide when your mic opens and closes are
  handles on the meter itself — drag them to sit either side of where your
  voice lands, instead of guessing a percentage on a separate slider. The
  meter is also drawn in decibels, so a normal speaking voice sits around the
  middle of the bar rather than squashed into the first centimetre, and small
  moves are actually small. Arrow keys nudge a mark once you've clicked it.
- **Automatic gain control now starts off.** Unless you turned it on
  yourself, chalk no longer lets the browser ride your input level. It was
  filling the pauses between sentences by winding the mic up until your
  keyboard and your fan were as loud as your voice — which is what made
  noise suppression look like it wasn't doing anything — and it kept moving
  the floor that the "when i speak" marks are set against. Set your input
  volume once with the meter instead.

### Fixed
- **The microphone sliders no longer lag behind your finger.** Input volume
  and the thresholds used to jump to their new value only when you let go of
  the slider, and the meter's constant redraw made the whole dialog feel
  sticky while dragging. Everything tracks live now.
- **The meter's red "too loud" warning can actually appear.** It was set at a
  level no real microphone signal reaches, so a clipping input looked
  perfectly fine.

---

## v0.4.1 — 28 July 2026 — A VS Code light theme

### Added
- **A VS Code light theme.** The theme picker now has "vscode-light": pure
  white ground, black text, and the familiar VS Code status-bar blue as the
  accent — for people who want chalk to match their editor.

---

## v0.4.0 — 27 July 2026 — Notifications get rules

### Added
- **New notification sounds for things that aren't messages.** Someone
  starting a call in one of your voice channels, being added to a channel,
  receiving a friend request, and a proposal opening or resolving in a
  channel you're in each have their own chalk stroke now. Like every other
  sound, they stay quiet for whatever you're already looking at.
- **The tab blinks when something needs you.** Higher-priority
  notifications — mentions, DMs, thread replies, friend requests, channel
  invites — make a backgrounded chalk tab alternate its title with a ● marker
  until you come back to it. Do-not-disturb silences the blinking along with
  the sounds.
- **A notification rules panel, and desktop banners.** Profile →
  notifications → "notification rules…" opens the new panel: choose what each
  priority does (sound, desktop banner, blink), what priority each kind of
  event gets, and add per-person or per-channel overrides — mute a busy
  channel, or make one friend always break through. A person's rule beats
  their channel's, which beats the defaults. Desktop banners show the
  decrypted sender and preview (rendered locally by your OS — nothing leaves
  the device), click through to the right channel or thread, collapse to one
  per channel, and disappear on their own once you've read the thing anywhere,
  including on another device. Banners need a one-time browser permission,
  asked from the panel, and are desktop-only.
- **Right-click to set notification priority.** Right-click (or long-press) a
  friend or a channel in the sidebar to set their notification priority — or
  mute them — on the spot. It makes the same rule the panel does: anything set
  from the sidebar shows up under notification rules, where it can be changed
  or removed. The friend menu now also opens for friends without a nick color
  set up.
- **Notification rules follow you across devices — encrypted.** Priorities
  and per-person/per-channel rules set on one device now appear on your
  others. The rules name who and what you've singled out, so unlike the theme
  they never reach the server readably: they're encrypted on your device with
  a key derived from your identity, and the server only ever stores
  ciphertext. Sound volume, do-not-disturb, and chalk's own noises stay
  per-device, as before.
- **An unread count on the tab.** The title shows "(n) chalk" — counting
  unread DMs, channels you were mentioned in, unread threads you're part of,
  and open friend requests — and the app icon carries the same number where
  chalk is installed as an app. It clears by itself as things get read,
  including on your other devices, and stays visible under do-not-disturb:
  silencing interruptions doesn't hide what's waiting.

### Changed
- **Chat notifications are now driven by priority rules.** Every notification
  (mentions, DMs, thread replies, channel messages, calls, and the new event
  sounds) is assigned a priority, and the priority decides what happens —
  sound, desktop banner, tab blink, or nothing at all. Any chat sound you had
  switched off carries over as muted. The per-category checkboxes in profile →
  notifications now cover only chalk's own noises (connection, send
  confirmation, errors, friends coming online); the chat and event types are
  configured in the notification rules panel.

---

## v0.3.54 — 27 July 2026 — Threads catch up

### Added
- **Thread replies get the full composer.** The reply box in a thread now has
  the same tools as the channel composer: attach files, paste a screenshot,
  drag-and-drop, GIFs and the emoji picker — and it lines up with the main
  composer instead of sitting in its own differently-padded box. A reply that
  fails to send also keeps its text now instead of silently losing it.
- **Threads have titles now.** A thread is titled by the message it was
  started on: the title heads the thread panel and each row in the threads
  list, so you can tell threads apart without opening them. A thread started
  on an image or file with no text is titled by that instead — "[image]" or
  "[file]" (with a count when there are several), and the thread panel shows
  the filename, like "image: cat.png". (Titles are derived on your device
  from the decrypted message — the server still never sees them.)
- **"show message" in a thread jumps to where it started.** The thread
  panel's header has a new "show message" button that scrolls the channel to
  the original message and highlights it — loading older history first if
  the message is further back than what's on screen.
- **New theme: exchalk.** A true-black theme in the style of the big
  corporate meetings app's dark mode — black window, dark-grey panels,
  sky-blue links and a gold favorites accent. Pick it under profile →
  appearance.

### Changed
- **The threads button moved into the sidebar.** It now sits between friends
  and channels instead of in the top bar, so everything that can show an
  unread dot is in one place on the left.
- **The "⧉ popout" button is gone from the header.** It opened chalk in a
  popup window that didn't work reliably. For a dedicated chalk window,
  install chalk as an app instead (your browser's install option — chalk is
  a PWA).
- **The voice panel fades while you're not in a call.** The mute, deafen,
  camera, share and settings buttons in the bottom-left corner now sit
  semi-transparent when idle — visible, but no longer competing for
  attention — and return to full strength on hover or when you join a call.

### Fixed
- **Text sent with an image is visible again.** Sending a message with both
  an attachment and typed text drew the image over the text line in
  desktop-width windows, so the caption looked lost — it now shows above
  the image.

## v0.3.53 — 27 July 2026 — One place for call controls

### Changed
- **One set of call controls instead of two.** Mute, camera and leave no
  longer repeat under the video: the always-visible voice panel in the
  bottom-left corner is now the one place for them, and screen sharing moved
  there too (it lights up while you're sharing, and is greyed out until
  you're in a call). Under the video only the call timer, the share quality
  modes and the debug drawer remain.
- **The settings button in the voice panel now looks like a gear.** It used
  to read as a sun.

## v0.3.52 — 27 July 2026 — No more vanishing messages, kinder browser errors, and a darker darkord

### Changed
- **Darkord got darker.** The whole theme drops one more shade: the
  background now sits below Discord's darkest grey, with the sidebar and
  panels stepping down to match, so the depth between surfaces looks the
  same — just deeper.

### Fixed
- **A message can no longer vanish when sent at the wrong moment.** Hitting
  Enter just as the connection dropped — or before this channel's encryption
  key had arrived — cleared the box but sent nothing, and the text was simply
  gone. The message now comes back into the box so it can be sent again.
- **Typing Japanese, Chinese or Korean no longer sends half-finished words.**
  Pressing Enter to pick a candidate from the input method sent whatever was
  in the box mid-composition. Enter now only sends once the word is committed;
  the same applies to the add-friend box, and automatic emoticon replacement
  no longer garbles text while it is being composed.
- **chalk now loads in private browsing and over plain http.** Browsers that
  block site storage, or a server reached over http instead of https, made the
  app fail before anything appeared on screen.
- **Browsers too old for chalk's encryption now get told so.** On such a
  browser (Safari before 17, Firefox before 132, Chrome/Edge before 137),
  entering a perfectly correct recovery phrase failed with a generic error
  that looked like a typo. There is now a clear message naming the browser
  versions that work — and pointing out when the real problem is a plain-http
  address.
- **Thread previews no longer get stuck loading.** Opening the threads panel
  at the wrong moment, or clicking "show more", could leave rows on the grey
  loading shimmer forever; they now fill in.
- **Picking a friend's colour finally works on phones.** Long-pressing a
  friend in the roster opened the colour menu and instantly closed it again,
  and on iPhones the press also popped the text-selection bubble. The menu
  now stays open.

## v0.3.51 — 27 July 2026 — Darkord theme, azeroth greens, and a matching status light

### Added
- **New theme: darkord.** The familiar dark chat-app look — cool grey
  surfaces with a blurple accent — tuned one shade darker across the board.
  Available in the theme picker in your profile.

### Changed
- **The azeroth theme got its green.** The ground was a brown tavern black
  with nothing green anywhere; it is now a forest-dark green, and links and
  active items use the uncommon-item green instead of rare blue. Quest gold
  is still the emphasis color and the gilded frames stay.

### Fixed
- **Your own status light now matches everyone else's.** The dot in the
  online/away pill at the top took its color from the theme — dark in light
  themes, white in dark ones — instead of the fixed status colors. It is now
  green when online, amber when away, and a hollow grey ring when offline,
  the same in every theme, just like the dots next to your friends.

## v0.3.50 — 27 July 2026 — Thread search inside threads and instant previews

### Fixed
- **The thread filter now searches inside threads.** Typing in the active-threads
  panel only matched what each row already displayed — the channel, who replied
  last, and the two one-line previews — so a word that appeared anywhere else in
  a thread found nothing, and threads you were looking for silently disappeared
  from the list. The filter now matches every message of a thread your device
  has seen (encryption means it can only ever search what was decrypted here),
  and a matching row shows the line that matched, with who wrote it, instead of
  an unrelated newest reply.
- **Thread rows no longer show a blank shimmer for messages you already have.**
  A row in the active-threads panel could sit on a loading placeholder even
  though the newest reply was already on your screen in the thread itself; the
  reply you hold is now shown right away.

## v0.3.49 — 27 July 2026 — Name colours everywhere and calmer away detection

### Changed
- **Away is much slower to trigger.** All three of the "are you still there"
  timers have been relaxed: a tab in the background now waits two minutes
  instead of one, chalk visible but not the focused window waits five minutes
  instead of two, and chalk in front of you with nothing typed or clicked waits
  thirty-five minutes instead of ten. Reading a long thread, sitting in a call,
  or keeping chalk beside your work no longer shows you away. A locked screen
  or a system-wide idle signal still marks you away immediately.

### Fixed
- **Online and away now look the same in every theme.** The status light took
  its colour from the theme, so "online" showed up orange, red or blue
  depending on which one you were using — and on LCARS online and away were
  both amber and near-impossible to tell apart. Online is now always green,
  away always amber, and offline always a plain hollow ring, whichever theme
  you pick. Your own status in the bottom bar matches.
- **Name colours were ignored entirely in some browsers.** On affected clients
  every name in chat came out the same blue no matter what was picked — the
  automatic colours, your own colour, and anything chosen from the roster
  picker all collapsed to one shade, including the little preview dot in the
  picker itself. Names now carry their colour in a way every browser applies,
  and still shift with the theme so they stay readable on light and dark
  grounds.
- **Name colours now show up outside the chat feed.** Picking a colour for
  someone (right-click or long-press them in the roster) only recoloured their
  name on their messages — in the roster, the occupant list under a voice
  channel, and the members panel they stayed the plain theme colour, so the
  pick looked like it hadn't taken. Those places now use the same colour as
  chat, including your own colour on rows that read as "you". Turning name
  colouring off in your profile clears the tint everywhere, as before.

---

## v0.3.48 — 26 July 2026 — Thread filtering and multi-window video popouts

### Added
- **The threads panel can be filtered.** A box at the top of the panel narrows
  the list as you type, matching the channel name, who replied, and the preview
  text shown on each row. Type more than one word to narrow further — all of
  them have to match, in any order. Escape clears the filter; a second Escape
  closes the panel. The filter never leaves your device, so it only covers the
  threads the panel has loaded and the previews it can show, not every reply
  inside a thread.

### Changed
- **Pop out as many call videos as you like.** The pop-out button used to be on
  the big tile only, and a second pop-out replaced the first — so you could
  watch one thing outside the app and no more. Every tile with live video now
  carries the button, including the small ones in the strip, and each one opens
  a window of its own: three faces and a screen share can sit side by side while
  you read another channel. The button turns into a close button for a tile
  that is already out, and the windows tidy themselves up — a window closes when
  its camera goes off or its share stops, and all of them close when you leave
  the call.
- **Older threads now fade in the threads panel.** Rows dim in steps as their
  last reply ages — ten minutes, an hour, two hours, eight hours, a day, a week
  — so a conversation still going stands out from one that stopped yesterday
  instead of both looking the same in a sorted list. Hovering or tabbing to a
  row brings it back to full strength.

### Fixed
- **The call controls stay reachable in a busy voice channel.** With a camera or
  a screen share on, a filling scratchpad used to push mute, camera, share and
  the rest of the call bar out of sight below the video — the picture was all
  that was left. The video now gives up height instead, so the controls under it
  stay put no matter how tall the call or how full the text.
- **The "… is typing" line no longer crowds the message box.** Its row was
  exactly as tall as the text in it, which clipped the tops and tails of letters
  and left it sitting against the box below. It now has room of its own.

---

## v0.3.47 — 26 July 2026 — Reload prompt when the server updates

### Added
- **chalk notices when the server has been updated underneath you.** A tab left
  open across an update keeps running the version it started with, which is how
  you end up with one person seeing a feature nobody else has. A "new version ·
  reload" button now appears next to the connection status when the server comes
  back on a newer build; one click puts that tab on it. Dismiss it if you would
  rather finish what you were doing — it comes back the next time the server is
  updated, and it stays away if the server restarts without changing version.
- **A restart is labelled as one.** When the server is going down it tells every
  connected tab first, so the short disconnect that follows reads "server
  restarting" instead of showing a bare error code.

---

## v0.3.46 — 26 July 2026 — Voice scratchpad, video popout and away detection

### Added
- **Voice channels have a scratchpad now.** The text in a voice channel is
  meant for the call and nothing else: it shows only as much as fits between
  the call and the message box, older lines slide off the top and are gone, and
  the whole thing is deleted — for everyone, and off the server — the moment
  the last person leaves the room. It is the place for a link, a quick line
  someone is talking over, or a GIF, not for anything you want to read back
  tomorrow. The rule is written under the call so nobody has to find it out the
  hard way.
- **Pop a video or a shared screen out to watch it larger.** The tile you are
  focused on has a "popout" button. In Chrome, Edge and Brave it opens in a
  small window of its own that floats over your other apps, so you can follow
  someone's screen share while working in front of it; in Firefox and Safari it
  fills the chalk window instead, with a fullscreen button, and Escape or a
  click outside puts it back.
- **chalk can tell reading from having left.** In Chrome and Edge it asks once,
  on your first click, whether it may see when you stop touching the computer —
  not what you do, only whether you are doing anything, and whether the screen
  is locked. Say yes and reading a long thread no longer makes you look away,
  while locking your screen shows you as away straight off. Say no and nothing
  breaks; chalk falls back to guessing from the chalk window. Either way it is a
  switch under "away detection" in your profile, it is set per device, and none
  of it is sent anywhere. Firefox and Safari do not offer this at all, so the
  switch is not shown there.

### Changed
- **"Away" now means away from the machine, not away from the tab.** Auto
  presence used to look only at whether the chalk tab was on screen, so leaving
  chalk open beside the app you were actually working in — or walking off with
  it in front of a locked screen — showed you online indefinitely. It now
  watches for typing and mouse movement and whether the window has focus as
  well. Hiding the tab still takes a minute to count, so flipping tabs does not
  make your dot flicker for everyone.

### Fixed
- **Messages that arrived while you were away from your desk are no longer
  silent.** chalk keeps quiet for the channel you are already reading, but it
  was treating "that channel is on screen" as proof you were reading it — so the
  one time you most wanted a sound, with the right channel open and nobody in
  front of it, was the one time you got none.

---

## v0.3.45 — 26 July 2026 — Voice controls, microphone settings and typing indicators

### Added
- **Mute, deafen and camera are always within reach — and they stick.** A panel
  of voice controls now sits at the bottom left, under your channel list,
  whether or not you are in a call. They are not just for the call you are in:
  whatever they show is how you join the next room. Mute yourself before you
  walk in and you arrive muted; turn the camera on and you arrive with video,
  instead of joining live and scrambling for the button. They stay put across
  leaving a room, dropped connections and page reloads. The mute and deafen
  buttons that used to be in the "voice connected" panel are gone, since they
  now sit directly below it and did the same thing.
- **Microphone settings have a dialog of their own.** Input device, level and
  meter, when to transmit, and the voice keys are now behind the ⚙ next to the
  mute button — where you already are when nobody can hear you — rather than
  three quarters of the way down the profile panel. The profile panel still
  points you to it. Everything in it except the chosen input device now follows
  your account, so a second computer starts from your settings instead of a
  blank slate; the device stays put, since it names a socket on one machine.
  "When to transmit" is a dropdown now rather than four stacked cards, so the
  level meter is no longer pushed off the screen by them.
- **You can see when someone is writing to you.** A line above the message box
  says "alice is typing...", naming up to five people at once — and if more
  than five of you are going at it, it gives up and says the keyboards are on
  fire. A name disappears a few seconds after the person stops, or the moment
  their message lands. Threads don't have this yet. If you'd rather not take
  part, turn "show who is typing" off in your profile: it works both ways, so
  you stop seeing it and nobody sees it about you either.
- **A "threads" list, so replies stop slipping past you.** A new button in the
  status bar opens every thread worth your attention across all your channels,
  with a dot when one of them needs you. It has two groups: *needs you* — a
  thread you took part in, or one where somebody wrote your name, that has a
  reply you have not read — and *also active*, anything else that has been
  replied to recently. Each row shows the channel, who replied last, how many
  replies there are and a one-line preview; clicking it jumps straight into the
  thread. A thread you took part in and never read is listed however long ago it
  went quiet, so nothing is quietly dropped for being old. Self-hosters can
  change what counts as "recent" from the default two days with
  `CHALK_THREAD_ACTIVE_WINDOW_HOURS`, or `chalkctl init
  --thread-active-window-hours`.

### Changed
- **The attach, GIF and emoji buttons moved next to the message box.** They
  used to sit at the bottom of the channel list, a screen's width from the
  field they act on, and took up a whole column to do it. They are now a small
  block against the left edge of the box you type in. They also show as icons
  by default instead of the words FILE / GIF / EMOJI, since the block would
  otherwise be three times as wide; if you preferred the words, the composer
  buttons setting in your profile still has them.
- **The cursor is already in the message box when you open a channel.** Picking
  a channel puts the caret in the composer, so you can start typing straight
  away instead of clicking into the box first; if the channel is still
  unlocking its encryption, the cursor lands there the moment it is ready.
  Opening a thread does the same for the reply box, and closing the thread
  hands the cursor back to the channel's composer. On phones nothing is
  focused automatically, so the on-screen keyboard stays out of the way until
  you tap.
- **Opening a channel is faster, and stays fast as history grows.** Loading a
  conversation used to re-count every reply in every thread on the whole server
  each time, so it got slower for everyone as the server filled up. It now looks
  up what it needs directly.

### Fixed
- **Calls now work from networks that block plain UDP.** Your browser was only
  ever told how to reach the relay over UDP, so on a connection that blocks it —
  many company and hotel networks — a call sat at "connecting" for forty seconds
  and then gave up, with no fallback to try. Calls now also offer the relay over
  TCP, which those networks do let through.
- **The relay server was running on its own defaults, ignoring its settings.**
  Everything a self-hoster configured for the relay — the address it hands out,
  the range of ports it may use, whether it logs anything — was written to a file
  the relay could not read, so it quietly used built-in defaults instead. That
  could leave calls unable to connect at all, and left almost nothing in the logs
  to explain why. Every setting is now applied directly and is visible in
  `systemctl cat chalk-coturn`. Self-hosters should re-run
  `chalkctl reconfigure-turn` to pick this up, and open the wider relay port
  range it now uses (49160-49999/udp) — the range was previously 41 ports for the
  whole server, which calls could exhaust.
- **Threads you have read stay read on your other devices.** Read a thread on
  your phone and the "new replies" badge stayed lit on your laptop forever, with
  nothing that would ever clear it — each device kept its own private idea of
  what you had seen, and a fresh browser treated every thread you had ever read
  as new again. Which threads you have read now follows you between devices, and
  clearing a badge in one place clears it everywhere.
- **The voice connection panel no longer spills over the message list.** With a
  narrow sidebar, the mute, deafen and leave buttons at the bottom left ran off
  the edge of the column and sat on top of the conversation. They now shrink to
  single letters — `m`, `d`, `l`, still colour-coded and with the full wording
  on hover — and grow back to words once the sidebar is wide enough to hold
  them.
- **Voice channels join automatically the first time too.** Opening a voice
  channel you had never visited before showed a "join voice" button instead of
  connecting right away — only a later visit, once you had already opened that
  room once, joined automatically on click. Every visit now behaves the same
  way: picking a voice channel joins it as soon as it's ready, first time or
  not.

---

## v0.3.42 — 26 July 2026 — Composer, emoticons and message actions

### Added
- **Typed emoticons become emoji.** Type `:)` and you get 😀, the way chat
  clients did it before the web — along with `;)`, `:D`, `:P`, `:(`, `<3`,
  `8-)` and a couple of dozen more. It only fires on an emoticon typed on its
  own, so pasted links and "see step 8)" are left alone, and backspace right
  after a swap puts the characters back when you meant the punctuation. Turn it
  off under chat settings in your profile.
- **Keyboard shortcuts for the composer buttons.** `ctrl+e` opens the emoji
  picker, `ctrl+g` the GIF picker, and `ctrl+shift+f` the file dialog (`⌘` on a
  Mac). The new `?` button next to them lists every composer key, including the
  ones nobody finds on their own: shift+enter for a new line, cursor-up to edit
  your last message.
- **Links in messages are clickable.** Paste an address starting with `http://`
  or `https://` and it becomes a link that opens in your browser, in a new tab
  — or in your default browser if you run chalk as an installed app or in a
  pop-out window. A full stop or a closing bracket at the end of the sentence
  stays out of the link, and a bracket that belongs to the address keeps it.
  Only web addresses are ever linked; anything else stays as plain text.
- **Network controls in the call's debug panel.** The debug button in a voice
  call now has three switches for how your connection is routed: *relay only*
  sends everything through the server's relay instead of straight to the other
  people — it hides your address from them and gets through networks that block
  direct connections; *ipv4 only* ignores IPv6 paths, for a machine whose IPv6
  looks available but never connects; *no lan* keeps a call off the local
  network shortcut. The panel shows which routing is actually in force,
  including when the server requires the relay for everyone, and a *rejoin*
  button applies a routing change to the room you are already in. The settings
  stay on that device and travel into the copied diagnostics report.

### Changed
- **Everything you can do to a message is now in one menu.** Right-click a
  message — or click the small `⋮` that appears in the left margin when you
  hover a line, or press and hold on a phone — and you get a row of one-click
  reactions, the full emoji picker, reply in thread, copy the text, and edit or
  delete where those are yours to do. The strip of buttons that used to float
  over the right-hand end of a message is gone. Hovering a message and pressing
  `r` opens the same menu. Right-clicking a link, an image or text you have
  selected still gives you the browser's own menu.
- **The composer got out of its own way.** The message box now sits directly
  under the messages, with the file, GIF and emoji buttons moved down beside it
  into the roster's column instead of stacked above the field. Send is a small
  button parked at the bottom corner rather than a full-height slab — enter
  still sends. On a phone the buttons sit under the box instead.
- **Editing a message looks like editing a message.** Pressing cursor-up to fix
  your last line now frames the whole box in the accent colour and turns the
  button into a matching "save", so an edit you started by accident is obvious
  before you hit enter.
- **Calls use IPv6 again.** Every call quietly dropped IPv6 paths to work
  around one machine with a broken IPv6 interface, which penalised everyone on
  a working IPv6 network. Calls now use whatever paths your network offers, and
  the workaround is the *ipv4 only* switch in the call debug panel for anyone
  who still needs it.

### Fixed
- **Message actions no longer sit on top of the message.** The old hover
  buttons covered the end of the first line of anything long enough to reach
  them, and the "more" menu was cut off by the bottom edge of the conversation
  when you opened it on the last message in a channel. The new menu opens where
  your pointer is and moves itself to stay on screen.

---

## v0.3.41 — 26 July 2026 — Microphone settings

### Added
- **Microphone settings.** There's a microphone section in your profile now.
  Pick which mic to use when you have more than one, set the input volume by
  hand when yours is too quiet or too hot, and switch echo cancellation, noise
  suppression and automatic gain control on or off. Press test to watch a level
  meter while you talk — drag the volume until you're filling most of the bar
  without turning it red. Everything applies to a call you're already in, so
  you can fix a mic mid-conversation without leaving and rejoining, and the
  settings stay on the device rather than following you between machines.
- **Choose when your mic transmits.** Four options, in the same place: always
  on (what chalk did until now, and still the default), open when you speak,
  push to talk, or push to mute. "When I speak" gives you two marks you drag
  onto the level meter — one for where your voice sits, one for where the room
  sits — so a pause mid-sentence doesn't cut you off, plus a setting for how
  long to keep sending after you stop so your last syllable survives. A dot
  next to the mute button shows when you're actually being heard.
- **Keys for talking, muting and deafening.** Bind your own: hold-to-talk (or
  hold-to-mute), a mute toggle, and deafen, which silences everyone at once and
  mutes you along with them. Unmuting brings your ears back too. Note that keys
  only reach chalk while a chalk tab is the window in front — a web page can't
  claim a key from the rest of your system, so push to talk won't work from
  inside a fullscreen game.

---

## v0.3.40 — 26 July 2026 — Notification sounds

### Added
- **chalk makes a sound now.** A message, a mention, a DM, a reply in one of
  your threads — each one is a short stroke of chalk on a board, pitched so you
  can tell them apart without looking. It stays quiet for the channel you're
  already reading, never fires more than once every couple of seconds, and can't
  make a noise at all until you've clicked something, so a tab left open
  overnight stays silent. Under notifications in your profile you can set the
  volume, choose what makes a sound, hear each one before you decide, and switch
  on do-not-disturb. There are sounds for your own connection dropping, a friend
  coming online and send confirmations too, switched off to begin with. The
  settings stay on the device instead of following you around, so your phone and
  your desktop can disagree.

---

## v0.3.29 — 26 July 2026 — Two new themes

### Added
- **New "warmwhite" theme.** A dark graphite channel rail beside a warm
  near-white page, with black titles and a blue accent on links and controls.
  Pick it under appearance in your profile.
- **New "azeroth" theme.** Quest gold and bronze frames on a tavern-dark
  ground, with the rest of the palette borrowed from where those colors come
  from: green for online, orange for warnings, blue for links.

---

## v0.3.28 — 25 July 2026 — Version badge and the blade-runner theme

### Added
- **New "blade-runner" theme.** Neon scarlet on a smoky black city ground,
  with teal links and a soft red glow on emphasis. Pick it under appearance in
  your profile; like every theme, it follows you across devices.
- **The version you're running is shown in the app.** It sits next to the
  chalk wordmark in the header, and under "about" in your profile; clicking it
  opens the changelog for that exact build. Development builds read "dev" and
  link to the latest changelog instead.
- **React without opening a menu.** A react button sits in the row actions,
  and pressing `r` while hovering a message opens the picker.

### Fixed
- **Being added to a channel works without a reload.** Two problems, both
  gone: members showed up as UUID fragments (sender names, roster and mention
  highlighting) until the next reconnect, and a channel could sit on "waiting
  for key" forever if you asked for your key a moment before the inviter
  deposited it. The server now sends handles with the channel, and the client
  retries the key as soon as it lands.

---

## v0.3.27 — 25 July 2026 — Edit and react

### Added
- **Emoji reactions.** React to any message; chips with a tally appear under
  it, and reactions on older messages are fetched as you scroll back.
  Reactions are end-to-end encrypted like everything else, per user.
- **Edit your own messages.** Press cursor-up to edit the last one you sent,
  or use the row menu. Edited messages are marked `(edited)`. The window is
  15 minutes from when the message was sent, and only the author can edit —
  there is deliberately no owner override and no vote: deleting is a
  moderation action a channel can have opinions about, putting words in
  someone's mouth is not. A deleted message can't be edited back into
  existence.

---

## v0.3.20 – v0.3.26 — 25 July 2026 — Mobile, unread tracking, deletion, PWA

### Added
- **Mobile layout.** A roster drawer, stacked message rows, safe-area insets
  for notched screens, and compact row actions that fit a narrow screen.
- **Unread tracking.** Per-channel read cursors that sync across your
  devices, unread and mention dots in the sidebar, a "new messages" divider
  in the feed, and landing on the first unread message when you open a
  channel. Mentions are detected client-side, so the server never needs your
  plaintext.
- **Message deletion, with rules.** Your own messages are always yours to
  delete, in any channel. Someone else's follows the channel's governance
  mode: the owner deletes unilaterally in dictator mode (confirmed twice,
  since it erases another member's words), and in democratic mode any member
  can open a proposal the channel votes on. The same rules apply in threads.
- **Reading comfort.** Resizable sidebar with a remembered width, per-device
  font family and text size (Hack is bundled, no network fetch), and an LCARS
  theme.
- **Installable app.** chalk logo in the header, app icons and a web manifest,
  so it installs as a PWA; the pop-out window now recognises itself reliably
  and hides its own pop-out button.

### Fixed
- **You no longer appear offline while you're online.** A closing tab could
  delete the presence row a newer connection had just claimed, presence
  counted devices instead of connections (so a second tab closing took you
  offline), and after another instance reclaimed a dead one, nothing
  re-asserted presence for the connections still open. All three fixed;
  hiding a tab now debounces before marking you away.
- **The view stops jumping** while images finish loading when you land in a
  channel.
- Full-width attachments keep the right-hand gutter instead of running to the
  window edge.
- The hover reply button shows in compact mode (delete already did).
- Modal dialogs have a real surface and readable contrast in every theme.

---

## v0.3.15 – v0.3.19 — 25 July 2026 — Passwords and two-factor (auth v2)

**Heads-up: this changes how everyone logs in.** Existing accounts are walked
through a migration wizard on their next sign-in.

### Changed
- **Sign in with a password and a 6-digit code.** Signup asks for a handle, a
  password (at least 20 characters across 4 character classes), a TOTP QR code
  to scan, and then shows you your two 24-word phrases. The password never
  leaves your browser — it's stretched with Argon2id and the server only sees
  a derived proof.
- **Two separate phrases, with separate jobs.** The *recovery phrase* gets you
  back into the account; the *encryption phrase* is your cryptographic
  identity and never leaves the client. Losing one does not cost you the
  other.
- **Passkeys are a convenience, not a bypass.** They still work, and they
  still ask for your TOTP code. Two-factor is mandatory on every path.
- **Recovery resets your login instead of performing it.** The old behaviour
  signed you in from the phrase alone: that skipped the second factor
  entirely and left you logged in but unable to change the password you'd
  forgotten. Now the phrase plus a live TOTP code sets a new password — or,
  if the authenticator is what you lost, clears TOTP so you can re-enrol
  through the session it mints.
- **Claiming the admin account** now uses a one-shot bootstrap token URL
  (`/?admin_token=…`, printed by `chalkctl init`), which stops working the
  moment the admin account has credentials. The old passkey-based bootstrap
  is gone.

### Added
- **Security panel** in your profile: change password, reset TOTP, relink the
  encryption phrase.

### Fixed
- **Passkeys synced across devices could refuse to log in** with a "Backup
  Eligible flag inconsistency" error, because the credential's backup flags
  weren't stored when it was registered. They're persisted and restored now.

---

## v0.3.0 – v0.3.14 — 22–23 July 2026 — Composer, message layout, duplicate messages

### Added
- **Emoji picker in the composer** — about 350 emoji in 8 categories with
  keyword search, so "lol" finds 😂 and "+1" finds 👍. Picks land at the
  caret (or replace the selection) instead of being appended, and the picker
  stays open for several picks.
- **Per-user nick colours**, stored as a hue so they stay readable when you
  switch themes. Everyone is auto-coloured from their handle; right-click or
  long-press a friend in the roster to pick or reset theirs.
- **Two themes:** snazzy-light (cool near-white, magenta accent) and
  tokyo-night.
- **Composer tool row** above the input — file, GIF, emoji — as text labels or
  icons, your choice. It no longer eats the width of the input field.
- **Pop-out button** that opens chalk in its own right-sized window.

### Fixed
- **Messages no longer appear twice.** Your own send could show up as both the
  local copy and the server's copy after a reconnect or a channel switch.
  Every send is now acknowledged to the sender with the stored message, so the
  local copy is retired exactly once no matter which path delivers the real
  one.
- **No more accidental second DM.** The new-channel dialog's "direct message
  (1:1)" checkbox could create a *second* DM with someone you already had one
  with — the new one starts empty, so the old conversation reads as "my
  messages are gone". The checkbox is gone, and asking for a DM that already
  exists returns the existing one.
- **Deploys take effect on the next page load.** Bundle filenames are
  content-hashed and cached immutably, so no more hard refresh after an
  update.
- Governance controls are hidden in DMs, where a vote between two people means
  nothing.
- **Message rows line up.** Timestamps align with the first line of a
  multi-line message instead of its middle; GIFs and attachments start at the
  body column instead of the row edge; the reply indicator and preview sit
  with the message they belong to; compact mode uses one font size throughout;
  the sender column is sized to the widest name in view (long names wrap), and
  shows your own handle rather than "you".

---

## v0.2.0 – v0.2.3 (plus ctl-v0.2.1 … ctl-v0.7.2) — 21–22 July 2026 — Deployment manager and voice fixes

### Added
- **`chalkctl` grew into a full deployment manager**: `init` seeds the admin
  identity and WebAuthn config so the deployment is loginable out of the box
  (with flags for the voice/attachment/Giphy knobs, plus `--force` and
  `--drop-db`), `up` / `down` / `status` for lifecycle, `images` to show what
  provenance the running image carries, `update` to verify, swap,
  health-check and roll back automatically, and `reconfigure-turn`. coturn
  runs on alpine, the external IPv4 address is detected automatically, and
  `-n` logs to stdout.
- **Images carry OCI provenance labels** (version, revision, build date), so
  `podman inspect` tells you exactly which commit is deployed.

### Fixed
- **Video stopped flickering** roughly once a second in calls — the video
  element was being torn down and rebuilt on every re-render instead of
  being reused.
- **Calls work on hosts with a VM or VPN bridge.** Non-routable IPv6 ULA
  candidates were being offered and failing TURN lookup; ICE now filters to
  IPv4.
- **Deployments come up on PostgreSQL 18**, which moved its data directory
  into a versioned subdirectory.
- **chalkd starts with the configuration it was given.** Quadlet expands
  `Environment=` before the env file is loaded, so any setting composed from
  another one collapsed to empty and the server failed to start; composed
  values are now written out literally, and secrets no longer round-trip
  through unit files at all (coturn reads its own config file).

---

## v0.1.0 — 20 July 2026 — First tagged release

- **Signed releases.** Multi-arch container image and `chalkctl` binaries,
  built by CI and cosign-signed, published to GHCR. `chalkctl` verifies the
  signature before it pulls.
- **Self-installing deployment.** `chalkctl init` renders podman Quadlet units
  and brings up chalkd, Postgres and coturn on a fresh host.
- **Voice and video complete** through screen/game sharing and adaptive
  quality (see below).

---

## Before v0.1.0 — the untagged build (phases 00–30)

The condensed story. The full slice-by-slice record is in
[docs/phase-log.md](docs/phase-log.md).

- **End-to-end encryption (phases 22–25).** Your identity keys come from a
  24-word phrase; each channel has a shared key that encrypts its messages,
  and that key is handed to each member wrapped under their public key. The
  server went back to being a blind relay. Includes picture-word verification
  against key substitution, and key rotation when someone is removed —
  they can't read anything sent afterwards.
- **Voice and video (phase 30).** Discord-style voice channels: a WebRTC mesh
  with coturn as the mandatory relay, signalling encrypted under the channel
  key, and each peer's call fingerprint signed by their identity (a mismatch
  aborts the call rather than continuing unverified). Sidebar occupancy with
  mute/camera/screen badges, a big-tile + filmstrip stage, call duration, and
  a diagnostics drawer. Screen and game sharing with a motion / detail / text
  quality preference, shared program audio, and camera plus screen at the
  same time. Adaptive quality measures your uplink before the call, keeps
  watching passively during it, and divides the budget across peers instead
  of overshooting. Off unless `CHALK_VOICE_ENABLED` is set.
- **Attachments.** Encrypted uploads with encrypted previews and metadata (the
  server sees only sizes), drag-and-drop and clipboard paste with per-file
  progress, and a local ciphertext cache. Giphy is opt-in per user and proxied
  through the server against a host allowlist.
- **Governance.** Each channel is `dictator` or `democratic`. In democratic
  mode, removing or adding a member, deleting a message, or changing the mode
  runs as a proposal the members vote on, with a frozen eligibility snapshot,
  quorum, cooldowns and expiry.
- **Multi-device.** A second device re-enters your encryption phrase, derives
  the same identity and checks it against the published one before saving it,
  so you can't accidentally fork your identity. Your messages echo to your
  other devices.
- **Admin moderation.** Block, unblock, soft-delete and purge users, plus an
  email blacklist, from an in-app admin panel.
- **License: GPL-3.0-or-later → BSD-3-Clause.** chalk moved to GPL only to
  match the `@wireapp/core-crypto` dependency; that dependency and all
  MLS/WASM code were removed in the 21-series rewrite, so the project returned
  to a permissive license. Done by the sole copyright holder; pre-relicense
  commits remain under their original terms (MIT through 9.x, GPL-3.0 during
  11a–21).

---

## Planned

- A server-side mixer (SFU) for voice rooms too large for a mesh.
- Governing per-channel settings by vote (`set_config` proposals).

---

## Phase numbering note

Phase numbers in the commit log and [docs/phase-log.md](docs/phase-log.md)
differ from the original `bootstrap/` scaffold's stub names. The canonical
mapping: **09** auth (shipped as 09a–09d); **10** skipped (the original "MLS"
phase folded into the 11-series); **11a** CoreCrypto foundation and **11b** MLS
DMs (both later removed in the 21-series rip-out); **21** MLS removal; **22–25**
the encryption rebuild that replaced it; **30** voice/video; **31** password +
TOTP auth; **32–38** the client polish arc (mobile, unread tracking, presence,
deletion, branding, edits and reactions).
