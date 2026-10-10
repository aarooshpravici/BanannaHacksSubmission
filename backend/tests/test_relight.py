"""The relight math, checked on shapes where the right answer is known."""

import numpy as np
import pytest
from PIL import Image

from app.ideas import relight as R

N = 128


def _dome() -> np.ndarray:
    """A smooth bump in the middle of a flat plane: nearness 0..1."""
    ys, xs = np.mgrid[0:N, 0:N]
    r2 = ((xs - N / 2) ** 2 + (ys - N / 2) ** 2) / (N * 0.3) ** 2
    return np.clip(1.0 - r2, 0.0, 1.0).astype(np.float32)


def _block() -> np.ndarray:
    """A tall square block in the middle of a flat plane."""
    h = np.zeros((N, N), np.float32)
    h[54:74, 54:74] = 1.0
    return h


def test_normals_point_outward_from_a_bump():
    g = R.build_geometry(_dome(), smooth=0)
    c = N // 2
    assert g.normals[c, c, 2] > 0.99  # top of the dome faces the viewer
    assert g.normals[c, c - 25, 0] < -0.2  # left flank faces left
    assert g.normals[c, c + 25, 0] > 0.2  # right flank faces right
    assert g.normals[c - 25, c, 1] < -0.2  # upper flank faces up (y grows downward)
    assert g.normals[c + 25, c, 1] > 0.2
    assert np.allclose(np.linalg.norm(g.normals, axis=2), 1.0, atol=1e-5)
    assert np.allclose(g.normals[2, 2], [0, 0, 1], atol=1e-5)  # flat plane faces the viewer


@pytest.mark.parametrize(
    "light_xy, bright, dark",
    [
        ((0.0, 0.5), (64, 39), (64, 89)),  # light on the left: left flank brighter
        ((1.0, 0.5), (64, 89), (64, 39)),
        ((0.5, 0.0), (39, 64), (89, 64)),  # light at the top: upper flank brighter
        ((0.5, 1.0), (89, 64), (39, 64)),
    ],
)
def test_the_side_facing_the_light_is_brighter(light_xy, bright, dark):
    g = R.build_geometry(_dome(), smooth=0)
    d = R.diffuse(g, R.Light(*light_xy, height=0.5))
    assert d[bright] > d[dark] * 1.5


def test_flat_plane_is_brightest_under_the_light():
    g = R.build_geometry(np.ones((N, N), np.float32))
    d = R.diffuse(g, R.Light(0.25, 0.75, height=0.4))
    peak = np.unravel_index(d.argmax(), d.shape)
    assert abs(peak[1] - 0.25 * N) <= 1 and abs(peak[0] - 0.75 * N) <= 1
    assert d[5, N - 5] < d.max() / 3  # far corner gets much less light


@pytest.mark.parametrize("light_xy", [(0.5, 0.5), (-0.5, 0.5), (1.4, -0.3)])
def test_exposure_at_the_scene_centre_does_not_depend_on_light_distance(light_xy):
    # A mid-level surface at the centre, turned to face the light, always gets 1.0.
    g = R.build_geometry(np.full((N, N), 0.5, np.float32))
    light = R.Light(*light_xy, height=0.4)
    c = N // 2
    to_light = R._light_position(g, light) - R._pixel_positions(g)[c, c]
    g.normals[c, c] = to_light / np.linalg.norm(to_light)
    assert R.diffuse(g, light)[c, c] == pytest.approx(1.0, abs=0.03)


def test_light_position_respects_non_square_images():
    g = R.build_geometry(np.zeros((64, 256), np.float32))  # wide image
    d = R.diffuse(g, R.Light(0.5, 1.0, height=0.3))  # bottom-centre
    peak = np.unravel_index(d.argmax(), d.shape)
    assert peak[0] >= 62 and abs(peak[1] - 128) <= 2


def test_block_casts_a_shadow_away_from_the_light():
    g = R.build_geometry(_block(), relief=0.3, smooth=0)
    left_light = R.shadows(g, R.Light(-0.2, 0.5, height=0.15), max_side=N)
    assert left_light[64, 85] < 0.2, "just right of the block should be shadowed"
    assert left_light[64, 40] > 0.9, "left of the block should be lit"
    assert left_light[20, 85] > 0.9, "off to the side should be lit"
    right_light = R.shadows(g, R.Light(1.2, 0.5, height=0.15), max_side=N)
    assert right_light[64, 43] < 0.2 and right_light[64, 88] > 0.9


def test_lower_light_gives_longer_shadows():
    g = R.build_geometry(_block(), relief=0.3, smooth=0)
    high = R.shadows(g, R.Light(-0.2, 0.5, height=0.8), max_side=N)
    low = R.shadows(g, R.Light(-0.2, 0.5, height=0.1), max_side=N)
    assert (low < 0.5).sum() > (high < 0.5).sum() * 1.5


def test_light_straight_above_a_flat_plane_casts_no_shadow():
    g = R.build_geometry(np.zeros((N, N), np.float32))
    assert R.shadows(g, R.Light(0.5, 0.5, height=0.5), max_side=N).min() > 0.99


def test_a_block_does_not_shadow_its_own_top():
    g = R.build_geometry(_block(), relief=0.3, smooth=0)
    s = R.shadows(g, R.Light(-0.2, 0.5, height=0.3), max_side=N)
    assert s[64, 64] > 0.9


def test_apply_shading_identity_darker_and_no_clipping_artifacts():
    rng = np.random.default_rng(0)
    img = Image.fromarray(rng.integers(0, 255, (N, N, 3), dtype=np.uint8))
    arr = np.asarray(img).astype(int)
    # Below the highlight knee, a shading of 1.0 leaves the photo unchanged.
    same = np.asarray(R.apply_shading(img, np.ones((N, N), np.float32))).astype(int)
    midtones = arr.max(axis=2) < 200
    assert np.abs(same - arr)[midtones].max() <= 1
    half = np.asarray(R.apply_shading(img, np.full((N, N), 0.5, np.float32))).astype(int)
    assert (half <= arr + 1).all() and half.mean() < arr.mean() * 0.85
    bright = np.asarray(R.apply_shading(img, np.full((N, N), 3.0, np.float32))).astype(int)
    assert (bright >= arr - 1).all() and bright.max() <= 255


def test_shading_is_ambient_in_shadow_and_above_one_under_a_strong_light():
    g = R.build_geometry(_block(), smooth=0)
    side = R.shading_map(g, R.Light(-0.2, 0.5, height=0.15, ambient=0.3, intensity=1.5))
    assert side.min() >= 0.3 and side[64, 85] == pytest.approx(0.3, abs=0.01)  # in the block's shadow
    above = R.shading_map(g, R.Light(0.5, 0.5, height=0.15, ambient=0.3, intensity=1.5))
    assert above[64, 64] > 0.3 + 1.5  # top of the block, right under the light, nearer than the scene centre


def test_enhance_renders_its_input_with_the_shadow_setting_on_screen():
    from app.images import decode_image
    from app.routers import relight as router

    scene = router._Scene(Image.new("RGB", (N, N), (180, 180, 180)), R.build_geometry(_block(), relief=0.3, smooth=0))
    light = R.Light(-0.2, 0.5, height=0.15)

    # In mock mode the provider hands back its input, so this is the image it would be sent.
    def sent(**kwargs):
        return np.asarray(decode_image(router._enhance(scene, light, "", **kwargs)["image"])).astype(float)

    off, on = sent(shadows=False), sent(shadows=True)
    assert off[64, 85].mean() > on[64, 85].mean() * 1.2, "no cast shadow beside the block when shadows are off"
    assert np.array_equal(sent(), on), "shadows stay on unless the request says otherwise"


@pytest.mark.models
def test_depth_model_puts_the_foreground_in_front():
    from skimage import data

    height = R.estimate_height(Image.fromarray(data.astronaut()))
    assert height.shape == (512, 512) and 0.0 <= height.min() and height.max() <= 1.0
    helmet, face, backdrop = height[400, 400], height[100, 220], height[30, 480]
    assert helmet > face > backdrop
    assert helmet > 0.8 and backdrop < 0.2


@pytest.mark.models
def test_relight_endpoints_end_to_end():
    import time

    from fastapi.testclient import TestClient
    from skimage import data

    from app.images import decode_image, encode_image
    from app.main import app

    client = TestClient(app)
    photo = Image.fromarray(data.astronaut())
    scene = client.post("/relight/scene", json={"image": encode_image(photo), "detail": False}).json()
    assert (scene["width"], scene["height"]) == (512, 512)
    depth, normals = decode_image(scene["depth"]), decode_image(scene["normals"])
    assert depth.size == normals.size == (512, 512)
    assert np.asarray(depth.convert("L"))[400, 400] > np.asarray(depth.convert("L"))[30, 480]  # helmet nearer than backdrop
    n = np.asarray(normals).astype(np.float32) / 255 * 2 - 1
    assert n[..., 2].mean() > 0.5 and abs(np.linalg.norm(n, axis=2).mean() - 1) < 0.05

    def render(x):
        body = {"scene_id": scene["scene_id"], "light": {"x": x, "y": 0.3}}
        return np.asarray(decode_image(client.post("/relight/render", json=body).json()["image"])).astype(float)

    left, right = render(-0.4), render(1.4)
    assert left[:, :128].mean() > right[:, :128].mean() * 1.2  # left light: left strip brighter
    assert right[:, -128:].mean() > left[:, -128:].mean() * 1.2

    job_id = client.post("/relight/enhance", json={"scene_id": scene["scene_id"]}).json()["job_id"]
    for _ in range(100):
        status = client.get(f"/jobs/{job_id}").json()
        if status["status"] != "pending":
            break
        time.sleep(0.05)
    assert status["status"] == "done" and decode_image(status["result"]["image"]).size == (512, 512)

    assert client.post("/relight/render", json={"scene_id": "nope"}).status_code == 404
    assert client.post("/relight/render", json={"scene_id": scene["scene_id"], "light": {"height": 0}}).status_code == 422
