"""Designs for testing the gap detector on layouts its author did not draw.

A compact port of an independent reviewer's designs: one per way the detector
used to go wrong, plus the complete designs it must stay quiet on. Each
function returns (image, true gaps as [x, y, w, h]); an empty list means
nothing is missing. Text is drawn as bars so the images do not depend on fonts.
"""

import io

from PIL import Image, ImageDraw

SS = 2  # drawn at twice the size and reduced, for the soft edges of a real export

WHITE = (255, 255, 255)
G50, G100, G200, G300, G400, G500 = (249, 250, 251), (243, 244, 246), (229, 231, 235), (209, 213, 219), (156, 163, 175), (107, 114, 128)
G700, G900, NAVY = (55, 65, 81), (17, 24, 39), (15, 23, 42)
ACCENTS = [(79, 70, 229), (16, 185, 129), (245, 158, 11), (244, 63, 94), (59, 130, 246), (139, 92, 246), (20, 184, 166)]
TINTS = [(219, 234, 254), (220, 252, 231), (254, 243, 199), (255, 228, 230), (237, 233, 254), (204, 251, 241)]


class Page:
    def __init__(self, w: int, h: int, bg):
        self.im = Image.new("RGB", (w * SS, h * SS), bg)
        self.d = ImageDraw.Draw(self.im)

    def box(self, x, y, w, h, fill=None, outline=None, r=0, bw=1):
        self.d.rounded_rectangle((x * SS, y * SS, (x + w) * SS - 1, (y + h) * SS - 1), radius=r * SS, fill=fill, outline=outline, width=bw * SS)

    def oval(self, x, y, w, h, fill):
        self.d.ellipse((x * SS, y * SS, (x + w) * SS - 1, (y + h) * SS - 1), fill=fill)

    def line(self, x0, y0, x1, y1, fill, bw=1):
        self.d.line((x0 * SS, y0 * SS, x1 * SS, y1 * SS), fill=fill, width=bw * SS)

    def bars(self, x, y, widths, color=G300, gap=18, thick=8):
        """Rounded bars standing in for lines of text."""
        for i, w in enumerate(widths):
            self.box(x, y + i * gap, w, thick, fill=color, r=thick // 2)

    def render(self) -> Image.Image:
        return self.im.reduce(SS)


def _card(p: Page, x, y, w, h, i=0, fill=WHITE, outline=G200, text=G300):
    p.box(x, y, w, h, fill=fill, outline=outline, r=12)
    p.box(x + 16, y + 16, 36, 36, fill=ACCENTS[i % 7], r=8)
    p.bars(x + 16, y + 66, [w - 48, w - 80][: 1 + (h > 100)], text)


def _as_jpeg(img: Image.Image) -> Image.Image:
    buf = io.BytesIO()
    img.save(buf, "JPEG", quality=80)  # Pillow's default 4:2:0 colour subsampling
    return Image.open(io.BytesIO(buf.getvalue())).convert("RGB")


# --- complete designs: nothing may be reported ----------------------------------


def toolbar_left_aligned_complete():
    """Three navigation chips next to the logo, left-aligned in a wide top bar."""
    p = Page(1200, 800, WHITE)
    p.line(0, 72, 1200, 72, G200)
    p.box(32, 24, 24, 24, fill=G900, r=6)
    p.bars(68, 30, [120], G900, thick=12)
    for i in range(3):
        p.box(240 + i * 122, 14, 110, 44, fill=G900 if i == 0 else WHITE, outline=None if i == 0 else G300, r=22)
        p.bars(240 + i * 122 + 28, 32, [54], WHITE if i == 0 else G700)
    p.oval(1128, 16, 40, 40, fill=ACCENTS[6])
    p.bars(64, 128, [520], G900, thick=26)
    p.bars(64, 180, [700, 660, 690, 610, 680, 540, 670, 630, 420], gap=24)
    p.box(64, 440, 148, 44, fill=ACCENTS[0], r=8)
    p.bars(64, 540, [1040, 980, 1010, 900], gap=24)
    return p.render(), []


def settings_form_complete():
    """A settings form in a centred card; Cancel and Save sit right-aligned at the bottom."""
    p = Page(1200, 800, G100)
    px, py, pw, ph = 240, 80, 720, 640
    p.box(px, py, pw, ph, fill=WHITE, outline=G200, r=16)
    p.bars(px + 32, py + 30, [220], G900, thick=20)
    p.bars(px + 32, py + 66, [380], G400)
    for i in range(3):
        y = py + 96 + i * 88
        p.bars(px + 32, y + 2, [70], G700)
        p.box(px + 32, y + 24, 656, 44, fill=WHITE, outline=G300, r=8)
        p.bars(px + 48, y + 42, [150 + 40 * i], G900)
    y = py + 96 + 3 * 88
    p.bars(px + 32, y + 2, [36], G700)
    p.box(px + 32, y + 24, 656, 96, fill=WHITE, outline=G300, r=8)
    p.bars(px + 48, y + 42, [330, 160], G900, gap=22)
    by = py + ph - 32 - 44
    p.box(px + pw - 152, by, 120, 44, fill=ACCENTS[0], r=8)
    p.bars(px + pw - 114, by + 18, [44], WHITE)
    p.box(px + pw - 284, by, 120, 44, fill=WHITE, outline=G300, r=8)
    p.bars(px + pw - 252, by + 18, [56], G700)
    return p.render(), []


def team_grid_short_last_row_complete():
    """Six people in a four-column grid: the second row holds two, and that is all of them."""
    p = Page(1200, 800, WHITE)
    p.bars(470, 56, [260], G900, thick=24)
    p.bars(500, 100, [200], G400)
    for i in range(6):
        x, y = 64 + (i % 4) * 274, 152 + (i // 4) * 304
        p.box(x, y, 250, 280, fill=G100, r=16)
        p.oval(x + 85, y + 32, 80, 80, fill=ACCENTS[i])
        p.bars(x + 65, y + 140, [120], G900, thick=12)
        p.bars(x + 85, y + 168, [80], G500)
        p.bars(x + 45, y + 204, [160])
        p.bars(x + 65, y + 222, [120])
    return p.render(), []


def ragged_board_complete():
    """A board without lane backgrounds: columns of 3, 2, 4 and 1 same-sized cards."""
    p = Page(1440, 900, WHITE)
    p.line(0, 64, 1440, 64, G200)
    p.bars(32, 26, [120], G900, thick=14)
    k = 0
    for i, n in enumerate([3, 2, 4, 1]):
        x = 48 + i * 344
        p.box(x, 104, 10, 10, fill=ACCENTS[i], r=5)
        p.bars(x + 20, 104, [90], G900, thick=10)
        for j in range(n):
            y = 140 + j * 124
            p.box(x, y, 320, 108, fill=WHITE, outline=G200, r=10)
            p.bars(x + 16, y + 18, [170], G900, thick=10)
            p.bars(x + 16, y + 46, [250, 190], gap=16)
            p.box(x + 16, y + 80, 56, 16, fill=G100, r=8)
            p.oval(x + 284, y + 74, 24, 24, fill=ACCENTS[(k + 2) % 7])
            k += 1
    return p.render(), []


def colour_swatches_complete():
    """A brand-colour page: five solid swatches with their names underneath."""
    p = Page(1200, 800, WHITE)
    p.bars(64, 60, [260], G900, thick=24)
    p.bars(64, 104, [300], G400)
    for i, colour in enumerate([ACCENTS[0], NAVY, ACCENTS[6], ACCENTS[2], ACCENTS[3]]):
        x = 64 + i * 218
        p.box(x, 152, 200, 168, fill=colour, r=12)
        p.bars(x, 338, [90], G900, thick=10)
        p.bars(x, 362, [60], G400)
    p.bars(64, 440, [220], G900, thick=24)
    p.bars(64, 510, [560], G900, thick=40)
    p.bars(64, 590, [380], G900, thick=22)
    p.bars(64, 640, [520, 480], G500, gap=30)
    return p.render(), []


def left_flowed_row_complete():
    """Three cards flowed from the left margin of a four-column page grid."""
    p = Page(1200, 800, G100)
    p.bars(64, 100, [160], G900, thick=18)
    for i in range(3):
        _card(p, 64 + i * 274, 144, 250, 200, i)
    p.bars(64, 388, [140], G900, thick=18)
    p.box(64, 432, 1072, 320, fill=WHITE, outline=G200, r=12)
    for i in range(5):
        y = 448 + i * 60
        p.box(88, y + 8, 28, 28, fill=ACCENTS[i], r=6)
        p.bars(132, y + 18, [150 + 20 * (i % 3)], G900)
        p.bars(1000, y + 18, [60], G400)
    return p.render(), []


# --- designs with something missing ---------------------------------------------


def dialog_grid_missing():
    """A dialog with a subtitle, a search field, filter tabs and a 3x2 grid of templates; the bottom-middle one is missing."""
    p = Page(1200, 800, G500)
    px, py, pw, ph = 220, 80, 760, 660
    p.box(px, py, pw, ph, fill=WHITE, r=20)
    p.bars(px + 40, py + 34, [230], G900, thick=20)
    p.bars(px + 40, py + 72, [470], G400)
    p.box(px + 40, py + 104, 680, 40, fill=WHITE, outline=G300, r=8)
    p.bars(px + 56, py + 120, [120], G400)
    for i in range(6):  # filter tabs
        p.bars(px + 40 + i * 92, py + 153, [64], ACCENTS[0] if i == 0 else G400)
    p.line(px, py + ph - 100, px + pw, py + ph - 100, G200)
    truth = []
    for k in range(6):
        x, y = px + 40 + (k % 3) * 240, py + 168 + (k // 3) * 208
        if k == 4:
            truth.append([x, y, 200, 184])
            continue
        p.box(x, y, 200, 184, fill=G50, outline=G200, r=12)
        p.box(x + 12, y + 12, 176, 112, fill=TINTS[k], r=8)
        p.box(x + 28, y + 28, 60, 10, fill=ACCENTS[k], r=5)
        p.bars(x + 28, y + 52, [140, 100], WHITE, gap=16)
        p.bars(x + 12, y + 146, [80], G900, thick=10)
    p.box(px + pw - 160, py + ph - 76, 120, 44, fill=ACCENTS[0], r=8)
    p.bars(px + pw - 130, py + ph - 58, [60], WHITE)
    p.bars(px + pw - 250, py + ph - 58, [56], G700)
    return p.render(), truth


def small_widget_grid_missing():
    """A dashboard widget an eighth of the page in size, holding a 2x2 grid of tiles; the last tile is missing."""
    p = Page(1440, 900, G100)
    p.box(0, 0, 240, 900, fill=WHITE)
    p.line(240, 0, 240, 900, G200)
    p.bars(24, 28, [110], G900, thick=14)
    p.bars(24, 96, [150, 120, 140, 100, 130], G400, gap=40, thick=10)
    p.bars(272, 44, [90], G900, thick=22)
    for i in range(4):
        x = 272 + i * 290
        p.box(x, 104, 266, 120, fill=WHITE, outline=G200, r=12)
        p.bars(x + 20, 124, [70], G400)
        p.bars(x + 20, 150, [110], G900, thick=22)
        p.bars(x + 20, 196, [44], ACCENTS[1 + 2 * (i % 2)])
    px, py = 272, 248
    p.box(px, py, 556, 304, fill=WHITE, outline=G200, r=12)
    p.bars(px + 24, py + 24, [120], G900, thick=12)
    truth = []
    for i in range(4):
        x, y = px + 24 + (i % 2) * 262, py + 64 + (i // 2) * 116
        if i == 3:
            truth.append([x, y, 246, 100])
            continue
        p.box(x, y, 246, 100, fill=G50, outline=G200, r=10)
        p.box(x + 16, y + 16, 36, 36, fill=ACCENTS[i], r=8)
        p.bars(x + 16, y + 70, [100], G900)
    p.box(852, 248, 556, 304, fill=WHITE, outline=G200, r=12)
    for i in range(4):
        y = 272 + i * 64
        p.oval(876, y, 36, 36, fill=ACCENTS[i + 2])
        p.bars(928, y + 6, [220], G900)
        p.bars(928, y + 24, [320])
    p.box(272, 576, 1136, 292, fill=WHITE, outline=G200, r=12)
    p.bars(296, 600, [140], G900, thick=12)
    for i in range(4):
        p.line(296, 660 + i * 50, 1384, 660 + i * 50, G200)
    return p.render(), truth


def small_icon_grid_missing():
    """A 6x3 grid of 56 px round icons on a 1440x900 page; one is missing."""
    p = Page(1440, 900, G50)
    p.bars(540, 76, [360], G900, thick=26)
    p.bars(590, 126, [260], G400)
    truth = []
    for i in range(18):
        x, y = 372 + (i % 6) * 128, 216 + (i // 6) * 152
        if i == 8:
            truth.append([x, y, 56, 56])
            continue
        p.oval(x, y, 56, 56, fill=ACCENTS[i % 7])
        p.box(x + 19, y + 19, 18, 18, fill=WHITE, r=5)
        p.bars(x + 6, y + 72, [44], G500)
    p.box(640, 700, 160, 48, fill=ACCENTS[0], r=10)
    return p.render(), truth


def jpeg_icon_grid_missing():
    """A 5x3 grid of saturated round icons, exported as a JPEG; one in the middle row is missing."""
    p = Page(1200, 800, G50)
    p.bars(480, 60, [240], G900, thick=24)
    truth = []
    for i in range(15):
        x, y = 240 + (i % 5) * 160, 168 + (i // 5) * 184
        if i == 8:
            truth.append([x, y, 80, 80])
            continue
        p.oval(x, y, 80, 80, fill=ACCENTS[i % 7])
        p.box(x + 28, y + 28, 24, 24, fill=WHITE, r=6)
        p.bars(x + 14, y + 100, [52], G500)
    return _as_jpeg(p.render()), truth


def dot_grid_missing():
    """Four notes on a whiteboard dot grid (a 2 px dot every 24 px); the third is missing."""
    p = Page(1200, 800, (248, 250, 252))
    for y in range(12, 800, 24):
        for x in range(12, 1200, 24):
            p.box(x, y, 2, 2, fill=(148, 163, 184))
    p.bars(64, 70, [200], NAVY, thick=22)
    truth = []
    for i in range(4):
        x = 64 + i * 274
        if i == 2:
            truth.append([x, 200, 250, 320])
            continue
        p.box(x, 200, 250, 320, fill=[(254, 249, 195), (220, 252, 231), None, (255, 228, 230)][i], r=6)
        p.bars(x + 20, 226, [110], NAVY, thick=12)
        p.bars(x + 20, 268, [200, 180, 210, 160, 190, 140], (148, 163, 184), gap=24)
    return p.render(), truth


def dashed_placeholder():
    """A product page whose image slot is an empty box with a dashed outline."""
    p = Page(1200, 800, WHITE)
    p.line(0, 64, 1200, 64, G200)
    p.bars(32, 26, [100], G900, thick=14)
    x, y, w, h = 64, 128, 520, 560
    p.box(x, y, w, h, fill=G50, r=16)
    for xx in range(x + 16, x + w - 16, 18):
        p.line(xx, y, min(xx + 10, x + w - 16), y, G400, bw=2)
        p.line(xx, y + h - 1, min(xx + 10, x + w - 16), y + h - 1, G400, bw=2)
    for yy in range(y + 16, y + h - 16, 18):
        p.line(x, yy, x, min(yy + 10, y + h - 16), G400, bw=2)
        p.line(x + w - 1, yy, x + w - 1, min(yy + 10, y + h - 16), G400, bw=2)
    p.bars(648, 140, [400], G900, thick=28)
    p.bars(648, 196, [70], G900, thick=22)
    p.bars(648, 248, [460, 430, 448, 380, 440, 300], gap=24)
    for i in range(4):
        p.oval(648 + i * 48, 420, 34, 34, fill=[(120, 113, 108), (68, 64, 60), (214, 211, 209), (180, 83, 9)][i])
    p.box(648, 500, 220, 52, fill=G900, r=10)
    p.box(884, 500, 220, 52, fill=WHITE, outline=G300, r=10)
    p.bars(648, 600, [300, 260], gap=22)
    return p.render(), [[x, y, w, h]]


def dark_grid_missing_corner():
    """A dark 3x2 grid of feature tiles; the top-right one is missing."""
    p = Page(1200, 800, NAVY)
    p.bars(470, 70, [260], WHITE, thick=24)
    truth = []
    for k in range(6):
        x, y = 96 + (k % 3) * 344, 176 + (k // 3) * 284
        if k == 2:
            truth.append([x, y, 320, 260])
            continue
        _card(p, x, y, 320, 260, k, fill=(30, 41, 59), outline=None, text=(71, 85, 105))
    return p.render(), truth


def ruled_table_missing_cell():
    """A ruled comparison table with one blank cell."""
    p = Page(1200, 800, WHITE)
    p.bars(64, 100, [220], G900, thick=20)
    xs, y0, rh = [64, 416, 596, 776, 956, 1136], 152, 64
    p.box(64, y0, 1072, rh, fill=G100)
    truth = []
    for i in range(8):
        for j in range(5):
            if (i, j) == (4, 2):
                truth.append([xs[j], y0 + i * rh, xs[j + 1] - xs[j], rh])
                continue
            p.bars(xs[j] + 20, y0 + i * rh + 28, [120 if j == 0 else 40 + 8 * ((i + j) % 4)], G700 if i == 0 else G900)
    for i in range(9):
        p.line(64, y0 + i * rh, 1136, y0 + i * rh, G300)
    for x in xs:
        p.line(x, y0, x, y0 + 8 * rh, G300)
    return p.render(), truth


# --- side effects of the fixes above, found by a second reviewer ------------------


def dense_card_page_slot_holds_text_complete():
    """A page packed with an 8x6 grid of small cards; one cell holds three lines of loose text instead of a card."""
    p = Page(1200, 800, WHITE)
    for j in range(6):
        for i in range(8):
            x, y = 16 + i * 148, 12 + j * 132
            if (i, j) == (3, 2):
                p.bars(x + 10, y + 30, [90, 70, 100], G400, gap=22, thick=6)
                continue
            p.box(x, y, 136, 120, fill=WHITE, outline=G300, r=8)
            p.box(x + 10, y + 10, 28, 28, fill=ACCENTS[(i + j) % 7], r=6)
            p.bars(x + 10, y + 50, [110, 90, 100, 70], G400, gap=16, thick=6)
    return p.render(), []


def _pastel_cards():
    p = Page(1200, 800, G100)
    truth = []
    for i, x in enumerate((100, 440, 780)):
        if i == 1:
            truth.append([x, 250, 320, 300])
            continue
        p.box(x, 250, 320, 300, fill=(255, 228, 230), r=12)
        p.bars(x + 24, 290, [200, 160], G500)
    return p.render(), truth


def pastel_cards_missing():
    """Three borderless pale-rose cards on a light grey page; the middle one is missing."""
    return _pastel_cards()


def pastel_cards_jpeg_missing():
    """The same pastel cards exported as a JPEG."""
    img, truth = _pastel_cards()
    return _as_jpeg(img), truth


def jpeg_icon_grid_on_grey_missing():
    """A 5x3 grid of saturated round icons on a light grey page, as a JPEG whose 16 px colour squares do not line up with the grid."""
    p = Page(1200, 800, G100)
    truth = []
    for i in range(15):
        x, y = 203 + (i % 5) * 120, 157 + (i // 5) * 120
        if i == 7:
            truth.append([x, y, 72, 72])
            continue
        p.oval(x, y, 72, 72, fill=ACCENTS[i % 7])
    return _as_jpeg(p.render()), truth


def _card_grid(xs, ys, w, h, missing):
    p = Page(1200, 800, G100)
    truth = []
    for r, y in enumerate(ys):
        for c, x in enumerate(xs):
            if (r, c) in missing:
                truth.append([x, y, w, h])
            else:
                _card(p, x, y, w, h, i=r * len(xs) + c)
    return p.render(), truth


def off_centre_grid_missing_inside():
    """Two rows of cards in the first three columns of a four-column page grid; the middle card of the top row is missing."""
    return _card_grid([60, 335, 610], [100, 420], 255, 280, {(0, 1)})


def grid_missing_two_corners():
    """A centred 3x3 grid of cards with the top-left and bottom-right cards missing."""
    return _card_grid([140, 460, 780], [60, 300, 540], 280, 200, {(0, 0), (2, 2)})


def _card_and_empty_box(bg, card_fill, card_outline, **box):
    p = Page(1200, 800, bg)
    _card(p, 100, 200, 300, 300, fill=card_fill, outline=card_outline)
    p.box(600, 200, 400, 300, r=8, **box)
    return p.render(), [[600, 200, 400, 300]]


def light_placeholder_on_dark():
    """A dark page with one filled card and one empty white box."""
    return _card_and_empty_box(NAVY, (30, 41, 59), (51, 65, 85), fill=WHITE)


def mid_grey_placeholder_on_white():
    """A white page with one filled card and one empty mid-grey box."""
    return _card_and_empty_box(WHITE, WHITE, G200, fill=G400)


def thick_border_placeholder():
    """A white page with one filled card and one empty box with a 6 px dark border."""
    return _card_and_empty_box(WHITE, WHITE, G200, fill=WHITE, outline=G900, bw=6)


DESIGNS = {
    "toolbar_left_aligned_complete": toolbar_left_aligned_complete,
    "settings_form_complete": settings_form_complete,
    "team_grid_short_last_row_complete": team_grid_short_last_row_complete,
    "ragged_board_complete": ragged_board_complete,
    "colour_swatches_complete": colour_swatches_complete,
    "dialog_grid_missing": dialog_grid_missing,
    "small_widget_grid_missing": small_widget_grid_missing,
    "small_icon_grid_missing": small_icon_grid_missing,
    "jpeg_icon_grid_missing": jpeg_icon_grid_missing,
    "dot_grid_missing": dot_grid_missing,
    "dashed_placeholder": dashed_placeholder,
    "dark_grid_missing_corner": dark_grid_missing_corner,
    "left_flowed_row_complete": left_flowed_row_complete,
    "ruled_table_missing_cell": ruled_table_missing_cell,
    "dense_card_page_slot_holds_text_complete": dense_card_page_slot_holds_text_complete,
    "pastel_cards_missing": pastel_cards_missing,
    "pastel_cards_jpeg_missing": pastel_cards_jpeg_missing,
    "jpeg_icon_grid_on_grey_missing": jpeg_icon_grid_on_grey_missing,
    "off_centre_grid_missing_inside": off_centre_grid_missing_inside,
    "grid_missing_two_corners": grid_missing_two_corners,
    "light_placeholder_on_dark": light_placeholder_on_dark,
    "mid_grey_placeholder_on_white": mid_grey_placeholder_on_white,
    "thick_border_placeholder": thick_border_placeholder,
}

# Designs the detector still gets wrong, each with the reason.
KNOWN_LIMITS = {
    "left_flowed_row_complete": "three of four columns filled from the left looks exactly like a centred row of four missing its last card",
    "ruled_table_missing_cell": "cells that share borders are one connected shape, so no single cell is seen as a block",
    "pastel_cards_jpeg_missing": "JPEG halves colour resolution, which takes a pale tint's edge under the faint colour threshold",
    "off_centre_grid_missing_inside": "the hole is found, but the unused fourth column is reported too (same ambiguity as left_flowed_row_complete)",
    "mid_grey_placeholder_on_white": "an empty box much darker than the page cannot be told from a solid grey element",
}
