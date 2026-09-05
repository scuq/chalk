# Phase 101 — the multi-image tile grid

**Status:** 101-1 shipped. One slice; the phase is closed. Of the two
follow-ups under [Left open](#left-open), the gallery lightbox became phase
110; the tile placeholder is still open.

**Tag:** `#tilegrid` → `tools/where.sh -g tilegrid`.

## The problem

The composer has accepted several images at once since att-3 (multi-paste,
multi-drop, multi-select), but the feed rendered every attachment as its own
full-width block in a vertical stack (att-2's `chalk-message-attachments`
column). Paste four screenshots and the message towers over the feed — several
screens of scrolling for what other messengers (WhatsApp being the reference
scuq named) show as one glanceable grid.

## The design

A **two-column grid of square cover-crops** when a message carries two or more
images, rendered by a new `AttachmentGroup` component that both call sites
(the generic MessageList block and the 57-4 link-preview card's leftover
attachments) go through:

- **Partition without decrypting.** An attachment's `kind` is sealed inside
  `enc_meta`, but the inline encrypted preview travels on the ref itself and
  is minted for image kinds only — so `previewLen > 0 || encPreviewB64`
  (`isImageRef`, tiles.ts) tells images from files synchronously at render
  time, with no key material and no async gate before layout.
- **The layouts** (`tileLayout`, pure and node-tested): two images sit side by
  side; an odd visible count widens the *first* tile across both columns at
  2:1, so 3 reads as big-plus-pair and 5 as big-plus-2×2 with no ragged row.
  Collapsed, at most `TILE_CAP` (4) tiles show; the remainder hides behind a
  "+N" overlay on the last tile that expands the grid in place (per-message
  `showAll` state, not a modal).
- **Each tile is still a full `AttachmentView`.** Decrypt-meta, the blurred
  preview→full-res swap, the fail-closed locked placeholder and the lightbox
  all work per-image exactly as in the stack; a new `tile` prop only drops the
  33-5 inline natural-size style so the tile's CSS crop (`object-fit: cover`)
  owns the box. Fixed tile aspect means zero layout shift as images decrypt.
- **Files keep their rows** below the grid, and a lone image keeps the flat
  att-2 full-width layout unchanged.
- The grid caps its own width at 480px (vs the single image's 720px): crops
  are glanceable thumbnails; the lightbox is where a picture gets seen.

Rejected: WhatsApp's exact per-count bespoke layouts (1 big + 2 small columns
etc.) — the odd-count wide-first rule gets the same visual effect from one CSS
modifier; a gallery lightbox with prev/next behind the "+N" tile — expanding
in place is honest, keeps the existing per-image lightbox untouched, and a
swipeable gallery is its own slice if wanted; and decrypting meta before
layout to know kinds — the preview-presence signal makes that unnecessary.

## Slices

- **101-1** — `tiles.ts` layout helpers + tests, `AttachmentGroup`, the
  `tile` prop on `AttachmentView`, both call sites, grid CSS.

## Left open

- ~~The lightbox is still per-image: no prev/next arrows or swipe between the
  images of one message.~~ **Taken up as phase 110**
  ([PHASE-110-GALLERY.md](PHASE-110-GALLERY.md)), which lifted the expanded
  state into `AttachmentGroup` exactly as sketched here, and added zoom on the
  way. The "+N" images are in the gallery too, so paging reaches them without
  expanding the grid.
- Locked/loading tiles show the full label text centered in a small square;
  it wraps but is transient. An icon-only tile state would be tidier.
