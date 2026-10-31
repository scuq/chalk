#!/usr/bin/env python3
"""Cut a seasonal icon sheet into one transparent PNG for each figure (129-5).

Usage: python3 -I tools/cut-season-sheet.py SHEET.png OUTDIR

The sheet has a flat dark background, rows of icons, and a label under each
icon. For each row band in ROWS, the tool does these steps:

1. Key the background colour out to alpha.
2. Split the band at the empty columns between the icons.
3. Trim each piece to its content and pad it to a square.
4. Write the piece to OUTDIR/<season>/<id>.png.

ROWS holds the band heights and the figure ids for the sheet that chalk
uses. A different sheet needs its own entries in ROWS.
If a band splits into fewer pieces than it has ids, the tool exits with an
error.
"""
import sys
from pathlib import Path

import numpy as np
from PIL import Image

# (season, y0, y1, [ids left to right]) -- the icon band only, labels excluded.
ROWS = [
    ("halloween", 54, 198, ["pumpkin", "ghost", "witch-hat", "cauldron", "black-cat",
                            "skull-candle", "bat", "spider-web", "scarecrow", "haunted-lantern"]),
    ("winter", 280, 424, ["snowflake", "snowman", "pine-tree", "ice-crystal", "arctic-fox",
                          "winter-lantern", "signpost", "icicles", "scarf", "mittens"]),
]
NEAR, FAR = 5.0, 16.0   # colour distance from the background: fully clear below NEAR, opaque above FAR
FAR_GLOW = 60.0         # for pixels brighter than the sheet: a glow fades out over this distance
GLOW_LUM = 8.0          # how much brighter than the sheet a pixel must be to count as a glow
MIN_GAP = 6             # empty columns that separate two figures
PAD = 3
CLOSE = 4               # pixels: a gap in a figure's outline this narrow still closes it
HOLE_BG = 4.0           # a hole whose mean distance from the background is below this is a real gap


def grow(mask: np.ndarray, times: int) -> np.ndarray:
    """Return `mask` dilated by `times` pixels, one 4-neighbour step at a time."""
    m = mask.copy()
    for _ in range(times):
        g = m.copy()
        g[1:, :] |= m[:-1, :]
        g[:-1, :] |= m[1:, :]
        g[:, 1:] |= m[:, :-1]
        g[:, :-1] |= m[:, 1:]
        m = g
    return m


def reach_from_border(open_: np.ndarray) -> np.ndarray:
    """Return the part of the boolean mask `open_` that connects to the image border."""
    reach = np.zeros(open_.shape, dtype=bool)
    reach[0, :] = open_[0, :]
    reach[-1, :] = open_[-1, :]
    reach[:, 0] = open_[:, 0]
    reach[:, -1] = open_[:, -1]
    while True:
        g = grow(reach, 1) & open_
        if (g == reach).all():
            return reach
        reach = g


def components(mask: np.ndarray):
    """Yield the pixel indices of each 4-connected component of `mask`.

    Each item is a tuple of a row index array and a column index array, as
    np.nonzero returns.
    """
    todo = mask.copy()
    ys, xs = np.nonzero(todo)
    while ys.size:
        seed = np.zeros(mask.shape, dtype=bool)
        seed[ys[0], xs[0]] = True
        comp = seed
        while True:
            g = grow(comp, 1) & todo
            if (g == comp).all():
                break
            comp = g
        yield np.nonzero(comp)
        todo &= ~comp
        ys, xs = np.nonzero(todo)


def key(rgb: np.ndarray, bg: np.ndarray):
    """Key the background out of `rgb` and unblend the colour from it.

    Args:
        rgb: A band of the sheet, an array of height by width by 3, uint8.
        bg: The background colour of the sheet, three floats.

    Returns:
        A tuple of the alpha array and the unblended colour array, both uint8.

    Two kinds of pixel are close to the background colour.

    A dark figure, such as a black cat, is as dark as the sheet or darker.
    Its alpha comes from the colour distance between NEAR and FAR.
    The tool closes its outline across gaps of CLOSE pixels or less.
    A region that the closed outline encloses counts as the figure.
    The exception is a region with a mean distance from the background below
    HOLE_BG. That region is plain background and stays open. A spider web
    keeps its open cells in this way.

    A glow, such as the halo of a pumpkin, is brighter than the background
    by more than GLOW_LUM. Its alpha fades out over the longer distance
    FAR_GLOW. The tool unblends its colour from the background. So the glow
    is a translucent light on any page, and not a dark fog on a light page.
    """
    f = rgb.astype(np.float32)
    d = np.sqrt(((f - bg) ** 2).sum(axis=2))
    lum = f @ np.array([0.299, 0.587, 0.114], dtype=np.float32)
    bright = lum > float(bg @ np.array([0.299, 0.587, 0.114])) + GLOW_LUM
    a_dark = np.clip((d - NEAR) / (FAR - NEAR), 0.0, 1.0)
    a_glow = np.clip((d - NEAR) / (FAR_GLOW - NEAR), 0.0, 1.0)
    a = np.where(bright, a_glow, a_dark)
    solid = d >= FAR
    closed = ~grow(~grow(solid, CLOSE), CLOSE)  # morphological closing
    outside = reach_from_border(~closed)
    for ys, xs in components(~closed & ~outside):
        if d[ys, xs].mean() >= HOLE_BG:
            a[ys, xs] = 1.0
    # unblend: p = a*fg + (1-a)*bg  ->  fg = (p - (1-a)*bg) / a
    a3 = a[:, :, None]
    fg = np.where(a3 > 0.02, (f - (1.0 - a3) * bg) / np.maximum(a3, 0.02), f)
    fg = np.clip(fg, 0, 255).astype(np.uint8)
    return (a * 255).astype(np.uint8), fg


def segments(colmask: np.ndarray, want: int):
    """Split a band into `want` pieces at the empty columns.

    A run of MIN_GAP or more empty columns ends a piece. If there are more
    pieces than `want`, merge the two neighbours with the narrowest gap
    between them, and repeat until `want` pieces remain.

    Args:
        colmask: One boolean for each column, true if the column has content.
        want: The number of pieces to return.

    Returns:
        A list of (start, end) column ranges, `want` long.

    Raises:
        SystemExit: If there are fewer pieces than `want`.
    """
    segs, start, gap = [], None, 0
    for x, on in enumerate(colmask):
        if on:
            if start is None:
                start = x
            gap = 0
        elif start is not None:
            gap += 1
            if gap >= MIN_GAP:
                segs.append((start, x - gap + 1))
                start, gap = None, 0
    if start is not None:
        segs.append((start, len(colmask)))
    while len(segs) > want:
        # merge the pair whose join is narrowest
        i = min(range(len(segs) - 1), key=lambda i: segs[i + 1][0] - segs[i][1])
        segs[i:i + 2] = [(segs[i][0], segs[i + 1][1])]
    if len(segs) != want:
        raise SystemExit(f"found {len(segs)} pieces, wanted {want}: {segs}")
    return segs


def main(sheet: str, outdir: str) -> None:
    """Cut the sheet and write one PNG for each figure in ROWS.

    The background colour is the median of the four corners of the sheet.
    Each PNG is a square canvas with the figure centered.

    Args:
        sheet: The pathname of the icon sheet.
        outdir: The directory that receives the <season>/<id>.png files.
    """
    im = Image.open(sheet).convert("RGB")
    rgb = np.asarray(im)
    # the background: the median of the sheet's four corners
    corners = np.array([rgb[2, 2], rgb[2, -3], rgb[-3, 2], rgb[-3, -3]], dtype=np.float32)
    bg = np.median(corners, axis=0)
    alpha = np.zeros(rgb.shape[:2], dtype=np.uint8)
    rgb = rgb.copy()
    for season, y0, y1, ids in ROWS:
        alpha[y0:y1], rgb[y0:y1] = key(rgb[y0:y1], bg)
        band = alpha[y0:y1]
        colmask = band.max(axis=0) > 60
        segs = segments(colmask, len(ids))
        dest = Path(outdir) / season
        dest.mkdir(parents=True, exist_ok=True)
        for (x0, x1), fid in zip(segs, ids):
            piece = band[:, x0:x1]
            ys, xs = np.where(piece > 24)
            by0, by1 = max(ys.min() - PAD, 0), min(ys.max() + PAD + 1, piece.shape[0])
            bx0, bx1 = max(xs.min() - PAD, 0), min(xs.max() + PAD + 1, piece.shape[1])
            crop = rgb[y0 + by0:y0 + by1, x0 + bx0:x0 + bx1]
            a = alpha[y0 + by0:y0 + by1, x0 + bx0:x0 + bx1]
            out = np.dstack([crop, a])
            # square canvas, centred, so every figure sits on the same box
            h, w = a.shape
            side = max(h, w)
            canvas = np.zeros((side, side, 4), dtype=np.uint8)
            oy, ox = (side - h) // 2, (side - w) // 2
            canvas[oy:oy + h, ox:ox + w] = out
            Image.fromarray(canvas, "RGBA").save(dest / f"{fid}.png", optimize=True)
            print(f"{season}/{fid}.png  x={x0 + bx0}..{x0 + bx1} y={y0 + by0}..{y0 + by1}  {side}px")


if __name__ == "__main__":
    if len(sys.argv) != 3:
        raise SystemExit(__doc__)
    main(sys.argv[1], sys.argv[2])
