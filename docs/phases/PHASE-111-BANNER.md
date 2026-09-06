# Phase 111 — the channel banner

**Status:** built, 111-1 … 111-12 (2026-09-06). Verified against a running
stack, desktop and emulated phone — 18/18 checks for 111-1…4, 12/12 for
111-5, 34/34 for the editor, the bleeds and the poster shape; what that
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

**Two ways to meet the band, and the owner picks (111-5).** `fill` is the
original behaviour — crop to cover — and it is right for a wide capture and
wrong for box art: a portrait poster covers an 88px band with a slice of its
own middle and says nothing. `fit` shows the whole picture at band height and
fills what is left on either side with a gradient running from the image's own
edge colour out to the theme background, so the picture ends *in* the page
rather than against an edge.

Choosing automatically was considered and rejected. Any rule is a rule about
aspect ratios, and aspect ratio does not say what the picture is *of*: a
16:9 screenshot of a landscape crops beautifully and a 16:9 screenshot of a
menu crops to nothing, at identical dimensions. The owner can see which they
have; a threshold cannot. The mode is channel state — it survives replacing
the image, so someone who has settled on `fit` for their box art does not
re-pick it every time.

**The bleed is the picture's own edge, not one colour (111-6).** The first
cut averaged each edge into a single colour and ran a gradient from it to the
theme background. That left a hard vertical seam wherever the edge was not
flat — a red sky over a black ridge met one muddy red, and the join was a line
you could point at in a screenshot. The fix is a colour per *row*: the edge
column becomes a `linear-gradient(to bottom, …)` of 24 stops, stretched
sideways and masked out toward the far end, so sky continues into sky and
ridge into ridge and there is no join to see. Sampling is a 24×24 canvas draw
(`banner-edges.ts`), alpha-aware so a transparent-edged PNG bleeds its own
colour and not black, and nothing about it is stored or transmitted: every
viewer samples the picture they already decrypted.

**The rest of the dial, and the editor that turns it (111-7 … 111-9).** Two
shapes were not enough once the first real poster went in: it wanted a
different part of itself visible, and more room than 88px. So the layout grew
to five values — fit, focal point, zoom, band height, bleed style — stored as
columns beside the picture (migration 0058) and carried as one `banner` object
on the wire, because the editor saves them together and half a layout is not a
state anyone chose.

**They live in a dialog, not in the menu.** The channel menu is a list of
one-click actions beside a sidebar row; framing a picture is not a one-click
action, because you cannot predict a crop — you have to see it. So picking a
file uploads it and opens an editor whose preview *is the real band*
(`BannerBand`, shared with the header) at the real height. An editor that
lies about the result would be worse than none. The menu keeps `set` /
`replace`, gains `edit`, keeps `clear`, and gave up the fill/fit toggle:
one place to change the framing, and it is the place that shows you what you
changed.

**Nothing is written until Save.** The upload happens when the file is picked
— the blob is encrypted and stored — but no channel row points at it, so
cancelling leaves an orphan and changes nothing anyone can see. Save is one
`update_channel` carrying the whole layout.

**The focal point is dragged on the preview**, not typed into two number
fields, because "which part of this picture do I keep" is a question about the
picture. It is offered only while something is actually cropped — fill always,
fit only once zoomed past the band — and the hint under the preview says which
case you are in rather than leaving a dead control.

**Zoom is the same idea in both shapes, spelled two ways.** Filling, it is a
`transform: scale` about the focal point. Fitted, it widens the picture's box
past its own aspect ratio, which under `object-fit: cover` scales the picture
up and crops it vertically — the same result with the layout width still true,
so the bleed either side keeps its real size. Neither measures anything: the
aspect ratio comes off the decoded image and CSS does the rest.

**Heights are names, not pixels.** `short`/`normal`/`tall` are 56/88/132 on a
desktop and 40/56/88 on a phone, because a third of a phone's feed is not what
"normal" should mean. Everyone in the channel sees the same name — it changes
the shape of the room, which is the owner's call — while whether a band is
drawn at all stays the per-device switch from 111-4.

**The client repairs what the server refuses.** Both ends validate, and they
do it differently on purpose: the server refuses an out-of-range value so the
client learns about its bug (`internal/store/channel_banner.go`), and the
renderer clamps whatever arrives to something drawable
(`web/src/state/banner.ts`), because by the time a summary reaches a header
the write is long done and a band that will not draw helps nobody.

**The blur bleed sits behind, and that took a z-index (111-10).** The layer
is absolutely positioned and the picture is not, and a positioned element
paints above a static one however the markup is ordered — so the first cut
covered the picture with its own blurred copy and the whole band looked out of
focus. The picture and the fades now carry `z-index: 1` unconditionally, so
nothing can slip on top of them later, and the probe asks the browser rather
than the stylesheet: `elementFromPoint` at the middle of the band must return
the sharp image, and only the backdrop may carry a `filter`.

**A wash, not the picture's edges (111-11).** 111-6's edge columns are
seamless when a picture's edge is smooth and stripey when it is not: a poster
with a horizon in it has a black ridge on one row and a red sky on the next,
and stretching those rows sideways paints exactly the bands it sounds like.
The wash replaces them with two colours taken from the *whole* picture — a
32×32 sample, quantised to 5 bits a channel, most common colour first and then
the most common colour far enough away to be visibly different — painted as an
even gradient, mirrored on both sides. It has no structure in it to streak,
and it reads as a surface the picture sits on. `edge` is gone from the client
and migration 0059 rewrote the rows; the store still answers "edge" with the
wash, so a client built before the rename is not refused over a renamed style.

**The third shape, for pictures taller than they are wide (111-12).** A band
is about twelve times wider than it is tall. Fill a poster into it and you get
a strip of its middle; fit it and you get a thumbnail with colour beside it.
Neither looks like a choice anyone made. `poster` stops trying: the art sits
at band height at the left with a little air and a soft drop shadow, and the
wash runs the whole width behind it — box art on a coloured backdrop, which is
what every storefront does with exactly this problem. Nothing is cropped, so
zoom and the focal point are not offered there, and the editor hides the zoom
row rather than leaving a control that does nothing.

**Tall means tall (111-11).** 132px made a fitted poster 99px wide. `tall` is
200px on a desktop and 120px on a phone, which is where box art becomes
readable; it is opt-in per channel, so the rooms that do not want the space
never pay for it.

**The blur backdrop is mirrored and barely darkened (111-11).** At
`brightness(0.72)` it read as a dimmed copy sitting behind the picture. At
0.86 with a wider radius, mirrored so its features do not line up with the
sharp picture, it reads as the picture's own light spilling outward.

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
| 111-5 | fill vs fit: migration 0057 (`channels.banner_fit`), `banner_fit` on `update_channel` and the summary, the menu's two-button toggle, the contained render and the sampled edge fade |
| 111-6 | the seam: the bleed becomes the image's own edge column per row (`banner-edges.ts`), masked instead of a colour stop |
| 111-7 | the layout model: migration 0058 (focus, zoom, height, bleed), the `banner` object replacing the flat wire fields, the store's fences and the client's normalizer |
| 111-8 | the band renders the layout: `BannerBand` (shared with the editor's preview), `useBannerImage`, height/focus/zoom/bleed CSS |
| 111-9 | the editor: preview, drag-to-focus, zoom, height, shape and sides; opened by an upload or the menu's `edit` row; the menu's fill/fit toggle retired |
| 111-10 | the blur bleed paints *behind* the picture — a z-index fix, and the probe checks that now ask the browser what is on top |
| 111-11 | the wash replaces the edge bleed (migration 0059), `tall` becomes 200px, and the blur is mirrored and lightened |
| 111-12 | `poster`: the art at band height at one end, the wash across the rest — the shape for pictures taller than they are wide |

## Left open

- **The wash is two colours, not a palette.** A picture with three equal
  colours in it gets the two most common; a busy photograph can wash to
  something duller than it looks. The `blur` bleed is the escape hatch when
  that happens.
- **The edge-column bleed is gone, not hidden.** It was genuinely better for
  pictures with soft edges (a photograph that fades to dark) and worse for
  everything else. Keeping both would have been a fourth option on a row that
  already has three; if the wash ever disappoints on a photograph, it is a
  small amount of code to bring back (`columnGradient` is still there and
  still tested).
- **`poster` puts the art at the left, always.** No right-hand or centred
  variant, and no text beside it. Both are easy additions if the left gets
  boring.
- **Zoom past the band does nothing in `fit`.** The picture's box is capped at
  the band width, where fitted has become filled; the slider keeps moving and
  the preview stops changing. Visible, harmless, and not worth a second rule.
- **The editor has no undo and no "revert to saved".** Cancel is the undo, and
  it is all-or-nothing.
- **No cropping proper.** The focal point moves the frame; it never trims the
  picture. A banner is always the whole uploaded image, shown less of.
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
- [x] 111-5, on a portrait poster: a replaced banner keeps the channel's fit;
      the toggle switches it; fitted, the image is a narrow centred panel at
      the same band height, flanked by two gradients whose far end is the
      theme background and whose near end is the sampled edge colour; the
      mode survives a reload; back to `fill` restores the full-width crop and
      removes the fade elements.
- [x] 111-7…111-9, on a portrait poster: a first pin starts from the
      defaults; every control moves the preview (shape, all three heights —
      measured, not assumed — zoom, and all three bleed styles); the preview
      is the real band at the real height; dragging moves the focal point;
      save pins exactly what the preview showed (shape, bleed and focal point
      compared field by field); `edit` reopens on the saved layout; cancel
      writes nothing; the layout survives a reload.
- [x] 111-11/111-12, on the same portrait poster: the wash is a two-stop
      gradient sampled from the picture (and visibly not the streaky edge
      bleed it replaced); `poster` puts the art at the left of a genuinely
      tall band (≥180px measured), shown whole (`object-fit: contain`) and
      wide enough to read; the editor hides the zoom control the shape
      cannot use; and the saved band reports the wash it was given.
- [ ] **A hand-sent `update_channel` from a non-owner** — the menu hides the
      row, and the handler refuses it, but only the hidden row is exercised.
- [ ] **The band across a channel key rotation.** The banner is encrypted at
      the version it was uploaded under and members keep old versions, so it
      should survive; nothing has actually rotated under one.
- [ ] **The swipe-back gesture (64-x) from the top of a feed with a band.**
      The phone run drove the menu with a right-click, not a long-press, and
      never swiped.
