"""Gap detection, blending and seam scoring, checked on cases with known answers."""

import json
import time
from pathlib import Path

import cv2
import numpy as np
import pytest
from PIL import Image, ImageDraw

from app.ideas import autocomplete as A
from scripts.make_mockups import DESIGNS

from .designs_independent import DESIGNS as INDEPENDENT
from .designs_independent import KNOWN_LIMITS

W, H = 1200, 800


def _row(xs, y=300, w=200, h=250):
    return [A.Block(x, y, w, h) for x in xs]


def _canvas():
    return Image.new("RGB", (W, H), (240, 240, 240))


def _edges(blocks, extra=()):
    """An edge map where every block has content inside it and the page is otherwise blank."""
    edges = np.zeros((H, W), bool)
    for b in [*blocks, *extra]:
        edges[b.y + 10 : b.y1 - 10 : 6, b.x + 10 : b.x1 - 10] = True
    return edges


def _gaps(blocks, extra=()):
    return A.find_gaps(_canvas(), blocks, _edges(blocks, extra))


# --- pattern logic on bare boxes ------------------------------------------------


def test_missing_block_in_the_middle_of_a_row():
    gaps = _gaps(_row([60, 300, 780, 1020], w=180))  # pitch 240; the slot at 540 is missing
    assert [(g.x, g.y, g.w, g.h) for g in gaps] == [(540, 300, 180, 250)]
    assert gaps[0].confidence >= 0.9 and len(gaps[0].siblings) == 4 and gaps[0].kind == "pattern"


def test_missing_block_at_the_end_of_a_centred_row():
    # Three slots centred on the page (140, 500, 860 with pitch 360); the last is missing.
    gaps = _gaps(_row([140, 500]))
    assert [(g.x, g.y) for g in gaps] == [(860, 300)]
    assert 0.6 <= gaps[0].confidence < 0.9  # weaker evidence than a hole inside a row


def test_missing_block_at_the_start_of_a_centred_row():
    assert [(g.x, g.y) for g in _gaps(_row([500, 860]))] == [(140, 300)]


def test_two_blocks_with_room_for_exactly_one_between():
    gaps = _gaps(_row([110, 790], w=300))  # 380 px of space: one 300 px block with 40 px gutters
    assert [(g.x, g.y) for g in gaps] == [(450, 300)]
    assert 0.6 <= gaps[0].confidence < 0.9


def test_two_blocks_with_room_for_two_between():
    gaps = _gaps(_row([140, 860]))  # 520 px of space: two 200 px blocks with 40 px gutters
    assert sorted((g.x, g.y) for g in gaps) == [(380, 300), (620, 300)]


def test_two_adjacent_blocks_are_not_split_further():
    assert [g for g in _gaps(_row([380, 620])) if g.x in range(390, 610)] == []


def test_complete_centred_row_reports_nothing():
    assert _gaps(_row([140, 500, 860])) == []


def test_row_aligned_to_one_margin_reports_nothing():
    # A toolbar or a button row sits at one side on purpose: off-centre by several blocks, not short of them.
    assert _gaps(_row([60, 180, 300], y=40, w=100, h=44)) == []
    assert _gaps(_row([920, 1040], y=700, w=100, h=44)) == []


def test_last_row_short_by_one_is_reported_but_short_by_more_is_the_end_of_the_list():
    cells = [(x, y) for y in (100, 420) for x in (60, 340, 620, 900)]
    seven = _gaps([A.Block(x, y, 240, 280) for x, y in cells[:7]])
    assert [(g.x, g.y) for g in seven] == [(900, 420)] and 0.5 <= seven[0].confidence < 0.9
    assert _gaps([A.Block(x, y, 240, 280) for x, y in cells[:6]]) == []


def test_columns_of_unequal_length_are_not_a_grid_with_holes():
    board = [A.Block(60 + 280 * col, 100 + 130 * row, 250, 110) for col, n in enumerate([3, 2, 4, 1]) for row in range(n)]
    assert _gaps(board) == []


def test_single_block_and_mismatched_sizes_report_nothing():
    assert _gaps(_row([140])) == []
    assert _gaps([A.Block(140, 300, 200, 250), A.Block(500, 300, 320, 120)]) == []


def test_missing_cell_in_a_grid():
    blocks = [A.Block(x, y, 300, 180) for y in (100, 320, 540) for x in (100, 450, 800) if (x, y) != (800, 320)]
    gaps = _gaps(blocks)
    assert [(g.x, g.y) for g in gaps] == [(800, 320)] and gaps[0].confidence >= 0.9


def test_slot_with_something_else_in_it_is_not_a_gap():
    row = _row([60, 300, 780, 1020], w=180)
    assert _gaps(row, extra=[A.Block(560, 330, 140, 190)]) == []  # other content sits in the slot at 540


def test_empty_framed_box_is_reported_as_a_placeholder():
    card, box = A.Block(100, 200, 300, 300), A.Block(600, 200, 400, 300)
    gaps = A.find_gaps(_canvas(), [card, box], _edges([card]))
    assert [(g.bbox, g.kind) for g in gaps] == [((600, 200, 400, 300), "placeholder")]


def test_solid_colour_block_is_not_a_placeholder():
    card, box = A.Block(100, 200, 300, 300), A.Block(600, 200, 400, 300)
    page = _canvas()
    ImageDraw.Draw(page).rectangle((box.x, box.y, box.x1 - 1, box.y1 - 1), fill=(79, 70, 229))  # a brand-colour swatch
    assert A.find_gaps(page, [card, box], _edges([card])) == []


def test_panel_outline_does_not_hide_the_blocks_inside_it():
    panel = A.Block(100, 150, 1000, 500)
    cards = [A.Block(x, 250, 200, 300) for x in (190, 500)]
    edges = _edges(cards)
    edges[150:158, 100:1100] = edges[642:650, 100:1100] = edges[150:650, 100:108] = edges[150:650, 1092:1100] = True  # the panel's own outline
    assert [(g.x, g.y) for g in A.find_gaps(_canvas(), [panel, *cards], edges)] == [(810, 250)]


def test_gaps_inside_a_panel_use_the_panel_as_their_frame():
    panel = A.Block(100, 150, 1000, 500)
    cards = [A.Block(x, 250, 200, 300) for x in (190, 500)]  # a centred trio in the panel would be 190, 500, 810
    gaps = A.find_gaps(_canvas(), [panel, *cards], _edges(cards))
    assert [(g.x, g.y) for g in gaps if g.kind == "pattern"] == [(810, 250)]


def test_gap_mask_is_the_slot_grown_slightly_and_clipped():
    gap = A.Gap(0, 10, 50, 40, "", 0.9, "pattern")
    mask = A.gap_mask(gap, (200, 100), grow=6)
    assert mask.shape == (100, 200) and mask[4:56, 0:56].all()
    assert not mask[:4].any() and not mask[:, 56:].any() and not mask[56:].any()


# --- detection on rendered mockups ----------------------------------------------

KNOWN_MISSES = {"photo_hero_missing_right"}  # cards over a photo: no flat background to read the layout from


@pytest.mark.parametrize("name", list(DESIGNS))
def test_mockup_gaps_are_found_exactly(name):
    if name in KNOWN_MISSES:
        pytest.xfail("cards laid over a photo are not detected yet")
    img, truth = DESIGNS[name]()
    gaps = [g for g in A.detect(img) if g.confidence >= 0.5]
    assert len(gaps) == len(truth), [(g.bbox, g.reason) for g in gaps]
    for box in truth:
        assert any(A.iou(A.Block(*box), A.Block(*g.bbox)) >= 0.6 for g in gaps)


@pytest.mark.parametrize("name", list(INDEPENDENT))
def test_designs_by_an_independent_reviewer(name):
    img, truth = INDEPENDENT[name]()
    gaps = [g for g in A.detect(img) if g.confidence >= 0.5]
    correct = len(gaps) == len(truth) and all(any(A.iou(A.Block(*box), A.Block(*g.bbox)) >= 0.6 for g in gaps) for box in truth)
    if name in KNOWN_LIMITS:
        if correct:
            pytest.fail("now detected correctly: take it out of KNOWN_LIMITS")
        pytest.xfail(KNOWN_LIMITS[name])
    assert correct, [(g.bbox, g.confidence, g.reason) for g in gaps]


def test_detection_is_fast():
    img, _ = DESIGNS["gallery_missing_cell"]()
    t = time.perf_counter()
    A.detect(img)
    assert time.perf_counter() - t < 0.5


# --- blending and seam score ----------------------------------------------------


def _scene():
    rng = np.random.default_rng(3)
    base = np.full((200, 300, 3), (180, 200, 230), np.float32) + rng.normal(0, 2, (200, 300, 3))
    img = Image.fromarray(np.clip(base, 0, 255).astype(np.uint8))
    mask = np.zeros((200, 300), np.uint8)
    mask[60:140, 100:220] = 255
    return img, mask


def test_blending_an_image_onto_itself_changes_nothing():
    # Catches the classic seamlessClone bug of the patch landing a pixel off.
    img, _ = DESIGNS["gallery_missing_cell"]()
    mask = np.zeros((img.height, img.width), np.uint8)
    mask[140:330, 80:390] = 255  # covers a photo edge, so a shift would show
    diff = np.abs(np.asarray(A.blend(img, img, mask)).astype(int) - np.asarray(img).astype(int))
    assert diff.max() <= 3


def test_blend_works_when_the_mask_touches_the_image_border():
    img, _ = _scene()
    mask = np.zeros((200, 300), np.uint8)
    mask[:80, :120] = 255
    out = A.blend(img, img, mask)
    assert out.size == img.size and np.abs(np.asarray(out).astype(int) - np.asarray(img).astype(int)).max() <= 3


def test_blend_leaves_pixels_outside_an_irregular_mask_untouched():
    img, _ = DESIGNS["gallery_missing_cell"]()
    mask = np.zeros((img.height, img.width), np.uint8)
    brush = ImageDraw.Draw(Image.fromarray(mask))
    stroke = Image.new("L", img.size, 0)
    d = ImageDraw.Draw(stroke)
    d.line([(150, 200), (400, 420), (700, 260)], fill=255, width=46)  # a brush stroke across two photos
    d.ellipse((880, 500, 980, 600), fill=255)  # and a separate blob
    mask = np.asarray(stroke).copy()
    other = Image.new("RGB", img.size, (30, 160, 90))
    out = np.asarray(A.blend(img, other, mask))
    assert np.array_equal(out[mask == 0], np.asarray(img)[mask == 0])
    assert not np.array_equal(out[mask == 255], np.asarray(img)[mask == 255])


def test_blend_survives_a_tiny_mask():
    img, _ = _scene()
    mask = np.zeros((200, 300), np.uint8)
    mask[50:52, 60:61] = 255
    assert A.blend(img, Image.new("RGB", img.size, (0, 0, 0)), mask).size == img.size


def _slot_error(image: Image.Image, original: Image.Image, mask: np.ndarray) -> float:
    """Mean difference from the original in a band just outside the mask."""
    band = (cv2.dilate(mask, np.ones((61, 61), np.uint8)) > 0) & (cv2.dilate(mask, np.ones((33, 33), np.uint8)) == 0)
    return float(np.abs(np.asarray(image).astype(float) - np.asarray(original).astype(float))[band].mean())


@pytest.mark.parametrize("zoom, dx, dy", [(1.012, 5.0, -3.0), (0.99, -4.0, 6.0), (1.0, 0.0, 0.0)])
def test_register_undoes_a_small_zoom_and_shift(zoom, dx, dy):
    img, truth = DESIGNS["pricing_missing_right"]()
    x, y, w, h = truth[0]
    mask = np.zeros((img.height, img.width), np.uint8)
    mask[y : y + h, x : x + w] = 255
    # What an edit model returns: the design with the slot filled, slightly zoomed and shifted.
    filled = img.copy()
    ImageDraw.Draw(filled).rounded_rectangle((x, y, x + w, y + h), radius=18, fill=(255, 255, 255), outline=(222, 226, 235))
    cx, cy = img.width / 2, img.height / 2
    m = np.float32([[zoom, 0, (1 - zoom) * cx + dx], [0, zoom, (1 - zoom) * cy + dy]])
    drifted = Image.fromarray(cv2.warpAffine(np.asarray(filled), m, img.size, borderMode=cv2.BORDER_REPLICATE))

    aligned = A.register(drifted, img, mask)
    assert _slot_error(aligned, img, mask) <= max(0.6, _slot_error(drifted, img, mask) * 0.25)
    # The filled card's left edge is back on the slot's left edge (within a pixel).
    row = np.asarray(aligned.convert("L")).astype(int)[y + h // 2]
    edge = int(np.argmax(np.abs(np.diff(row[x - 12 : x + 12])))) + x - 12
    assert abs(edge - x) <= 1


def test_register_gives_up_gracefully_when_nothing_lies_outside_the_mask():
    img, _ = _scene()
    full = np.full((200, 300), 255, np.uint8)
    other = Image.new("RGB", img.size, (9, 9, 9))
    assert A.register(other, img, full) is other


def test_composite_touches_only_the_masked_pixels():
    img, mask = _scene()
    other = Image.new("RGB", img.size, (10, 10, 10))
    out = np.asarray(A.composite(img, other, mask))
    assert (out[mask == 255] == 10).all() and np.array_equal(out[mask == 0], np.asarray(img)[mask == 0])


def test_seam_score_ranks_clean_above_tinted_above_clashing():
    img, mask = _scene()
    clean = A.seam_score(img, mask)
    tinted = A.seam_score(A.composite(img, Image.new("RGB", img.size, (172, 192, 222)), mask), mask)
    clashing = A.seam_score(A.composite(img, Image.new("RGB", img.size, (40, 40, 40)), mask), mask)
    assert clean > 0.95 and clean > tinted > clashing and clashing < 0.1


def test_poisson_blend_hides_a_color_mismatch():
    img, mask = _scene()
    tinted = Image.new("RGB", img.size, (165, 185, 215))
    assert A.seam_score(A.blend(img, tinted, mask), mask) > A.seam_score(A.composite(img, tinted, mask), mask) + 0.2


def test_context_box_adds_margin_and_stays_inside_the_image():
    mask = np.zeros((400, 600), np.uint8)
    mask[10:110, 500:590] = 255
    x0, y0, x1, y1 = A.context_box(mask)
    assert x0 <= 500 - 54 and y1 >= 110 + 60 and (x0, y0) >= (0, 0) and x1 <= 600 and y1 <= 400 and y0 == 0 and x1 == 600


# --- the whole pipeline, with the mock generator --------------------------------


@pytest.mark.models
def test_fill_pipeline_and_endpoints_end_to_end():
    from fastapi.testclient import TestClient

    from app.images import decode_image, encode_image
    from app.main import app

    client = TestClient(app)
    img, truth = DESIGNS["pricing_missing_right"]()
    detected = client.post("/autocomplete/detect", json={"image": encode_image(img)}).json()
    assert (detected["width"], detected["height"]) == img.size and len(detected["regions"]) == 1
    region = detected["regions"][0]
    assert A.iou(A.Block(*truth[0]), A.Block(*region["bbox"])) >= 0.6 and len(region["siblings"]) == 2

    plan = client.post("/autocomplete/plan", json={"image": encode_image(img), "mask": region["mask"]}).json()
    assert plan["analysis"] and 2 <= len(plan["suggestions"]) <= 3

    body = {"image": encode_image(img), "mask": region["mask"], "prompt": plan["suggestions"][0]["prompt"], "n": 3,
            "references": [*region["siblings"], [5, 5, 0, 40], [99999, 0, 50, 50]]}  # two unusable boxes are ignored
    job_id = client.post("/autocomplete/fill", json=body).json()["job_id"]
    for _ in range(600):
        status = client.get(f"/jobs/{job_id}").json()
        if status["status"] != "pending":
            break
        time.sleep(0.1)
    assert status["status"] == "done", status
    candidates = status["result"]["candidates"]
    assert len(candidates) == 3
    totals = [c["scores"]["total"] for c in candidates]
    assert totals == sorted(totals, reverse=True)
    assert all(0 <= c["scores"][k] <= 1 for c in candidates for k in ("style", "seam", "intent", "total"))
    mask = np.asarray(decode_image(region["mask"]).convert("L")) > 127
    raw = np.asarray(decode_image(candidates[0]["raw"]))
    assert np.array_equal(raw[~mask], np.asarray(img)[~mask]), "pixels outside the mask must be untouched"
    assert decode_image(candidates[0]["image"]).size == img.size
