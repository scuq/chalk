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

## Slices

| Slice | What it lands |
| --- | --- |
| 112-1 | server: migration 0060 (`channel_avatars`), the store, `set_avatar` / `list_avatars` / the `avatar_event` push, and the authz that ties a blob to its uploader |
| 112-2 | client: preparing a picture (square, 96px), the per-channel fan-out, and the settings UI that drives it |
| 112-3 | client: the avatar store + hook, and the feed — one line tall, reserved slot, no density change |
| 112-4 | the other surfaces: roster, members panel, hover card, voice tiles |

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
- [ ] **A picture set by one member appears for another without a reload**
      (the `avatar_update` push across two clients). The push is built and the
      single-client path is proven; the two-client run is not.
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
