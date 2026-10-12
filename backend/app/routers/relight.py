"""Relight endpoints.

/relight/scene does the slow, light-independent work once per photo and hands
the browser the depth and normal maps, so it can shade live while the light is
dragged. /relight/render is the same shading done on the server (export,
fallback, and the input to Enhance). Both take an optional fill light.
"""

import threading
import uuid
from collections import OrderedDict
from dataclasses import dataclass

import numpy as np
from fastapi import APIRouter, HTTPException
from PIL import Image

from ..ideas import relight as R
from ..images import decode_image, encode_image, resize_max_side, to_rgb
from ..jobs import jobs
from ..providers import generation
from ..schemas import FillLightIn, JobRef, LightIn, RelightEnhanceIn, RelightRender, RelightRenderIn, RelightScene, RelightSceneIn

router = APIRouter(prefix="/relight")

# Shading is per-pixel work in the browser and on the server; 1024 keeps both fast.
MAX_SIDE = 1024
MAX_SCENES = 16


@dataclass
class _Scene:
    image: Image.Image
    geom: R.Geometry


_scenes: OrderedDict[str, _Scene] = OrderedDict()
_scenes_lock = threading.Lock()


def _get_scene(scene_id: str) -> _Scene:
    with _scenes_lock:
        scene = _scenes.get(scene_id)
    if scene is None:
        raise HTTPException(404, "unknown scene id; upload the photo again")
    return scene


def _light(body: LightIn) -> R.Light:
    return R.Light(body.x, body.y, body.height, body.intensity, body.ambient, body.color)


def _fill(body: FillLightIn | None) -> R.Light | None:
    """The request's fill light, or None when it has none. A fill has no ambient of its own."""
    if body is None:
        return None
    return R.Light(body.x, body.y, body.height, body.intensity, 0.0, body.color)


@router.post("/scene")
def scene(body: RelightSceneIn) -> RelightScene:
    img = resize_max_side(to_rgb(decode_image(body.image)), MAX_SIDE)
    height = R.estimate_height(img)
    normals = R.estimate_normals(img) if body.detail else None
    geom = R.build_geometry(height, normals=normals)
    scene_id = uuid.uuid4().hex[:12]
    with _scenes_lock:
        _scenes[scene_id] = _Scene(img, geom)
        while len(_scenes) > MAX_SCENES:
            _scenes.popitem(last=False)
    depth_png = Image.fromarray((geom.z / geom.relief * 255.0 + 0.5).astype(np.uint8))
    normals_png = Image.fromarray(((geom.normals * 0.5 + 0.5) * 255.0 + 0.5).astype(np.uint8))
    return RelightScene(
        scene_id=scene_id,
        width=img.width,
        height=img.height,
        image=encode_image(img, "JPEG"),
        depth=encode_image(depth_png),
        normals=encode_image(normals_png),
        relief=geom.relief,
    )


@router.post("/render")
def render(body: RelightRenderIn) -> RelightRender:
    s = _get_scene(body.scene_id)
    out = R.relight(s.image, s.geom, _light(body.light), cast_shadows=body.shadows, fill=_fill(body.fill))
    return RelightRender(image=encode_image(out, "JPEG"))


def _enhance(s: _Scene, light: R.Light, prompt: str, shadows: bool = True, fill: R.Light | None = None) -> dict:
    preview = R.relight(s.image, s.geom, light, cast_shadows=shadows, fill=fill)
    # The hosted relighter only takes a coarse direction, so give it the side
    # of the image the light is nearest to. That is the main light's side: the
    # fill is in the picture it is sent, and has no say in the direction.
    dx, dy = light.x - 0.5, light.y - 0.5
    side = ("Left" if dx < 0 else "Right") if abs(dx) >= abs(dy) else ("Top" if dy < 0 else "Bottom")
    # The words go on as typed, empty or not: what an empty box means is generation's to say.
    out = generation.relight_enhance(preview, prompt, light_from=side)
    return RelightRender(image=encode_image(out, "JPEG")).model_dump()


@router.post("/enhance")
def enhance(body: RelightEnhanceIn) -> JobRef:
    s = _get_scene(body.scene_id)
    return JobRef(job_id=jobs.submit(_enhance, s, _light(body.light), body.prompt, body.shadows, _fill(body.fill)))
