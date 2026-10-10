"""Draw synthetic design mockups with known missing regions.

Run from backend/:  .venv/bin/python -m scripts.make_mockups
Output: proofs/autocomplete/inputs/<name>.png and truth.json, which maps each
design to the boxes [x, y, w, h] a gap detector should find (empty list for
the complete control designs).
"""

import json
from pathlib import Path

from PIL import Image, ImageDraw, ImageFilter, ImageFont
from skimage import data

OUT = Path(__file__).resolve().parents[2] / "proofs" / "autocomplete" / "inputs"

W, H = 1200, 800


def font(size: int) -> ImageFont.FreeTypeFont:
    return ImageFont.load_default(size=size)


def _lines(d: ImageDraw.ImageDraw, x: int, y: int, widths: list[int], color, gap: int = 22, thick: int = 9) -> None:
    """Grey bars standing in for body text."""
    for i, w in enumerate(widths):
        d.rounded_rectangle((x, y + i * gap, x + w, y + i * gap + thick), radius=4, fill=color)


def _pricing_card(d: ImageDraw.ImageDraw, box, name: str, price: str, accent) -> None:
    x, y, w, h = box
    d.rounded_rectangle((x, y, x + w, y + h), radius=18, fill=(255, 255, 255), outline=(222, 226, 235), width=2)
    d.rounded_rectangle((x + 24, y + 24, x + 24 + 90, y + 24 + 28), radius=14, fill=accent)
    d.text((x + 24, y + 70), name, font=font(30), fill=(25, 30, 45))
    d.text((x + 24, y + 116), price, font=font(54), fill=(25, 30, 45))
    _lines(d, x + 24, y + 200, [w - 80, w - 120, w - 60, w - 140], (200, 205, 216))
    d.rounded_rectangle((x + 24, y + h - 76, x + w - 24, y + h - 28), radius=12, fill=accent)


def pricing(present: tuple[bool, bool, bool]):
    img = Image.new("RGB", (W, H), (244, 246, 251))
    d = ImageDraw.Draw(img)
    d.rectangle((0, 0, W, 76), fill=(22, 27, 45))
    d.text((40, 24), "northwind", font=font(26), fill=(255, 255, 255))
    _lines(d, 820, 32, [70], (130, 138, 165), thick=10)
    _lines(d, 920, 32, [70], (130, 138, 165), thick=10)
    _lines(d, 1020, 32, [110], (255, 190, 70), thick=10)
    d.text((W // 2 - 190, 116), "Simple pricing", font=font(52), fill=(22, 27, 45))
    _lines(d, W // 2 - 220, 190, [440], (170, 176, 192), thick=10)
    cw, ch, gap = 320, 440, 40
    x0 = (W - (3 * cw + 2 * gap)) // 2
    cards = [(x0 + i * (cw + gap), 260, cw, ch) for i in range(3)]
    spec = [("Starter", "$9", (96, 165, 250)), ("Team", "$29", (129, 140, 248)), ("Scale", "$99", (244, 114, 182))]
    for box, (name, price, accent), show in zip(cards, spec, present):
        if show:
            _pricing_card(d, box, name, price, accent)
    return img, [list(b) for b, show in zip(cards, present) if not show]


def features(missing: int | None):
    img = Image.new("RGB", (W, H), (16, 20, 34))
    d = ImageDraw.Draw(img)
    d.text((60, 70), "Everything you need", font=font(50), fill=(240, 244, 255))
    _lines(d, 60, 150, [520, 400], (95, 104, 135), thick=10)
    tw, th, gap = 240, 300, 40
    x0 = (W - (4 * tw + 3 * gap)) // 2
    tiles = [(x0 + i * (tw + gap), 300, tw, th) for i in range(4)]
    accents = [(52, 211, 153), (250, 204, 21), (96, 165, 250), (248, 113, 113)]
    for i, (x, y, w, h) in enumerate(tiles):
        if i == missing:
            continue
        d.rounded_rectangle((x, y, x + w, y + h), radius=20, fill=(30, 36, 58))
        d.ellipse((x + 28, y + 30, x + 28 + 64, y + 30 + 64), fill=accents[i])
        d.text((x + 28, y + 122), ["Fast", "Secure", "Synced", "Open"][i], font=font(28), fill=(240, 244, 255))
        _lines(d, x + 28, y + 176, [w - 60, w - 90, w - 110], (88, 97, 128))
    d.rounded_rectangle((60, 670, 300, 730), radius=14, fill=(99, 102, 241))
    d.text((104, 684), "Get started", font=font(24), fill=(255, 255, 255))
    return img, ([list(tiles[missing])] if missing is not None else [])


def gallery(missing: tuple[int, int] | None):
    img = Image.new("RGB", (W, H), (250, 248, 244))
    d = ImageDraw.Draw(img)
    d.text((60, 36), "Field notes", font=font(44), fill=(40, 34, 28))
    photos = [data.astronaut(), data.coffee(), data.chelsea(), data.rocket(), data.cat(), data.coffee()[:, ::-1],
              data.astronaut()[:, ::-1], data.chelsea()[::-1], data.rocket()[:, ::-1]]
    cw, ch, gap = 340, 200, 30
    x0, y0 = (W - (3 * cw + 2 * gap)) // 2, 120
    truth = []
    for r in range(3):
        for c in range(3):
            box = (x0 + c * (cw + gap), y0 + r * (ch + gap), cw, ch)
            if (r, c) == missing:
                truth.append(list(box))
                continue
            photo = Image.fromarray(photos[r * 3 + c]).convert("RGB")
            # centre-crop to the cell's aspect ratio
            pw, ph = photo.size
            target = cw / ch
            if pw / ph > target:
                nw = int(ph * target)
                photo = photo.crop(((pw - nw) // 2, 0, (pw - nw) // 2 + nw, ph))
            else:
                nh = int(pw / target)
                photo = photo.crop((0, (ph - nh) // 2, pw, (ph - nh) // 2 + nh))
            img.paste(photo.resize((cw, ch), Image.LANCZOS), box[:2])
    return img, truth


def banner(placeholder: bool):
    img = Image.new("RGB", (W, 600), (255, 244, 230))
    d = ImageDraw.Draw(img)
    for i in range(600):  # soft vertical gradient
        d.line((0, i, W, i), fill=(255, 244 - i // 30, 230 - i // 12))
    d.text((70, 150), "Summer", font=font(96), fill=(60, 30, 20))
    d.text((70, 260), "roast is here", font=font(64), fill=(120, 60, 30))
    _lines(d, 74, 360, [420, 360], (190, 150, 120), thick=10)
    d.rounded_rectangle((70, 440, 290, 504), radius=32, fill=(190, 70, 40))
    d.text((112, 456), "Order now", font=font(26), fill=(255, 255, 255))
    box = (680, 90, 440, 420)
    if placeholder:
        x, y, w, h = box
        d.rounded_rectangle((x, y, x + w, y + h), radius=24, fill=(236, 236, 236), outline=(200, 200, 200), width=3)
    else:
        photo = Image.fromarray(data.coffee()).resize((box[2], box[3]), Image.LANCZOS)
        img.paste(photo, box[:2])
    return img, ([list(box)] if placeholder else [])


def shadow_cards(missing: int | None):
    """Cards with soft drop shadows on a gradient: no crisp outline to follow."""
    img = Image.new("RGB", (W, H))
    d = ImageDraw.Draw(img)
    for i in range(H):
        d.line((0, i, W, i), fill=(226 - i // 20, 236 - i // 16, 255 - i // 40))
    d.text((80, 70), "Our plans", font=font(56), fill=(20, 30, 70))
    cw, ch, gap = 300, 400, 60
    x0 = (W - (3 * cw + 2 * gap)) // 2
    cards = [(x0 + i * (cw + gap), 240, cw, ch) for i in range(3)]
    shadow = Image.new("L", (W, H), 0)
    sd = ImageDraw.Draw(shadow)
    for i, (x, y, w, h) in enumerate(cards):
        if i != missing:
            sd.rounded_rectangle((x + 4, y + 18, x + w + 4, y + h + 18), radius=24, fill=110)
    img.paste((30, 40, 90), mask=shadow.filter(ImageFilter.GaussianBlur(18)))
    d = ImageDraw.Draw(img)
    for i, (x, y, w, h) in enumerate(cards):
        if i == missing:
            continue
        d.rounded_rectangle((x, y, x + w, y + h), radius=24, fill=(255, 255, 255))
        d.text((x + 28, y + 30), ["Solo", "Studio", "Agency"][i], font=font(32), fill=(20, 30, 70))
        d.text((x + 28, y + 84), ["$12", "$40", "$120"][i], font=font(60), fill=(60, 80, 220))
        _lines(d, x + 28, y + 180, [w - 70, w - 110, w - 90], (205, 210, 225))
        d.rounded_rectangle((x + 28, y + h - 80, x + w - 28, y + h - 30), radius=25, fill=(60, 80, 220))
    return img, ([list(cards[missing])] if missing is not None else [])


def photo_hero(missing: int | None):
    """Cards laid over a full-bleed photo: there is no flat background at all."""
    photo = Image.fromarray(data.rocket()).convert("RGB").resize((W, H), Image.LANCZOS)
    img = Image.blend(photo, Image.new("RGB", (W, H), (10, 14, 30)), 0.35)
    d = ImageDraw.Draw(img)
    d.text((80, 80), "Launch week", font=font(72), fill=(255, 255, 255))
    cw, ch, gap = 300, 260, 60
    x0 = (W - (3 * cw + 2 * gap)) // 2
    cards = [(x0 + i * (cw + gap), 440, cw, ch) for i in range(3)]
    for i, (x, y, w, h) in enumerate(cards):
        if i == missing:
            continue
        d.rounded_rectangle((x, y, x + w, y + h), radius=22, fill=(255, 255, 255))
        d.ellipse((x + 26, y + 26, x + 26 + 56, y + 26 + 56), fill=[(250, 120, 60), (60, 160, 250), (120, 200, 90)][i])
        d.text((x + 26, y + 104), ["Mon", "Wed", "Fri"][i], font=font(34), fill=(20, 24, 40))
        _lines(d, x + 26, y + 164, [w - 60, w - 100], (200, 204, 214))
    return img, ([list(cards[missing])] if missing is not None else [])


DESIGNS = {
    "pricing_missing_right": lambda: pricing((True, True, False)),
    "pricing_missing_middle": lambda: pricing((True, False, True)),
    "pricing_complete": lambda: pricing((True, True, True)),
    "features_missing_third": lambda: features(2),
    "features_complete": lambda: features(None),
    "gallery_missing_cell": lambda: gallery((1, 2)),
    "banner_empty_placeholder": lambda: banner(True),
    "banner_complete": lambda: banner(False),
    "shadow_cards_missing_middle": lambda: shadow_cards(1),
    "shadow_cards_complete": lambda: shadow_cards(None),
    "photo_hero_missing_right": lambda: photo_hero(2),
    "photo_hero_complete": lambda: photo_hero(None),
}


if __name__ == "__main__":
    OUT.mkdir(parents=True, exist_ok=True)
    truth = {}
    for name, make in DESIGNS.items():
        img, boxes = make()
        img.save(OUT / f"{name}.png")
        truth[name] = boxes
    (OUT / "truth.json").write_text(json.dumps(truth, indent=2))
    print(f"wrote {len(truth)} designs to {OUT}")
