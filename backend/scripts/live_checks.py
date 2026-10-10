"""Live checks: make one real call to each hosted service and save what comes back.

Everything else in this repo was tested with stand-ins. This script is the
first real use of the keys in .env, so run it before trusting any hosted path.

Run from backend/:
    .venv/bin/python -m scripts.live_checks                 # every check whose key is set
    .venv/bin/python -m scripts.live_checks inpaint plan    # only the named checks
    .venv/bin/python -m scripts.live_checks views --character path/to/drawing.png

Checks (image checks use whichever image service is active: Gemini if it has a
key, otherwise fal; see IMAGE_PROVIDER in .env):
    inpaint  2 fills of the missing pricing card, ranked           (2 image calls)
    enhance  1 realistic re-render of the relit portrait preview   (1 image call)
    views    1 side view of a character drawing. Pass --character path.png to
             use your own drawing; otherwise one is generated first (1 or 2 image calls)
    plan     the planner on the pricing mockup                      (1 text call)
Results are cached, so re-running a check that already worked costs nothing.
Gemini image calls are capped by GEMINI_IMAGE_CALL_LIMIT (see .cache/spend.json).
Output images go to proofs/live/.
"""

import os
import sys
import time
import traceback
from pathlib import Path

os.environ["MOCK_MODE"] = "0"  # before app.config is imported

from PIL import Image, ImageDraw  # noqa: E402

from app.config import get_settings  # noqa: E402

OUT = Path(__file__).resolve().parents[2] / "proofs" / "live"


def _sheet(tiles: list[tuple[str, Image.Image]], path: Path, height: int = 420) -> None:
    scaled = []
    for label, img in tiles:
        img = img.convert("RGB")
        img = img.resize((round(img.width * height / img.height), height), Image.LANCZOS)
        d = ImageDraw.Draw(img)
        d.rectangle((0, 0, 10 + 7 * len(label), 18), fill=(0, 0, 0))
        d.text((4, 3), label, fill=(255, 255, 255))
        scaled.append(img)
    sheet = Image.new("RGB", (sum(t.width for t in scaled), height), (30, 30, 30))
    x = 0
    for t in scaled:
        sheet.paste(t, (x, 0))
        x += t.width
    path.parent.mkdir(parents=True, exist_ok=True)
    sheet.save(path, quality=90)
    print(f"   saved {path}")


def check_inpaint() -> None:
    from app.ideas import autocomplete as A
    from scripts.make_mockups import DESIGNS

    img, _ = DESIGNS["pricing_missing_right"]()
    gap = A.detect(img)[0]
    prompt = (
        'A white pricing card with rounded corners matching the two cards beside it: a small pink pill at the top, '
        'the plan name "Scale", the price "$99" in large dark text, four thin grey lines of body text, and a wide '
        "pink button at the bottom. Flat UI design, same size and spacing as its neighbours."
    )
    fills = A.fill(img, A.gap_mask(gap, img.size), prompt, n=2, references=list(gap.siblings))
    tiles = [("original", img)]
    for i, f in enumerate(fills):
        s = f.scores
        tiles.append((f"#{i + 1} total {f.total:.2f} style {s['style']:.2f} seam {s['seam']:.2f} intent {s['intent']:.2f}", f.image))
    _sheet(tiles, OUT / "inpaint_pricing_card.jpg")
    print("   LOOK AT: does the new card match its neighbours, and is its text readable?")


def check_enhance() -> None:
    from skimage import data

    from app.ideas import relight as R
    from app.providers import generation

    img = Image.fromarray(data.astronaut())
    geom = R.build_geometry(R.estimate_height(img), normals=R.estimate_normals(img))
    preview = R.relight(img, geom, R.Light(-0.4, 0.25, height=0.25, intensity=1.5, ambient=0.12))
    enhanced = generation.relight_enhance(preview, "portrait photo, dramatic light from the left, realistic", light_from="Left")
    _sheet([("original", img), ("our preview, light left", preview), ("after Enhance", enhanced)], OUT / "relight_enhance.jpg")
    print("   LOOK AT: is the light still coming from the left, and is it still the same person?")


CHARACTER_PROMPT = (
    "A full-body front view of an original cartoon character for a video game: a young explorer with short "
    "teal hair, round orange goggles pushed up on the forehead, a mustard-yellow jacket, a red scarf, a brown "
    "satchel on a strap across the chest, dark trousers and white boots. Flat colors, clean outlines, standing "
    "in a neutral pose, centered on a plain white background, no text."
)


def check_views(character_path: str | None) -> None:
    from app.ideas import turnaround as T
    from app.providers import generation

    if character_path:
        drawing = Image.open(character_path)
    elif generation.provider() == "gemini":
        drawing = generation.gemini_image(CHARACTER_PROMPT)
    else:
        print("   SKIPPED: pass --character path/to/drawing.png (any single character on a plain background)")
        return
    character = T.analyze(drawing)
    print(f"   analyst: source view {character.source_view}; {character.spec.summary}")
    for f in character.spec.features:
        print(f"     - {f.name}  (visible from {', '.join(f.visible_from)}{'; critical' if f.critical else ''})")
    prompt = T.view_prompt(character.spec, character.spec.features, "side")
    side = generation.edit_image(character.reference, prompt, n=1)[0]
    scores, checklist = T.check(side, character, character.spec.features, "side")
    names = {f.id: f.name for f in character.spec.features}
    for c in checklist:
        mark = "ok  " if c.present == c.expected_visible else "WRONG"
        print(f"     [{mark}] {names[c.feature_id]}: expected {'visible' if c.expected_visible else 'hidden'}, "
              f"{'present' if c.present else 'absent'}")
    label = f"side view: identity {scores['identity']:.2f} palette {scores['palette']:.2f} checklist {scores['checklist']:.2f}"
    _sheet([("input (front)", character.reference), (label, side)], OUT / "character_side_view.jpg")
    print("   LOOK AT: is it a true side view, and is it still the same character?")


def check_plan() -> None:
    from app.ideas import autocomplete as A
    from app.providers.llm import vision_json
    from app.schemas import PlanOut
    from scripts.make_mockups import DESIGNS

    img, _ = DESIGNS["pricing_missing_right"]()
    mask = A.gap_mask(A.detect(img)[0], img.size)
    plan = vision_json([img, A.highlight(img, mask)], A.PLAN_PROMPT, PlanOut)
    print(f"   analysis: {plan.analysis}")
    for s in plan.suggestions:
        print(f"   - {s.label}: {s.prompt}")
    print("   LOOK AT: did it work out that a third pricing card is missing?")


if __name__ == "__main__":
    args = sys.argv[1:]
    character = args[args.index("--character") + 1] if "--character" in args else None
    wanted = [a for a in args if a in ("inpaint", "enhance", "views", "plan")]
    have = get_settings().configured()
    from app.providers.generation import provider

    image_key = provider()
    checks = [
        ("inpaint", image_key, check_inpaint),
        ("enhance", image_key, check_enhance),
        ("views", image_key, lambda: check_views(character)),
        ("plan", "anthropic" if have["anthropic"] else "gemini", check_plan),
    ]
    failed = 0
    for name, provider, fn in checks:
        if wanted and name not in wanted:
            continue
        if not have[provider]:
            print(f"[skip] {name}: no {provider} key in .env")
            continue
        print(f"[run ] {name} ...")
        start = time.time()
        try:
            fn()
            print(f"[ ok ] {name} ({time.time() - start:.0f}s)")
        except Exception:  # a smoke-test runner: report whatever went wrong and move on
            failed += 1
            print(f"[FAIL] {name}:\n{traceback.format_exc(limit=3)}")
    sys.exit(1 if failed else 0)
