"""relight.py still makes the pictures the frontend's agreement test holds it to.

frontend/tests/agreement.test.ts checks lib/relightMath.ts against pictures
rendered by relight.py (scripts/relight_fixtures.py writes them). This is the
other half: if relight.py changes and the pictures are not made again, this
fails here, instead of the two versions quietly drifting apart. After an
intentional change to the maths, run the script and commit its output.
"""

import json

import numpy as np
import pytest
from PIL import Image

from app.ideas import relight as R
from scripts.relight_fixtures import CASES, OUT, _geometry, _light

# One level of 255: a different build of NumPy or OpenCV may round a hair differently.
MAX_LEVELS = 1

_SCENES = json.loads((OUT / "cases.json").read_text())["scenes"] if (OUT / "cases.json").exists() else []


def test_fixtures_exist():
    assert len(_SCENES) == 8, f"no fixtures in {OUT}: run scripts.relight_fixtures"


@pytest.mark.parametrize("scene", _SCENES, ids=[s["name"] for s in _SCENES])
def test_relight_still_makes_the_fixtures(scene):
    folder = OUT / scene["name"]
    photo = Image.open(folder / "photo.png").convert("RGB")
    depth = np.asarray(Image.open(folder / "depth.png").convert("L"))
    normals = np.asarray(Image.open(folder / "normals.png").convert("RGB"))
    geom = _geometry(depth, normals, scene["relief"])
    off = {}
    for case in scene["cases"]:
        key, cast, fill = CASES[case]
        ours = np.asarray(R.relight(photo, geom, _light(key), cast_shadows=cast, fill=_light(fill)), dtype=np.int16)
        theirs = np.asarray(Image.open(folder / f"{case}.png").convert("RGB"), dtype=np.int16)
        worst = int(np.abs(ours - theirs).max())
        if worst > MAX_LEVELS:
            off[case] = worst
    assert not off, f"relight.py no longer makes these fixtures (levels off): {off}. Run scripts.relight_fixtures if the change was meant."

