"""Gap-detection proof: run the detector on the synthetic mockups and score it.

Run from backend/:  .venv/bin/python -m scripts.proof_autocomplete [--sam]
Output: a table (one row per design) and proofs/autocomplete/detections/<name>.jpg
with found blocks in blue, reported gaps in green, and the true gaps in dashed red.

A design passes when every true gap is matched by a reported gap (overlap
IoU >= 0.6) and nothing else is reported with confidence >= 0.5.
"""

import json
import sys
import time
from pathlib import Path

from PIL import Image, ImageDraw

from app.ideas import autocomplete as A

ROOT = Path(__file__).resolve().parents[2] / "proofs" / "autocomplete"


def _dashed(d: ImageDraw.ImageDraw, box, color, dash=14) -> None:
    x0, y0, x1, y1 = box
    for x in range(x0, x1, dash * 2):
        d.line((x, y0, min(x + dash, x1), y0), fill=color, width=3)
        d.line((x, y1, min(x + dash, x1), y1), fill=color, width=3)
    for y in range(y0, y1, dash * 2):
        d.line((x0, y, x0, min(y + dash, y1)), fill=color, width=3)
        d.line((x1, y, x1, min(y + dash, y1)), fill=color, width=3)


def run(use_sam: bool) -> bool:
    truth = json.loads((ROOT / "inputs" / "truth.json").read_text())
    out_dir = ROOT / ("detections_sam" if use_sam else "detections")
    out_dir.mkdir(parents=True, exist_ok=True)
    passed = 0
    print(f"{'design':28} {'true':>4} {'found':>5} {'matched':>7} {'extra':>5} {'time':>7}  result")
    for name, true_boxes in truth.items():
        img = Image.open(ROOT / "inputs" / f"{name}.png").convert("RGB")
        t = time.perf_counter()
        edges = A.edge_map(img)
        blocks = A.layout_blocks(img, edges) + (A.sam_blocks(img) if use_sam else [])
        gaps = [g for g in A.find_gaps(img, blocks, edges) if g.confidence >= 0.5]
        dt = time.perf_counter() - t

        matched = 0
        used: set[int] = set()
        for tb in true_boxes:
            for i, g in enumerate(gaps):
                if i not in used and A.iou(A.Block(*tb), A.Block(*g.bbox)) >= 0.6:
                    used.add(i)
                    matched += 1
                    break
        extra = len(gaps) - len(used)
        ok = matched == len(true_boxes) and extra == 0
        passed += ok
        print(f"{name:28} {len(true_boxes):>4} {len(gaps):>5} {matched:>7} {extra:>5} {dt * 1000:>6.0f}ms  {'PASS' if ok else 'FAIL'}")

        vis = img.copy()
        d = ImageDraw.Draw(vis)
        for b in A.dedupe(blocks):
            d.rectangle((b.x, b.y, b.x1, b.y1), outline=(40, 120, 255), width=2)
        for tb in true_boxes:
            _dashed(d, (tb[0], tb[1], tb[0] + tb[2], tb[1] + tb[3]), (255, 40, 40))
        for g in gaps:
            d.rectangle((g.x, g.y, g.x + g.w, g.y + g.h), outline=(20, 200, 90), width=5)
            d.rectangle((g.x, g.y, g.x + 150, g.y + 24), fill=(20, 200, 90))
            d.text((g.x + 6, g.y + 5), f"{g.kind} {g.confidence:.2f}", fill=(0, 0, 0))
        vis.save(out_dir / f"{name}.jpg", quality=88)
    print(f"\n{passed}/{len(truth)} designs passed{' (with SAM)' if use_sam else ''}")
    return passed == len(truth)


if __name__ == "__main__":
    sys.exit(0 if run("--sam" in sys.argv) else 1)
