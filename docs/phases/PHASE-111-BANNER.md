# Phase 111 — the channel banner

**Status:** built, 111-1 … 111-4 (2026-09-06). Verified against a running
stack, desktop and emulated phone — 18/18 checks in the UI probe; what that
covers and what it does not is under [Left open](#left-open).
**Tags:** `#banner` → `tools/where.sh -g banner`

## The problem

A chalk channel identifies itself with a word. `The Blood of Dawnwalker` is a
line of text in a header row, and so is `General`, and so is every other room
in the roster — the sidebar and the header carry no sense of what a channel is
*about* beyond what someone typed into the name field.

For rooms built around one thing — a game, a release, a trip — the group
already has an image that says it faster than the name does. Today the only
place that image can live is the feed, where it scrolls away with everything
else: the poster someone posted in March is thirty screens up, and the room is
back to being a word.

The ask is a picture pinned to the channel title. The constraint that comes
with it, in scuq's words: *resized so it doesn't take up too much vertical
space but still looks good*. A chat window's vertical space is the product,
and a banner that eats a fifth of it is a worse channel than a plain word.

## The design

**A band under the header row, inside the sticky block.** The title row is
untouched — name, glyph, mode badge, lock, search all stay exactly where they
are — and a full-width strip sits directly beneath it, `object-fit: cover` at a
fixed height (88px desktop, 56px on a phone), so it crops rather than scales
and a wide Steam capture and a square box-art both read as a band.

The pinning moved out of `.chalk-channel-header` into a new
`.chalk-channel-headwrap` around it, which is what sticks now: the title row
keeps its flex layout and gives up only the properties that were about
pinning, and the band rides inside the same block, so it stays put while the
feed scrolls. "Pinned to the title" is the request, and a banner that scrolls
away is a banner nobody sees in a busy room. The offsets carried over
unchanged, so a channel with no banner renders exactly as it did before 111 —
and the parking header, which is the other user of the bare class, is
untouched. Clicking it opens the existing `Lightbox`
with the whole image at full size.

**The image is uploaded in the channel's own menu, not pinned from a message.**
The alternative — a "pin to header" row on the message menu — was cheaper (the
blob is already uploaded, already encrypted under the channel key) and was
rejected: it ties a channel's identity to a message that can be deleted, makes
the banner whatever aspect ratio someone happened to post, and puts a
channel-wide control in a per-message menu where every member sees it and only
the owner can use it. The banner is channel metadata and it is set where the
channel's other metadata is set — the sidebar's channel context menu, beside
`name` and `short`.

**It rides the attachment pipeline unchanged.** A banner is an ordinary
attachment: encrypted client-side under the channel's current key version,
chunk-uploaded over the existing HTTP endpoints, stored as ciphertext the
server cannot read. It simply never gets linked to a message. The upload
janitor only prunes rows still in `status='uploading'`, so a finalized,
unlinked blob is stable storage. **The server learns nothing new**: it holds an
opaque blob and a uuid on the channel row, exactly as it holds message
attachments today.

**Authorization is 106-2's rename rule, exactly.** Owner, dictator mode,
non-DM. A banner rewrites what every member sees at the top of the room —
precisely the reason renaming is the narrowest of the channel handlers — so it
travels in `update_channel` beside `name` and `short_name`, gated by the same
checks, acked by the same ack, and pushed to every member's every device by the
same `channel_event`. No new frame, no new governance surface. Democratic
channels answer `unilateral_forbidden`; a banner proposal type is not built,
for the same reason a rename proposal is not.

**The channel summary carries only the id.** `banner_attachment_id` and
nothing else. The obvious alternative — join `attachments` into
`ListChannelsForUser` and ship `enc_meta` + `key_version` on every summary —
was rejected: it puts a partitioned-table join into the hottest listing query
for a picture at most one channel is showing at a time. Instead the client
resolves the id through a new by-id ref endpoint
(`GET /api/attachments/{id}/ref`), which it needs anyway: the existing list
endpoint is bounded by `CHALK_ATTACH_FETCH_WINDOW_HOURS`, and a banner set in
March is outside every window by April. The ref carries `key_version` and
`enc_meta`; the ciphertext comes from the download endpoint the feed already
uses, cache-first against IndexedDB, so switching back to a channel repaints
its banner with no network at all.

**Fail-closed like every other attachment.** No key held, a decrypt that
returns null, a 404 from a blob that is no longer there: the band renders
nothing and the header is what it was before 111. A missing banner is never an
error state in the UI.

**The off switch is a per-device display pref.** `showChannelBanner`, default
on, in the appearance tab beside font, scale and width — the same class of knob
as those, for the same reason 70's prefs are per-device: the phone and the
desktop disagree about how much vertical space a picture is worth. Off means
the band never mounts, so it costs no fetch and no decrypt, not merely
`display: none`.

## Slices

| Slice | What it lands |
| --- | --- |
| 111-1 | server: migration 0056 (`channels.banner_attachment_id`), the store setter and its validation, `update_channel`'s new field, `banner_attachment_id` on `ChannelSummary`, and `GET /api/attachments/{id}/ref` |
| 111-2 | client: set and clear from the sidebar's channel menu — file picker, upload through the attachment pipeline, `update_channel` |
| 111-3 | client: the band itself — `ChannelBanner`, decrypt, lightbox on click, the `.chalk-channel-headwrap` sticky block, desktop + phone CSS |
| 111-4 | the off switch: `showChannelBanner` in display prefs, appearance tab, default on |

## Left open

- **No crop or reposition UI.** The band is `object-position: center`; an image
  whose subject sits at the top crops to its middle. A position control (or
  three fixed choices) is the obvious follow-up if it bites.
- **No per-channel collapse.** The pref is global on/off across every channel,
  not "hide this one banner".
- **Democratic channels cannot have one**, for the same reason they cannot be
  renamed.
- **Replacing a banner leaves the old blob.** It stays a finalized, unlinked
  attachment, unreferenced, counting against nothing but disk. Reaping
  unreferenced banner blobs is a janitor change nobody needs yet.

## Live-stack checklist

The store path has node/Go coverage; the rest needed a running stack. The
probe that ran it is the run-chalk skill's scratch slot
(`.claude/skills/run-chalk/probes/ui.mjs`) — rewritten per investigation, so
it is the *method* that is recorded here, not the file.

- [x] Owner sets a banner; a second member's open tab repaints it without a
      reload (the `channel_event` push), and decrypts it (`naturalWidth > 0`
      on both sides).
- [x] A non-owner's menu shows no banner row.
- [x] The band is 88px on the desktop layout and 56px under iPhone 14
      emulation, `object-fit: cover` in both.
- [x] It stays pinned while the feed scrolls (the band's `y` does not move
      across a 600px wheel), with the title row above it.
- [x] Clear removes it for the owner and for the other member.
- [x] The appearance switch is on by default, and turning it off removes the
      band without a reload (the in-tab prefs event, 111-4).
- [ ] **A hand-sent `update_channel` from a non-owner** — the menu hides the
      row, and the handler refuses it, but only the hidden row is exercised.
- [ ] **The band across a channel key rotation.** The banner is encrypted at
      the version it was uploaded under and members keep old versions, so it
      should survive; nothing has actually rotated under one.
- [ ] **The swipe-back gesture (64-x) from the top of a feed with a band.**
      The phone run drove the menu with a right-click, not a long-press, and
      never swiped.
