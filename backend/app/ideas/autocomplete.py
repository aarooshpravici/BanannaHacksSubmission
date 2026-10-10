"""Design autocomplete: find what is missing in a design, then fill it.

Gap detection works on the design's layout blocks (cards, tiles, photos,
buttons), not on pixels:
  1. find the blocks;
  2. group blocks of the same size and read the grid they sit on;
  3. report grid positions that have no block and are visually empty;
  4. separately, report large framed boxes with nothing inside.

Known limits: blocks that touch or share borders (ruled tables, galleries with
gutters under 6 px) are seen as one shape, and layouts over a photo or heavy
grain cannot be read.
"""

import threading
from dataclasses import dataclass
from functools import lru_cache

import cv2
import numpy as np
from PIL import Image

from ..images import to_rgb

# --- layout blocks ------------------------------------------------------------

# A block is at least 0.25% of the image. Lower sees smaller icons and avatars,
# but at 0.2% words and badges in a half-size export start to count as blocks.
MIN_AREA_FRAC = 0.0025
MIN_SIDE_FRAC = 0.025  # and not a thin rule or a line of text
MIN_FILL = 0.7  # the shape fills at least 70% of its bounding box (rectangles, rounded cards, circles)
# Look for blocks inside anything this large (panels, sections). Lower reaches
# into smaller widgets; at 0.05 it also enters cards, whose own contents then
# get read as patterns.
RECURSE_AREA_FRAC = 0.1


# Canny thresholds (weak, strong). Brightness is kept low enough to see the
# faint outline of a white card on an off-white page; lower would pick up
# gradient banding. Colour is higher: lower reads JPEG colour fringes as edges,
# higher loses boundaries that are a hue change at equal brightness.
LUMA_EDGE = (12, 36)
CHROMA_EDGE = (40, 80)
# Colour edges too faint for the thresholds above (a borderless pastel card on
# a light grey page) still count, but only away from every strong colour edge,
# because next to one they are JPEG fringes. Lower thresholds see paler tints
# but also the colour noise of a heavily compressed export.
FAINT_CHROMA_EDGE = (12, 36)
# How far (px) a strong colour edge spoils faint ones. JPEG stores colour in
# 16 px squares, so a fringe reaches at most that far from the shape causing
# it. Larger also hides a pale card that sits closer than this to a saturated
# element.
FRINGE_REACH = 16


@dataclass(frozen=True)
class Block:
    x: int
    y: int
    w: int
    h: int
    fill: float = 1.0
    source: str = "layout"

    @property
    def area(self) -> int:
        return self.w * self.h

    @property
    def x1(self) -> int:
        return self.x + self.w

    @property
    def y1(self) -> int:
        return self.y + self.h


def edge_map(img: Image.Image) -> np.ndarray:
    """Boolean map of visible edges in brightness or colour, slightly thickened.

    Colour is read less finely than brightness because JPEG stores it at half
    resolution: around a saturated shape it bleeds out to the next 16 px
    boundary, which would otherwise be read as part of the shape. Faint colour
    edges are therefore only believed where no strong colour edge is near.
    """
    rgb = cv2.GaussianBlur(np.asarray(to_rgb(img)), (3, 3), 0)
    ycc = cv2.cvtColor(rgb, cv2.COLOR_RGB2YCrCb)
    edges = cv2.Canny(np.ascontiguousarray(ycc[..., 0]), *LUMA_EDGE)
    strong, faint = np.zeros_like(edges), np.zeros_like(edges)
    for c in (1, 2):
        channel = np.ascontiguousarray(ycc[..., c])
        strong |= cv2.Canny(channel, *CHROMA_EDGE)
        faint |= cv2.Canny(channel, *FAINT_CHROMA_EDGE)
    reach = 2 * FRINGE_REACH + 1
    faint[cv2.dilate(strong, np.ones((reach, reach), np.uint8)) > 0] = 0
    edges |= strong | faint
    return cv2.dilate(edges, np.ones((3, 3), np.uint8)) > 0


def _blocks_in(edges: np.ndarray, x0: int, y0: int, depth: int, min_area: float, min_side: float) -> list[Block]:
    """Blocks inside one region of the edge map.

    The background is whatever can be reached from the region's border without
    crossing an edge (so a smooth gradient is still background). Each island
    that is left over is a block.
    """
    free = (~edges).astype(np.uint8)
    _, labels = cv2.connectedComponents(free, connectivity=4)
    border = np.concatenate([labels[0], labels[-1], labels[:, 0], labels[:, -1]])
    background = np.isin(labels, np.unique(border[border > 0])) & (free > 0)
    # Edge pixels lying on the border belong to the frame of the region, not to a block.
    foreground = ~background
    foreground[0], foreground[-1], foreground[:, 0], foreground[:, -1] = False, False, False, False
    n, _, stats, _ = cv2.connectedComponentsWithStats(foreground.astype(np.uint8), connectivity=8)
    region_area = edges.shape[0] * edges.shape[1]
    blocks: list[Block] = []
    for i in range(1, n):
        x, y, w, h, area = (int(v) for v in stats[i])
        if w * h < min_area or min(w, h) < min_side:
            continue
        fill = area / (w * h)
        if fill >= MIN_FILL:
            blocks.append(Block(x0 + x, y0 + y, w, h, fill))
        if depth > 0 and w * h >= RECURSE_AREA_FRAC * region_area and min(w, h) > 40:
            inset = 4  # step inside the block's own outline
            sub = edges[y + inset : y + h - inset, x + inset : x + w - inset]
            blocks += _blocks_in(sub, x0 + x + inset, y0 + y + inset, depth - 1, min_area, min_side)
    return blocks


def layout_blocks(img: Image.Image, edges: np.ndarray | None = None) -> list[Block]:
    """The design's blocks, found with classical image processing (milliseconds)."""
    edges = edge_map(img) if edges is None else edges
    h, w = edges.shape
    return _blocks_in(edges, 0, 0, depth=2, min_area=MIN_AREA_FRAC * w * h, min_side=MIN_SIDE_FRAC * min(w, h))


SAM_MODEL = "facebook/sam-vit-base"
_sam_lock = threading.Lock()


@lru_cache
def _sam():
    from transformers import pipeline

    from ..critic.embeddings import device

    return pipeline("mask-generation", model=SAM_MODEL, device=device())


def sam_blocks(img: Image.Image) -> list[Block]:
    """Blocks from Segment Anything. Slow (about 12 s on an Apple GPU).

    Finds flat design elements well but splits photos into their contents
    instead of returning the photo as one block, so it supplements
    layout_blocks rather than replacing it.
    """
    with _sam_lock:
        out = _sam()(to_rgb(img), points_per_batch=64, points_per_side=16)
    w, h = img.size
    blocks = []
    for mask in out["masks"]:
        mask = np.asarray(mask)
        ys, xs = np.nonzero(mask)
        if len(xs) == 0:
            continue
        bw, bh = int(xs.max() - xs.min() + 1), int(ys.max() - ys.min() + 1)
        fill = float(mask.sum()) / (bw * bh)
        if bw * bh >= MIN_AREA_FRAC * w * h and min(bw, bh) >= MIN_SIDE_FRAC * min(w, h) and fill >= MIN_FILL:
            blocks.append(Block(int(xs.min()), int(ys.min()), bw, bh, fill, "sam"))
    return blocks


# --- geometry helpers ---------------------------------------------------------


def _intersection(a: Block, b: Block) -> int:
    return max(0, min(a.x1, b.x1) - max(a.x, b.x)) * max(0, min(a.y1, b.y1) - max(a.y, b.y))


def iou(a: Block, b: Block) -> float:
    inter = _intersection(a, b)
    return inter / (a.area + b.area - inter) if inter else 0.0


SAME_BLOCK_IOU = 0.7  # two boxes overlapping this much are the same block seen twice


def dedupe(blocks: list[Block], threshold: float = SAME_BLOCK_IOU) -> list[Block]:
    """Drop near-duplicate blocks, keeping layout blocks over SAM ones."""
    kept: list[Block] = []
    # Of two near-identical boxes the outer one is kept. The inner one is the
    # same element found again inside its own outline, and a gap reported at
    # that size would leave the outline out of the region to fill.
    for b in sorted(blocks, key=lambda b: (b.source != "layout", -b.area)):
        if all(iou(b, k) < threshold for k in kept):
            kept.append(b)
    return kept


def _parent_of(block: Block, blocks: list[Block]) -> Block | None:
    """The smallest block that contains this one, if any."""
    containers = [o for o in blocks if o is not block and o.area > block.area * 1.25 and _intersection(block, o) >= 0.9 * block.area]
    return min(containers, key=lambda o: o.area) if containers else None


def _edge_density(edges: np.ndarray, x: float, y: float, w: float, h: float, inset: float = 0.06) -> float:
    """Fraction of edge pixels inside a box, ignoring a margin around its rim."""
    H, W = edges.shape
    dx, dy = w * inset, h * inset
    x0, y0 = max(0, int(round(x + dx))), max(0, int(round(y + dy)))
    x1, y1 = min(W, int(round(x + w - dx))), min(H, int(round(y + h - dy)))
    if x1 <= x0 or y1 <= y0:
        return 1.0
    return float(edges[y0:y1, x0:x1].mean())


# --- gap inference ------------------------------------------------------------

SIZE_TOLERANCE = 0.12  # blocks within 12% in width and height count as the same kind
EMPTY_EDGE_DENSITY = 0.006  # a slot with fewer edge pixels than this is empty
# On a textured page (dot grid, ruled paper) an empty slot is as busy as the
# page itself. The page's texture is the edge density of its emptiest tiles,
# looking only at tiles that lie clear of every block and of the slot being
# judged, and a slot may hold that much times the headroom on top of the limit
# above. More headroom tolerates uneven textures, but lets a slot holding faint
# content pass as empty.
TEXTURE_TILE = 48  # px; large enough to average over a texture's period, small enough that some tiles miss all content
TEXTURE_FLOOR_PERCENTILE = 10  # low, so that the content covering most of a page does not count as its texture
TEXTURE_HEADROOM = 1.5
# With fewer free tiles than this the texture is not measured (taken as flat).
# On a page packed with blocks the few tiles left over hold loose content, not
# background. Lower reads the texture of fuller pages, but trusts fewer samples.
MIN_TEXTURE_TILES = 8
# Nothing busier than this is believed to be texture. A 2 px dot every 24 px
# measures about 0.056; three lines of loose text in a card-sized slot about
# 0.13. Higher accepts denser textures, but a slot holding text then passes as
# empty on a page whose free space is all text.
MAX_TEXTURE_FLOOR = 0.08
MIN_PLACEHOLDER_AREA_FRAC = 0.025
# An empty box whose fill differs from its surroundings by more than this (0-255,
# in any channel) is a solid element, not a placeholder. Lower drops more colour
# blocks, but also stops reporting tinted or dark placeholders on a light page.
MAX_PLACEHOLDER_CONTRAST = 64
# The exception: a box lighter than its surroundings whose channels lie within
# this of each other (white, light grey, a pale tint) is the ordinary empty card
# of a dark page, whatever the contrast. Pale tints stay under about 55 and
# brand colours start near 100. Higher keeps more strongly tinted empty cards,
# but starts reporting bright colour blocks on dark pages.
MAX_PLACEHOLDER_TINT = 60
# Breaks of up to twice this many px in a box's outline are sealed when looking
# for empty frames, so a dashed border still makes a box. Larger closes wider
# dash gaps and open corners, but merges elements that sit closer than that.
DASH_SEAL_RADIUS = 6
# How exactly a row must be off-centre by one pitch before a slot is added at
# its end. Looser finds more missing end cards in loosely drawn rows, but also
# invents slots beside rows that are simply aligned to one margin.
END_SLOT_TOLERANCE = 0.10
# A parent whose area around its children has more edge pixels than this is
# treated as a photo and not looked into. Higher looks inside busier panels
# (more text, more controls) but starts reading patterns into photos.
BUSY_PARENT_DENSITY = 0.05
PARENT_RIM = 8  # px at a parent's rim left out of that measure: wide enough for its outline, narrow enough to keep its content
# Above this share of empty cells, same-sized blocks in several rows and
# columns are not read as a grid with holes. Higher finds grids that are
# missing more of their cells, lower stays quiet on boards with uneven columns.
MAX_EMPTY_GRID_FRAC = 1 / 3
# Empty slots at the end of a grid's last row that are still reported. More
# catches a row missing several cards, but flags every list whose item count
# is not a multiple of its columns.
MAX_TRAILING_SLOTS = 1


@dataclass
class Gap:
    x: int
    y: int
    w: int
    h: int
    reason: str
    confidence: float
    kind: str  # "pattern" | "placeholder"
    siblings: tuple[tuple[int, int, int, int], ...] = ()  # the matching blocks this slot belongs with

    @property
    def bbox(self) -> tuple[int, int, int, int]:
        return (self.x, self.y, self.w, self.h)


def _same_size(a: Block, b: Block) -> bool:
    return abs(a.w - b.w) <= SIZE_TOLERANCE * max(a.w, b.w) and abs(a.h - b.h) <= SIZE_TOLERANCE * max(a.h, b.h)


def _size_groups(blocks: list[Block]) -> list[list[Block]]:
    groups: list[list[Block]] = []
    for b in sorted(blocks, key=lambda b: -b.area):
        for g in groups:
            if _same_size(b, g[0]):
                g.append(b)
                break
        else:
            groups.append([b])
    return groups


def _positions(values: list[float], tol: float) -> list[float]:
    """Collapse nearly equal coordinates into one position each, sorted."""
    out: list[list[float]] = []
    for v in sorted(values):
        if out and v - out[-1][-1] <= tol:
            out[-1].append(v)
        else:
            out.append([v])
    return [float(np.mean(g)) for g in out]


def _fill_axis(pos: list[float], size: float) -> tuple[list[float], float | None, bool]:
    """Complete a run of positions along one axis.

    Returns (positions including missing ones in between, pitch, guessed).
    pitch is the distance between neighbours, or None if it cannot be read.
    guessed is True when the pitch came from assuming that exactly one block is
    missing between the only two present, which is weaker evidence.
    """
    if len(pos) < 2:
        return pos, None, False
    diffs = np.diff(pos)
    pitch = float(diffs.min())
    if pitch < size:  # overlapping: not a regular row
        return pos, None, False
    guessed = False
    if len(pos) == 2:
        # Only two blocks: are they neighbours, or is something missing between
        # them? Try 1 to 3 missing blocks and keep the count whose spacing
        # looks most like a normal design gutter (about 15% of a block).
        space = pitch - size
        options = [(abs((space - k * size) / (k + 1) - 0.15 * size), k) for k in (1, 2, 3)
                   if 0.03 * size <= (space - k * size) / (k + 1) <= 0.6 * size]
        if options:
            pitch, guessed = pitch / (min(options)[1] + 1), True
    full = [pos[0]]
    for a, b in zip(pos, pos[1:]):
        k = round((b - a) / pitch)
        if k >= 2 and abs((b - a) - k * pitch) <= 0.12 * pitch:
            full += [a + pitch * i for i in range(1, k)]
        full.append(b)
    return full, pitch, guessed


def _extend_row(xs: list[float], pitch: float | None, w: float, left: float, right: float) -> list[float]:
    """The column missing at one end of a row, judged by how off-centre the row is.

    Designs often centre their rows. If the free space on one side exceeds the
    other by one pitch, adding one block would centre the row, so it is
    probably missing. Rows that are off-centre by more than one block are left
    alone: they are far more often aligned to a margin on purpose (a nav bar,
    a button row, cards flowed from the left) than short by several blocks.
    """
    if pitch is None or len(xs) < 2:
        return []
    space_left, space_right = xs[0] - left, right - (xs[-1] + w)
    if abs(abs(space_right - space_left) - pitch) > END_SLOT_TOLERANCE * pitch:
        return []
    return [xs[-1] + pitch] if space_right > space_left else [xs[0] - pitch]


def _tile_density(edges: np.ndarray) -> np.ndarray:
    """Edge density of the page cut into square tiles (rows, columns)."""
    t = TEXTURE_TILE
    H, W = edges.shape
    return edges[: H // t * t, : W // t * t].reshape(H // t, t, W // t, t).mean(axis=(1, 3))


def _tiles_clear_of(shape: tuple[int, int], bounds: tuple[int, int, int, int], blocks: list[Block]) -> np.ndarray:
    """Which tiles lie wholly inside bounds (x0, y0, x1, y1) and touch none of the blocks."""
    t = TEXTURE_TILE
    free = np.zeros(shape, bool)
    free[-(-bounds[1] // t) : bounds[3] // t, -(-bounds[0] // t) : bounds[2] // t] = True
    for b in blocks:
        free[b.y // t : -(-b.y1 // t), b.x // t : -(-b.x1 // t)] = False
    return free


def _texture_floor(tiles: np.ndarray, free: np.ndarray, slot: tuple[float, float, float, float]) -> float:
    """Edge density of the emptiest background near a slot: 0 on a flat page, above 0 on a dot grid or paper texture.

    Only tiles clear of the blocks and of the slot itself are looked at. On a
    page packed with blocks the emptiest tiles would otherwise be content, and
    the slot's own content would count as the texture it is compared with.
    """
    t = TEXTURE_TILE
    x, y, w, h = slot
    free = free.copy()
    free[max(0, int(y // t)) : int(-(-(y + h) // t)), max(0, int(x // t)) : int(-(-(x + w) // t))] = False
    if free.sum() < MIN_TEXTURE_TILES:
        return 0.0
    return min(MAX_TEXTURE_FLOOR, float(np.percentile(tiles[free], TEXTURE_FLOOR_PERCENTILE)))


def _pattern_gaps(
    group: list[Block],
    bounds: tuple[int, int, int, int],
    edges: np.ndarray,
    texture: tuple[np.ndarray, np.ndarray] | None = None,
) -> list[Gap]:
    """Empty slots in the grid one set of same-sized blocks sits on.

    texture is (_tile_density of the page, tiles clear of this group's
    siblings), from which the background's own texture is read; without it the
    background is taken as flat.
    """
    w, h = float(np.median([b.w for b in group])), float(np.median([b.h for b in group]))
    xs, pitch_x, guessed_x = _fill_axis(_positions([b.x for b in group], 0.15 * w), w)
    ys, _, guessed_y = _fill_axis(_positions([b.y for b in group], 0.15 * h), h)
    present_xs = set(xs)
    ends = _extend_row(xs, pitch_x, w, bounds[0], bounds[2])
    end_xs = {round(x) for x in ends}
    xs = sorted(xs + ends)

    def occupied(x: float, y: float) -> bool:
        return any(abs(b.x - x) <= 0.3 * w and abs(b.y - y) <= 0.3 * h for b in group)

    gaps = []
    trailing = []  # empty slots after the last block of the last row, where a list runs out
    for y in ys:
        for x in xs:
            if occupied(x, y):
                continue
            if x < bounds[0] - 1 or y < bounds[1] - 1 or x + w > bounds[2] + 1 or y + h > bounds[3] + 1:
                continue
            # A slot is empty when it holds no more than the background's own texture.
            floor = _texture_floor(*texture, (x, y, w, h)) if texture else 0.0
            if _edge_density(edges, x, y, w, h) > EMPTY_EDGE_DENSITY + TEXTURE_HEADROOM * floor:
                continue  # something else already sits here
            row = [b for b in group if abs(b.y - y) <= 0.3 * h]
            col = [b for b in group if abs(b.x - x) <= 0.3 * w]
            between_in_row = any(b.x < x for b in row) and any(b.x > x for b in row)
            between_in_col = any(b.y < y for b in col) and any(b.y > y for b in col)
            if x in ends or x not in present_xs and not (between_in_row or between_in_col):
                confidence, where = 0.65, "at the end of"
            elif guessed_x or guessed_y:
                confidence, where = 0.72, "in the middle of"
            elif between_in_row or between_in_col:
                confidence, where = 0.9, "inside"
            else:
                # A corner of the grid: could be missing, could be the natural end of the list.
                confidence, where = 0.55, "at the end of"
                if y == ys[-1] and not any(b.x > x for b in row):
                    trailing.append((round(x), round(y)))
            confidence = min(0.95, confidence + (0.05 if len(group) >= 4 else 0.0))
            gaps.append(
                Gap(
                    round(x), round(y), round(w), round(h),
                    f"Empty slot {where} a set of {len(group)} matching blocks ({round(w)}x{round(h)} px).",
                    confidence, "pattern", tuple((b.x, b.y, b.w, b.h) for b in group),
                )
            )
    # Rows times columns is only a grid if most of its cells are taken. Columns
    # of unequal length (a board, a masonry page) leave many cells empty by design.
    # The column guessed at one end is left out of the count: it is a guess about
    # the row, and says nothing about how full the columns that exist are.
    holes = sum(g.x not in end_xs for g in gaps)
    if len(present_xs) >= 2 and len(ys) >= 2 and holes > MAX_EMPTY_GRID_FRAC * (holes + len(group)):
        return []
    # A last row short by one block may be missing its last card. Short by more,
    # it is simply where the list ends (six items in four columns).
    if len(trailing) > MAX_TRAILING_SLOTS:
        gaps = [g for g in gaps if (g.x, g.y) not in trailing]
    return gaps


def _stands_out(rgb: np.ndarray, b: Block) -> bool:
    """Whether a box's fill is a clearly different colour from what surrounds it."""
    H, W = rgb.shape[:2]
    inner = rgb[b.y + b.h // 4 : b.y1 - b.h // 4, b.x + b.w // 4 : b.x1 - b.w // 4].reshape(-1, 3)
    near, far = 3, 8  # the ring starts past the box's own outline
    ring = np.concatenate([
        rgb[max(0, b.y - far) : max(0, b.y - near), b.x : b.x1].reshape(-1, 3),
        rgb[min(H, b.y1 + near) : min(H, b.y1 + far), b.x : b.x1].reshape(-1, 3),
        rgb[b.y : b.y1, max(0, b.x - far) : max(0, b.x - near)].reshape(-1, 3),
        rgb[b.y : b.y1, min(W, b.x1 + near) : min(W, b.x1 + far)].reshape(-1, 3),
    ])
    if len(inner) == 0 or len(ring) == 0:
        return False
    inside, around = np.median(inner, axis=0), np.median(ring, axis=0)
    if (inside > around).all() and inside.max() - inside.min() <= MAX_PLACEHOLDER_TINT:
        return False  # a pale box on a darker page
    return float(np.abs(inside - around).max()) > MAX_PLACEHOLDER_CONTRAST


def _sealed_boxes(edges: np.ndarray) -> list[Block]:
    """Placeholder-sized boxes whose outline has breaks in it (a dashed border).

    A broken outline lets the page background leak into the box, so no block
    is found for it. Thickening every edge seals the breaks; the boxes found
    that way are shrunk back by the same amount.
    """
    H, W = edges.shape
    r = DASH_SEAL_RADIUS
    sealed = cv2.dilate(edges.astype(np.uint8), np.ones((2 * r + 1, 2 * r + 1), np.uint8)) > 0
    found = _blocks_in(sealed, 0, 0, 0, MIN_PLACEHOLDER_AREA_FRAC * W * H, MIN_SIDE_FRAC * min(W, H))
    return [Block(b.x + r, b.y + r, b.w - 2 * r, b.h - 2 * r, b.fill) for b in found if min(b.w, b.h) > 4 * r]


def _placeholder_gaps(blocks: list[Block], edges: np.ndarray, rgb: np.ndarray) -> list[Gap]:
    """Large framed boxes with nothing inside them."""
    H, W = edges.shape
    gaps = []
    for b in blocks:
        if b.area < MIN_PLACEHOLDER_AREA_FRAC * W * H or b.fill < 0.9 or not 0.25 <= b.w / b.h <= 4:
            continue
        if _edge_density(edges, b.x, b.y, b.w, b.h, inset=0.08) > EMPTY_EDGE_DENSITY / 2:
            continue
        if _stands_out(rgb, b):
            continue  # a solid colour block (a swatch, a hero band) is content, not an empty frame
        gaps.append(Gap(b.x, b.y, b.w, b.h, "Framed box with nothing inside it.", 0.6, "placeholder"))
    return gaps


def find_gaps(img: Image.Image, blocks: list[Block], edges: np.ndarray | None = None) -> list[Gap]:
    """Missing regions implied by the layout, most confident first."""
    edges = edge_map(img) if edges is None else edges
    H, W = edges.shape
    blocks = dedupe(blocks)

    # Blocks are compared with their siblings: the blocks sharing the same parent.
    families: dict[Block | None, list[Block]] = {}
    for b in blocks:
        families.setdefault(_parent_of(b, blocks), []).append(b)

    gaps: list[Gap] = []
    tiles = _tile_density(edges)
    for parent, children in families.items():
        if parent is not None:
            # Only look inside containers (panels, sections). The inside of a
            # photo is full of same-sized segments that mean nothing.
            outside = np.ones_like(edges[parent.y : parent.y1, parent.x : parent.x1])
            for c in children:
                outside[c.y - parent.y : c.y1 - parent.y, c.x - parent.x : c.x1 - parent.x] = False
            # The parent's own outline is not content: counted, it makes an
            # ordinary dialog or framed page look as busy as a photo.
            r = PARENT_RIM
            outside[:r], outside[-r:], outside[:, :r], outside[:, -r:] = False, False, False, False
            around = edges[parent.y : parent.y1, parent.x : parent.x1][outside]
            if around.size == 0 or around.mean() > BUSY_PARENT_DENSITY:
                continue
        bounds = (0, 0, W, H) if parent is None else (parent.x, parent.y, parent.x1, parent.y1)
        for group in _size_groups(children):
            if len(group) >= 2:
                free = _tiles_clear_of(tiles.shape, bounds, children)
                gaps += _pattern_gaps(group, bounds, edges, (tiles, free))
    # A sealed box that repeats a block found the ordinary way is dropped: the
    # ordinary block follows the frame more closely.
    sealed = [s for s in _sealed_boxes(edges) if all(iou(s, b) < SAME_BLOCK_IOU for b in blocks)]
    gaps += _placeholder_gaps(blocks + dedupe(sealed), edges, np.asarray(to_rgb(img)))

    # A gap inside another gap is the same finding seen twice; keep the stronger.
    kept: list[Gap] = []
    for g in sorted(gaps, key=lambda g: -g.confidence):
        gb = Block(g.x, g.y, g.w, g.h)
        if all(_intersection(gb, Block(k.x, k.y, k.w, k.h)) < 0.5 * min(gb.area, k.w * k.h) for k in kept):
            kept.append(g)
    return kept


def detect(img: Image.Image, *, use_sam: bool = False) -> list[Gap]:
    edges = edge_map(img)
    blocks = layout_blocks(img, edges)
    if use_sam:
        blocks += sam_blocks(img)
    return find_gaps(img, blocks, edges)


def gap_mask(gap: Gap, size: tuple[int, int], *, grow: int = 6) -> np.ndarray:
    """0/255 mask for a gap, grown a little so a fill can draw its own border and shadow."""
    w, h = size
    mask = np.zeros((h, w), np.uint8)
    mask[max(0, gap.y - grow) : min(h, gap.y + gap.h + grow), max(0, gap.x - grow) : min(w, gap.x + gap.w + grow)] = 255
    return mask


# --- planner ------------------------------------------------------------------

PLAN_PROMPT = """You are helping complete a visual design that has a missing region.

Image 1 is the design. Image 2 is the same design with the missing region outlined in magenta.

1. In `analysis`, say in one or two sentences what the layout is and what most likely belongs in the outlined region, judging by the elements around it.
2. In `suggestions`, give 2 or 3 different options for filling it. Each has a short `label` (2 to 4 words) and a `prompt` for an image inpainting model. A prompt describes only what should appear inside the region, in the visual style of the rest of the design: shape, colors, any text to render (in quotes), and how it matches its neighbours. Keep each prompt under 60 words."""


def highlight(img: Image.Image, mask: np.ndarray) -> Image.Image:
    """The design with the masked region outlined, for showing to the planner."""
    out = np.asarray(to_rgb(img)).copy()
    contours, _ = cv2.findContours(mask, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)
    cv2.drawContours(out, contours, -1, (255, 0, 255), max(3, round(0.005 * max(out.shape[:2]))))
    return Image.fromarray(out)


# --- fill, rank, blend ----------------------------------------------------------

SCORE_WEIGHTS = {"style": 0.4, "seam": 0.4, "intent": 0.2}
# The generator works best near one megapixel and needs sides divisible by 16.
GENERATION_SIDE = 1024


def context_box(mask: np.ndarray, *, margin: float = 0.6, min_margin: int = 64) -> tuple[int, int, int, int]:
    """Box (x0, y0, x1, y1) around the mask with enough surroundings for the
    generator to see what it is continuing."""
    H, W = mask.shape
    ys, xs = np.nonzero(mask)
    x0, x1, y0, y1 = xs.min(), xs.max() + 1, ys.min(), ys.max() + 1
    mx, my = max(min_margin, round(margin * (x1 - x0))), max(min_margin, round(margin * (y1 - y0)))
    return (max(0, x0 - mx), max(0, y0 - my), min(W, x1 + mx), min(H, y1 + my))


def _generation_size(w: int, h: int) -> tuple[int, int]:
    scale = GENERATION_SIDE / max(w, h)
    return (max(16, round(w * scale / 16) * 16), max(16, round(h * scale / 16) * 16))


# What register() accepts as a redraw's drift. The two real outputs it was
# built on were zoomed 1 to 1.5% and shifted about 5 px on a 1024 px crop, the
# same in both directions and with no rotation. Where the surroundings are
# plain rows, columns or a thin strip they cannot pin the alignment down, and
# the best match found is a shear or a stretch that moves the fill tens of
# pixels. Looser limits correct a model that drifts more, but let more of those
# wrong alignments through; tighter ones leave a real drift uncorrected.
MAX_REGISTER_ZOOM = 0.04  # zoom may differ from 1 by this much
MAX_REGISTER_UNEVEN = 0.03  # shear, rotation or uneven zoom beyond this: the fit is not a redraw's drift at all
MAX_REGISTER_MOVE_FRAC = 0.04  # no corner may move further than this share of the longer side
MIN_REGISTER_MOVE_PX = 0.5  # below this there is nothing worth correcting


def _zoom_and_shift(warp: np.ndarray, w: int, h: int) -> np.ndarray | None:
    """The even-zoom-plus-shift part of a fitted affine warp, or None.

    The fit has six numbers but a redraw's drift has three: one zoom and a
    shift in x and y. On surroundings with little detail the other three
    (shear, rotation, a different zoom across and down) are fitted to noise.
    Keeping only the zoom and the shift, measured at the centre of the image,
    still undoes a real drift and can never shear the picture. None means the
    fit is too far from a plain zoom and shift to trust, too large to be a
    drift, or too small to matter.
    """
    m = warp.astype(np.float64)
    a, b, c, d = m[0, 0], m[0, 1], m[1, 0], m[1, 1]
    zoom = (a + d) / 2
    if max(abs(b), abs(c), abs(a - d)) > MAX_REGISTER_UNEVEN or abs(zoom - 1) > MAX_REGISTER_ZOOM:
        return None
    centre = np.float64([w / 2, h / 2])
    shift = m[:, :2] @ centre + m[:, 2] - zoom * centre  # so the centre moves exactly as the fit moved it
    simple = np.float64([[zoom, 0, shift[0]], [0, zoom, shift[1]]])
    corners = np.float64([[0, 0, 1], [w, 0, 1], [0, h, 1], [w, h, 1]]).T
    moved = float(np.linalg.norm(simple @ corners - corners[:2], axis=0).max())
    if moved > MAX_REGISTER_MOVE_FRAC * max(w, h) or moved < MIN_REGISTER_MOVE_PX:
        return None
    return simple.astype(np.float32)


def register(generated: Image.Image, original: Image.Image, mask: np.ndarray) -> Image.Image:
    """Line a generated image up with the original before pasting part of it in.

    An edit model that takes no mask redraws the whole picture, and what comes
    back is typically zoomed by a percent or so and shifted a few pixels. Pasted
    in as it is, the new element lands off its slot. The pixels outside the mask
    show the same content in both images, so they are used to find the small
    shift/zoom between the two, which is then undone. Only the even zoom and
    the shift of the fitted alignment are applied (see _zoom_and_shift). If no
    usable alignment is found, or it does not make the surroundings match
    better, the image is returned unchanged.
    """
    ref_rgb, gen_rgb = np.asarray(to_rgb(original)), np.asarray(to_rgb(generated))
    ref = cv2.cvtColor(ref_rgb, cv2.COLOR_RGB2GRAY).astype(np.float32)
    gen = cv2.cvtColor(gen_rgb, cv2.COLOR_RGB2GRAY).astype(np.float32)
    # Stay clear of the region being replaced: its content differs on purpose.
    outside = (cv2.dilate(mask, np.ones((31, 31), np.uint8)) == 0).astype(np.uint8)
    if outside.mean() < 0.05:
        return generated
    warp = np.eye(2, 3, dtype=np.float32)
    criteria = (cv2.TERM_CRITERIA_EPS | cv2.TERM_CRITERIA_COUNT, 200, 1e-6)
    try:
        _, warp = cv2.findTransformECC(ref, gen, warp, cv2.MOTION_AFFINE, criteria, outside * 255, 5)
    except cv2.error:
        return generated
    h, w = ref.shape
    warp = _zoom_and_shift(warp, w, h)
    if warp is None:
        return generated
    aligned = cv2.warpAffine(gen_rgb, warp, (w, h), flags=cv2.INTER_LINEAR + cv2.WARP_INVERSE_MAP, borderMode=cv2.BORDER_REPLICATE)
    keep = outside > 0
    before = np.abs(gen - ref)[keep].mean()
    after = np.abs(cv2.cvtColor(aligned, cv2.COLOR_RGB2GRAY).astype(np.float32) - ref)[keep].mean()
    return Image.fromarray(aligned) if after < before else generated


def composite(original: Image.Image, generated: Image.Image, mask: np.ndarray) -> Image.Image:
    """Generated pixels inside the mask, original pixels everywhere else."""
    out = original.copy()
    out.paste(generated, mask=Image.fromarray(mask))
    return out


def blend(original: Image.Image, generated: Image.Image, mask: np.ndarray) -> Image.Image:
    """Seamless (Poisson) blend of the generated region into the original.

    Poisson blending keeps the generated region's detail but shifts its colors
    so they meet the surroundings exactly at the boundary. OpenCV's version
    cannot handle a mask that touches the image border, so the image is padded
    first. It also solves over the mask's whole bounding box and so disturbs
    pixels outside an irregular (brush-drawn) mask; only the masked pixels of
    its result are kept. For such a mask that can leave a faint color step
    along its edge, which is the price of never touching pixels outside it.
    """
    pad = 8
    base = np.asarray(to_rgb(original))
    dst = cv2.copyMakeBorder(base, pad, pad, pad, pad, cv2.BORDER_REFLECT)
    src = cv2.copyMakeBorder(np.asarray(to_rgb(generated)), pad, pad, pad, pad, cv2.BORDER_REFLECT)
    m = cv2.copyMakeBorder(mask, pad, pad, pad, pad, cv2.BORDER_CONSTANT, value=0)
    x, y, w, h = cv2.boundingRect(m)
    if w < 3 or h < 3:  # too small for the solver; nothing to blend anyway
        return composite(original, generated, mask)
    # seamlessClone places the mask's bounding box centred on this point.
    center = (x + w // 2, y + h // 2)
    try:
        cloned = cv2.seamlessClone(src, dst, m, center, cv2.NORMAL_CLONE)[pad:-pad, pad:-pad]
    except cv2.error:
        return composite(original, generated, mask)
    out = base.copy()
    out[mask > 0] = cloned[mask > 0]
    return Image.fromarray(out)


def seam_score(image: Image.Image, mask: np.ndarray) -> float:
    """How invisible the mask boundary is, 0..1 (1 = no visible seam).

    Measures the brightness/color step right on the boundary line and compares
    it with how busy the image is just outside. A fill whose content is cut off
    by the mask edge, or whose colors do not meet the surroundings, scores low.
    """
    lab = cv2.cvtColor(np.asarray(to_rgb(image)), cv2.COLOR_RGB2Lab).astype(np.float32)
    gx, gy = cv2.Sobel(lab, cv2.CV_32F, 1, 0, ksize=3), cv2.Sobel(lab, cv2.CV_32F, 0, 1, ksize=3)
    grad = np.sqrt((gx**2 + gy**2).sum(axis=2)) / 8.0  # about "levels of change per pixel"
    kernel = np.ones((3, 3), np.uint8)
    boundary = (cv2.dilate(mask, kernel) > 0) & (cv2.erode(mask, kernel) == 0)
    outside = (cv2.dilate(mask, np.ones((25, 25), np.uint8)) > 0) & (cv2.dilate(mask, np.ones((7, 7), np.uint8)) == 0)
    if not boundary.any():
        return 1.0
    on_seam = float(grad[boundary].mean())
    nearby = float(grad[outside].mean()) if outside.any() else 0.0
    return float(np.exp(-max(0.0, on_seam - nearby) / 6.0))


def _crop_to_mask(img: Image.Image, mask: np.ndarray) -> Image.Image:
    x, y, w, h = cv2.boundingRect(mask)
    return img.crop((x, y, x + w, y + h))


@dataclass
class Fill:
    image: Image.Image  # blended into the design
    raw: Image.Image  # the generator's pixels pasted in with no blending
    scores: dict[str, float]
    total: float


def fill(
    img: Image.Image,
    mask: np.ndarray,
    prompt: str,
    *,
    n: int = 4,
    references: list[tuple[int, int, int, int]] | None = None,
    fresh: bool = False,
) -> list[Fill]:
    """Generate n fills for the masked region and return them best first.

    references are boxes (x, y, w, h) of existing elements the fill should
    resemble, such as the sibling cards of a missing card. Without them the
    fill is compared with the area around it.
    """
    from ..critic import embeddings
    from ..critic.scoring import weighted_total
    from ..providers import generation

    img = to_rgb(img)
    x0, y0, x1, y1 = context_box(mask)
    crop, crop_mask = img.crop((x0, y0, x1, y1)), mask[y0:y1, x0:x1]
    gen_size = _generation_size(crop.width, crop.height)
    gen_mask = cv2.resize(crop_mask, gen_size, interpolation=cv2.INTER_NEAREST)
    outputs = generation.inpaint(crop.resize(gen_size, Image.LANCZOS), gen_mask, prompt, n=n, fresh=fresh)

    # Ignore reference boxes that are empty or fall outside the image.
    boxes = [(max(0, x), max(0, y), min(img.width, x + w), min(img.height, y + h)) for x, y, w, h in references or []]
    boxes = [b for b in boxes if b[2] - b[0] >= 8 and b[3] - b[1] >= 8]
    if boxes:
        targets = [embeddings.image_embedding(img.crop(b)) for b in boxes]
    else:
        targets = [embeddings.image_embedding(crop)]

    fills = []
    for out in outputs:
        generated = img.copy()
        generated.paste(register(out.resize(crop.size, Image.LANCZOS), crop, crop_mask), (x0, y0))
        raw = composite(img, generated, mask)
        blended = blend(img, generated, mask)
        patch = _crop_to_mask(blended, mask)
        patch_embedding = embeddings.image_embedding(patch)
        style = float(np.mean([max(0.0, embeddings.cosine(patch_embedding, t)) for t in targets]))
        # CLIP text-image cosines sit in roughly 0.15..0.35; stretch that to 0..1.
        intent = float(np.clip((embeddings.text_image_similarity(prompt, patch) - 0.15) / 0.2, 0.0, 1.0))
        scores = {"style": style, "seam": seam_score(raw, mask), "intent": intent}
        fills.append(Fill(blended, raw, scores, weighted_total(scores, SCORE_WEIGHTS)))
    return sorted(fills, key=lambda f: -f.total)
