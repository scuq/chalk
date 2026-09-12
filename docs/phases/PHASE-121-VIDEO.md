# Phase 121 — video attachments: a poster frame in the feed, played on click

**Status:** built, 121-1 and 121-2 (2026-09-12). Unit-tested where the code
is pure (`web/src/attachments/types.test.ts` the kind and the duration badge,
`preview.test.ts` the meta codec and the seek point). The DOM half — poster
producer, player, gallery — was driven end to end in headless Chromium by a
30-check probe (`.claude/skills/run-chalk/probes/ui.mjs` at the time; two
users, a VP8 webm recorded in the page, sender and receiver, a clip with no
readable duration, a three-tile grid opening the gallery, a reload playing
from the cache with no download). The probe is what found the blank-frame
race below. What it could not reach is the checklist at the end.
**Tags:** `#video` → `tools/where.sh -g video`

## The problem

A video sent to a channel was a file row: a paper clip, `Peek 2026-09-10
21-01.mp4`, `657 KB`, a download button. Nothing said what was in it, and
seeing it meant saving it and opening another program. Pictures had had an
inline preview since att-2; scuq asked whether a video could get a few
frames of the same treatment, and be played in place.

## The constraint

Attachments are ciphertext end to end (`docs/design/chalk-attachments-design-spec.md`,
S3). The server holds one AES-GCM blob per attachment and never a frame of
it, so it cannot make a thumbnail, and a thumbnail it *could* make would be a
leak. Whatever preview exists is made on the **sender's** device, before
encryption, and rides on the ref as `enc_preview` exactly as an image's
downscaled JPEG does. That path already existed; this phase gives it a second
producer and teaches the feed a third kind.

## The design

### 121-1 — the poster frame, and a lone video that plays in place

- **Kind.** `AttachmentKind` gains `"video"` (`classifyKind`: `video/*`).
  `AttachmentMeta` gains `duration` (seconds, sender-read). Both are inside
  `enc_meta`; nothing server-visible changes. `decodeMeta` on a client from
  before this phase does not know the kind and falls back to
  `classifyKind(mime)`… which on *that* client is `"file"` — so an old build
  shows the row it always showed, with a working download. Nothing breaks
  across the version gap in either direction.
- **The poster** (`makeVideoPoster`, `preview.ts`). An offscreen muted
  `<video>` on an object URL of the file; on `loadedmetadata` seek to
  `posterSeekTime(duration)` — one second in, never past the middle of a
  clip shorter than two seconds, 0 when the duration is unreadable — and on
  `seeked` draw the frame to a canvas at the image preview's 320 px edge and
  JPEG quality. Eight seconds without a frame, a decode error, or a file with
  no video track (`videoWidth === 0`) yields `null`, and `uploadAttachment`
  proceeds as for any file: no preview, a file row on the far side. Muted is
  load-bearing — an unmuted element may not load without a gesture.
- **The blank-frame race.** `seeked` says the seek is done, not that the
  frame is there to draw: Chromium handed back an all-black canvas from a
  read taken on the event, at random, roughly one file in three, and a
  detached element never composites so `requestVideoFrameCallback` is no
  signal either (it was tried, and the run after it failed the other way
  round). What is reliable is the pixels: the frame is drawn, and if every
  pixel is under a small floor the read waits 150 ms and draws again, up to
  eight times. A clip that really opens on black gets its black frame after
  the last try. Duration is **floored** for the badge, as a player's own
  clock is, so a 2.6 s clip reads 0:02 on both.
- **`isImageRef` is unchanged** (`tiles.ts`). It reads "has an inline
  preview" and a video now has one, so a video tiles with the pictures. That
  is what a chat should do with a video among photos, and it keeps the
  server-opaque signal one bit rather than adding a kind column that would
  leak what was sent.
- **The feed** (`AttachmentView.tsx`). A video paints its poster with a play
  badge and the duration in the corner, sized by the poster's recorded
  dimensions so the swap to the player moves nothing (the 33-5 rule). **The
  full blob is not fetched on scroll** the way an image's is: a video is up
  to the 20 MiB cap and a feed of them would pull every one. It is fetched on
  the badge click, cache-first through the controller, decrypted, minted as
  an object URL and given to `<video controls autoplay>` in the same box.
  The click is the gesture that lets autoplay through. `onError` on the
  element — HEVC in most browsers, a container the engine will not open —
  flips to an "this browser cannot play this video" overlay over the poster;
  the caption under a lone video (name, size, download) is the way out. The
  signature binding of 83-2 already covers `enc_preview`, so the poster is
  bound to the message like an image preview is.
- **The tray** (`Composer.tsx`): a video chip shows its first frame through a
  muted `<video preload="metadata">` on the file's object URL, where an image
  chip has an `<img>`.

### 121-2 — a video in the gallery

- A video in a tile grid opens the group's lightbox like its neighbours
  (`onOpen`); a square crop is no place to watch anything. `Lightbox.tsx`
  shows it as `<video controls autoplay>` in the stage, fitted, with the
  poster and a spinner over it until the bytes come.
- **A neighbour's video is not prefetched.** Images still load both
  neighbours so a page turn is instant; a video loads its full blob only
  when it is the one showing (`loadFull`, keyed separately from the
  meta/preview load so a video whose meta arrived as a neighbour fetches the
  moment it becomes current). Its poster is there to page onto.
- Zoom stays the picture's: `frameOf` finds no `<img>` for a video and the
  wheel and double-click do nothing. A click on the player does not close
  the overlay (it joins `IMG` in the backdrop test), and a touch that starts
  on the `<video>` is left to its controls — scrubbing is a horizontal drag
  too — while the backdrop beside it still swipes.

**Rejected:** streaming playback with seeking before the whole file is down.
It needs chunked encryption and range requests on the ciphertext, an
architecture change for a 20 MiB cap that decrypts in memory in well under a
second. **Rejected:** several frames (a strip, or an animated poster) for the
preview. `enc_preview` rides in every history frame that carries the message
and its init request is capped at 256 KiB; one frame is the whole point of a
poster. **Rejected:** autoplaying muted in the feed the way social feeds do.
It would fetch every video on scroll, which is what the click exists to
avoid. **Rejected:** a server-visible kind on the ref. It would tell the host
which messages carry video; one bit — preview or not — is already known and
is enough.

## Manual checklist

Covered by the probe in headless Chromium with a VP8 `.webm` (Playwright's
Chromium has no H.264): tray chip, poster at the frame size and not blank,
badge, no fetch before the click, inline play, receiver's poster and play,
undurated clip (poster, no badge), two pictures + video as three tiles, the
tile opening the gallery playing, click on the player not closing it,
paging away and back, Escape, reload → poster → play from cache with zero
attachment GETs. Still by hand:

- [ ] Send a real `.mp4` (H.264) from desktop Chromium: poster, badge,
      inline play — the codec path the probe's browser lacks.
- [ ] Firefox does the same, sending and receiving.
- [ ] On a phone: a swipe beside the video in the gallery pages, a drag on
      its controls scrubs, and the poster's badge is tappable.
- [ ] A file the browser cannot decode (an HEVC `.mov` from an iPhone) sends
      as a file row; if the *receiver* cannot play an `.mp4` the sender
      could, the overlay says so and download still works.
- [ ] A build before 121 receiving a video shows a file row with a working
      download (the meta falls back to `file`).
- [ ] Desktop (Electron): poster and playback both work.
