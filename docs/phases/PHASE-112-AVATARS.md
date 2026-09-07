# Phase 112 — profile pictures

**Status:** built, 112-1 … 112-4 (2026-09-07). Verified against a running
stack — 14/14 checks, including the one this phase exists to keep: every feed
row is byte-identical in height with a picture, without one, and after a
removal.
**Tags:** `#avatar` → `tools/where.sh -g avatar`

## The problem

chalk identifies people by a handle and a colour. That is enough to tell two
speakers apart and not enough to recognise anyone at a glance — in a busy
channel the eye reads eight identical green words and has to *parse* each one.
Every other chat has a picture there for exactly that reason.

The constraint scuq set with the request is the whole design brief for the
rendering: **the feed's density must not change.** No row may get taller, no
line may gain leading, and the picture has to sit inside the line box that is
already there. A profile picture that costs a pixel of vertical space in the
message list is a worse feed, whatever it adds.

## The design

**Encrypted per channel, exactly like a banner.** A picture of your face is
more revealing than your handle, and chalk's claim is that the server is a
blind relay. There is no user-level key shared with the people who need to see
your avatar, so the picture is uploaded once *per channel*, encrypted under
that channel's key, and the server holds one opaque blob per (channel, member)
pair. Members can read it; chalkd and the host it runs on cannot.

The two alternatives were considered and rejected:

- **Plaintext, like a handle.** One upload, browser-cacheable, trivial — and
  the host running chalkd would see every member's face. Handles and channel
  names are server-visible by design; a face is a different class of thing,
  and shipping it in the clear would need a line in the threat model saying
  so. Not worth it for the saving.
- **One blob, its key wrapped to each viewer's identity key** (the phase 38/82
  machinery). Truly E2E with a single upload, and the right answer if avatars
  ever get large or numerous. It is also a new key-delivery path with its own
  rotation, its own review, and its own failure modes. Per-channel
  re-encryption buys the same privacy with machinery that already exists and
  is already understood — at the price below.

**The price is a fan-out.** Setting a picture uploads it once per channel you
are in, and joining a channel later needs one more. For a self-hosted server
with tens of channels that is tens of small blobs (96×96, a few KB each), sent
once when you change your picture. It is recorded here rather than hidden: if
someone ends up in hundreds of channels, this is the design that will need
revisiting first.

**The server stores a pointer, not a picture.** `channel_avatars` is
`(channel_id, user_id) → attachment_id`, and the attachment is an ordinary
one: uploaded through the existing chunked endpoints, encrypted client-side,
never linked to a message. The server checks that the blob belongs to the same
channel and was uploaded by the caller — otherwise anyone could point their
avatar at somebody else's picture — and nothing else, because there is nothing
else it can read.

**One line tall, and nothing else changes.** In the feed the picture is a
square `1em` box, `vertical-align: middle`, inline before the sender name. The
feed's line-height is 1.4em, so a 1em box cannot grow a line box that is
already taller than it. Square with sharp corners, because everything else in
the feed is a rectangle on a grid.

**The slot is reserved per channel, not per message.** If some members have a
picture and others do not, names would sit at different indents down the feed.
So the slot exists when *any* member of the channel has one, and a member
without a picture gets an empty box of the same width — the column stays
straight, and a channel where nobody has set one looks exactly as it did
before 112.

**Decrypted once, drawn many times.** A channel's feed shows the same sender
dozens of times, so the object URL is cached by attachment id in a module-level
store rather than resolved per row (`web/src/avatars/`). Cache-first against
the ciphertext in IndexedDB underneath that, so a reload repaints avatars with
no network.

**The cropper is reused.** 111-13's `BannerCropper` already knows how to pick
a region of a picture, and choosing which part of a photograph is your face is
the same question. Setting an avatar goes through it, so a wide photo becomes
a square by choice rather than by centre-crop.

Reusing it brought a rule that did not travel (112-7). The banner's cropper
disables its confirm button while the box is the whole picture, because
applying a crop that removes nothing re-encodes and re-uploads an identical
image for no reason. For an avatar that same rule made the flow *impossible to
finish without cropping*: the confirm button was the only way out of the
dialog. So the cropper now takes `allowWhole`, and the avatar passes it — the
square is cover-cropped from whatever region is chosen, and choosing all of it
is a normal answer. The button says "use picture" there and "crop" in the
banner, because "crop" reads wrong when nothing is being cut away.

**Off by default, and the reader decides (112-8).** Whether a picture is drawn
in the conversation is a per-device display pref (`showAvatars`), and it starts
**off**. That is deliberately the opposite of the channel image's switch
(111-4, on by default): a channel image is one picture the room's owner chose,
while profile pictures change how *every line* of the feed reads — and that is
the reader's call, not the setter's. It sits beside the other display prefs, so
a phone can stay plain while a desktop shows them.

The switch governs the **conversation**. 112-9 gives the **roster** a second
switch of its own, also off by default, covering the sidebar's friend rows and
the card that pops up over a name there. Two switches rather than one because
they are different reading problems: a picture in a roster row costs no
density (those rows are taller than a feed line) but does change a list people
scan by shape, and someone may reasonably want faces in the sidebar without
wanting them down every line of the feed. The gate is the map itself — the
roster is handed no pictures when the switch is off, so nothing can slip
through.

Outside both switches: your own picture in the status-bar corner (your face,
shown back to you as confirmation of a setting you chose), the members panel,
and call tiles.

**No default picture, and one invitation.** A member who has not set a picture
shows *nothing* — no generated initial, no stock face. That is the honest
state, and it is what the reserved-slot rule was designed around. But nobody
discovers a setting they were never told about, so the first time someone is
in a channel without a picture, chalk asks — once, ever.

"Once" is the entire specification of 112-6, and it is why the flag
(`prefs.avatarAsked`) lives in **account prefs rather than localStorage**: a
per-device flag would ask again on every new browser, which is precisely the
nagging this is not. The flag is written when the prompt is answered *either
way* — including dismissing it by clicking away, which is read as "no",
because that is the safe reading of someone waving off a question they did not
ask for. It is never cleared, so someone who declined is not asked again, and
someone who set a picture and later removed it is not re-prompted.

## Slices

| Slice | What it lands |
| --- | --- |
| 112-1 | server: migration 0060 (`channel_avatars`), the store, `set_avatar` / `list_avatars` / the `avatar_event` push, and the authz that ties a blob to its uploader |
| 112-2 | client: preparing a picture (square, 96px), the per-channel fan-out, and the settings UI that drives it |
| 112-3 | client: the avatar store + hook, and the feed — one line tall, reserved slot, no density change |
| 112-4 | the other surfaces: roster, members panel, hover card, voice tiles |
| 112-5 | the status bar's corner — your own picture beside your name |
| 112-6 | the one-time ask: a person with no picture is invited to set one, once, ever |
| 112-9 | the roster gets its own switch, also off by default |
| 112-8 | the reader's switch: profile pictures in the conversation are OFF by default, and each person turns them on for themselves |
| 112-7 | a picture can be used whole — the cropper's "you must crop something" rule was right for a banner and wrong here |

## Left open

- **The fan-out is per channel and sequential.** Setting a picture uploads it
  to each channel in turn, showing `sending 3/7…`. Tens of channels is a few
  seconds; hundreds would be a problem, and that is the number that would send
  this design back to the drawing board (the wrapped-key alternative in the
  design notes above).
- **A channel joined later has no picture until the next set.** The fan-out
  runs when you change your picture, not when you join a room; the channel
  stays pictureless until you set one again. A "fan out to channels that have
  none" pass on join is the obvious follow-up.
- **A channel whose key this device does not hold is skipped**, silently. The
  upload would block on a key that may never arrive; a device that does hold
  it covers the channel on its next attempt.
- **Removing a picture leaves the blobs.** `set_avatar ""` drops the pointer;
  the attachments stay, unlinked and unreferenced, like every other replaced
  banner or avatar blob.
- **No animation, no per-channel picture.** One face, every room. Choosing a
  different picture per channel is possible in this schema and is not offered.
- **The roster and the hover card draw whichever shared channel's copy is to
  hand.** If you share no channel with someone, you see no picture of them --
  which is also the privacy property: there is no copy you could read.

## Live-stack checklist

The probe drove one member's own client end to end; what it covers is ticked.

- [x] **A feed row is the same height with and without a picture** — measured
      three times over the same settled layout: before any picture, with one,
      and after removing it, comparing every row's height as a list. This is
      the constraint the phase was asked for and the one that broke twice
      before it held (see below).
- [x] The picture is square and no taller than the line box it sits in.
- [x] Members without a picture hold the slot, so the name column stays
      straight.
- [x] Setting one from settings: file → cropper → fan-out → drawn in the feed.
- [x] Removing one takes it out of the feed and restores the original layout.
- [x] 112-9: with a friend who has a picture, the roster draws none by
      default; the switch turns them on there and off again; and the chat
      switch is unaffected either way.
- [x] **The cross-client push, at last** — proven as a side effect of 112-9's
      run: the other member set their picture in a second browser, and it
      reached this client with no reload. That was the phase's longest-open
      unticked item.
- [x] 112-8: with a picture set on the account, the feed draws none until the
      switch is turned on; turning it on draws them with every row exactly as
      tall as before; the choice survives a reload; turning it off removes
      them again; a second device starts from the default (off), because the
      pref is per device; and the corner keeps showing your own picture
      throughout.
- [x] 112-7: a picture can be set with no crop drawn — the confirm button is
      offered, labelled "use picture", and the result is square and one line
      tall. The banner's cropper still refuses a crop that removes nothing,
      and still says "crop".
- [x] 112-6, the one-time ask: a person with no picture is asked; declining
      closes it; a reload does not ask again; **and a second browser profile
      signed into the same account is not asked either** — the check a
      localStorage flag would have failed. Also confirmed in passing: with no
      picture set, nothing at all is drawn.
- [x] 112-5: your picture appears in the corner beside your name, as a small
      square, and the status bar's height is unchanged — measured from a
      cleared state, because a "before" taken with a picture already on
      screen makes that comparison say nothing.
- [ ] The roster, members panel, hover card and call tiles with a real
      picture — wired and type-checked, but only the feed was driven live.
- [ ] A member who joins a channel after the picture was set (see Left open:
      they see nothing until the next set).

## What the density constraint cost

Two bugs, both caught by measuring rather than looking:

1. **The avatar became a grid item.** `.chalk-message` is
   `grid-template-columns: 7ch 9ch 1fr` — time, sender, body. Rendering the
   picture as a sibling of the sender span made it a fourth item, which pushed
   the body out of its column and wrapped the text one word per line. The
   picture belongs *inside* the sender cell, and the sender column widens by
   2ch when a channel has pictures so a handle does not lose room to it.
2. **The first "no change in height" measurement was a lie.** It was taken
   before the feed's images had laid out, so the baseline was 28px rows that
   later settled at 44px, and the test failed for a reason that had nothing to
   do with avatars. The probe now settles the layout before measuring
   anything.
