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


def _block(height: float = 1.0, floor: float = 0.0) -> np.ndarray:
    """A square block in the middle of a flat plane; by default as tall as the scene is deep."""
    h = np.full((N, N), floor, np.float32)
    h[54:74, 54:74] = floor + height
    return h


def _near_and_far_shadows() -> tuple[np.ndarray, np.ndarray]:
    """The same block top lit from the left, over a floor just behind it and over one far behind it."""
    light = R.Light(-0.2, 0.5, height=0.15)
    near = R.shadows(R.build_geometry(_block(0.1, floor=0.9), relief=0.3, smooth=0), light, max_side=N)
    far = R.shadows(R.build_geometry(_block(1.0, floor=0.0), relief=0.3, smooth=0), light, max_side=N)
    return near, far


def _ball_with_a_ridge() -> R.Geometry:
    """A ball whose normals, but not its depth, have a rounded ridge down the middle.

    That is what the two models give for a face: the depth map is a smooth
    blob, and the nose, brow and cheeks exist only in the normals.
    """
    ys, xs = np.mgrid[0:N, 0:N]
    r2 = ((xs - N / 2) ** 2 + (ys - N / 2) ** 2) / (N * 0.45) ** 2
    ball = (0.6 * np.sqrt(np.clip(1.0 - r2, 0.0, 1.0))).astype(np.float32)
    ridge = (0.5 * np.exp(-(((xs - N / 2) / 14.0) ** 2))).astype(np.float32)
    detailed = R.build_geometry(ball + ridge, relief=0.3, smooth=0)
    return R.build_geometry(ball, normals=detailed.normals, relief=0.3, smooth=0)


def _edge_width(profile: np.ndarray) -> int:
    """Pixels a shadow's edge takes to go from 10% to 90% of its full darkness."""
    depth = 1.0 - profile.min()
    return int(((profile < 1.0 - 0.1 * depth) & (profile > 1.0 - 0.9 * depth)).sum())


def _largest_step(a: np.ndarray) -> float:
    return float(max(np.abs(np.diff(a, axis=0)).max(), np.abs(np.diff(a, axis=1)).max()))


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


def test_shading_eases_out_where_a_surface_turns_away_from_the_light():
    k = R.TERMINATOR_SOFTNESS
    cos = np.linspace(-1.0, 1.0, 201)
    soft = R._soft_terminator(cos)
    assert np.allclose(soft[cos >= k], cos[cos >= k]), "plain Lambert on surfaces that face the light"
    assert (soft[cos <= -k] == 0).all(), "nothing on surfaces turned well away"
    assert soft[100] == pytest.approx(k / 4), "an edge-on surface still catches a little"
    assert (np.diff(soft) >= 0).all() and np.abs(np.diff(soft, 2)).max() < 0.001, "no corner anywhere"


@pytest.mark.parametrize("light_x", [-0.1, 1.1])  # the page's Left and Right presets
def test_a_ridge_lit_from_the_side_has_no_hard_line_on_its_far_flank(light_x):
    # The line that used to run down a face: where the far flank of the nose
    # turned edge-on to the light, plain Lambert went from lit to flat ambient
    # within three pixels, 42 grey levels in one step.
    g = _ball_with_a_ridge()
    light = R.Light(light_x, 0.4, height=0.35, intensity=1.3, ambient=0.06)
    c = N // 2
    assert R.shadows(g, light, max_side=N)[c, c - 30 : c + 30].min() > 0.99, "this is shading, not a cast shadow"
    row = np.asarray(R.relight(Image.new("RGB", (N, N), (180, 180, 180)), g, light))[c, :, 0].astype(int)
    # From the crest of the ridge down its far flank, crest last.
    flank = row[c - 30 : c + 1] if light_x > 0.5 else row[c : c + 31][::-1]
    darkest = len(flank) - 1 - flank[::-1].argmin()
    edge = flank[darkest:]
    lo, hi = edge[0], edge[-1]
    assert hi - lo > 80, "the flank is still clearly darker than the crest"
    width = int(((edge > lo + 0.1 * (hi - lo)) & (edge < lo + 0.9 * (hi - lo))).sum())
    assert width >= 5, "the edge from dark to lit is at least 5 pixels wide at 128 (it was 3)"
    assert np.abs(np.diff(flank)).max() < 30
    assert (flank == flank.min()).sum() <= 3, "no flat dark patch (16 pixels sat at exactly ambient)"


def test_light_position_respects_non_square_images():
    g = R.build_geometry(np.zeros((64, 256), np.float32))  # wide image
    d = R.diffuse(g, R.Light(0.5, 1.0, height=0.3))  # bottom-centre
    peak = np.unravel_index(d.argmax(), d.shape)
    assert peak[0] >= 62 and abs(peak[1] - 128) <= 2


def test_block_casts_a_shadow_away_from_the_light():
    g = R.build_geometry(_block(), relief=0.3, smooth=0)
    left_light = R.shadows(g, R.Light(-0.2, 0.5, height=0.15), max_side=N)
    # The plane is a whole scene-depth behind the block, so its shadow is the soft, faint kind.
    assert left_light[64, 85] < 0.8, "just right of the block should be shadowed"
    assert left_light[64, 40] > 0.9, "left of the block should be lit"
    assert left_light[20, 85] > 0.9, "off to the side should be lit"
    right_light = R.shadows(g, R.Light(1.2, 0.5, height=0.15), max_side=N)
    assert right_light[64, 43] < 0.8 and right_light[64, 88] > 0.9


def test_lower_light_gives_longer_shadows():
    g = R.build_geometry(_block(), relief=0.3, smooth=0)
    high = R.shadows(g, R.Light(-0.2, 0.5, height=0.8), max_side=N)
    low = R.shadows(g, R.Light(-0.2, 0.5, height=0.1), max_side=N)
    assert (low < 0.9).sum() > (high < 0.9).sum() * 1.5


def test_light_straight_above_a_flat_plane_casts_no_shadow():
    g = R.build_geometry(np.zeros((N, N), np.float32))
    assert R.shadows(g, R.Light(0.5, 0.5, height=0.5), max_side=N).min() > 0.99


def test_a_block_does_not_shadow_its_own_top():
    g = R.build_geometry(_block(), relief=0.3, smooth=0)
    s = R.shadows(g, R.Light(-0.2, 0.5, height=0.3), max_side=N)
    assert s[64, 64] > 0.9


def test_shadow_edge_is_wider_on_a_far_receiver_than_on_a_near_one():
    near, far = _near_and_far_shadows()
    # Walk down a column from lit plane into the shadow, where each shadow is darkest.
    near_x, far_x = 74 + near[64, 74:90].argmin(), 74 + far[64, 74:90].argmin()
    near_edge, far_edge = _edge_width(near[30:64, near_x]), _edge_width(far[30:64, far_x])
    assert 1 <= near_edge <= 5, "a shadow on a surface just behind the block is well defined"
    assert far_edge >= 3 * near_edge


def test_a_far_receiver_is_darkened_less_than_a_near_one():
    near, far = _near_and_far_shadows()
    assert near.min() < 0.2
    assert 0.5 < far.min() < 0.8, "fainter, but still a shadow"


@pytest.mark.parametrize("light_xy", [(-0.2, 0.5), (1.2, 0.5), (0.5, -0.3), (0.3, 0.4), (1.5, 1.5)])
@pytest.mark.parametrize("light_height", [0.03, 0.15, 0.8])
def test_a_shadow_on_a_far_receiver_has_no_hard_edge(light_xy, light_height):
    g = R.build_geometry(_block(), relief=0.3, smooth=0)
    s = R.shadows(g, R.Light(*light_xy, height=light_height), max_side=N)
    assert s.min() < 0.9, "there is a shadow to look at"
    assert _largest_step(s) < 0.05  # the old hard-edged shadows stepped by about 0.4 from one pixel to the next


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
    # Only a shadow on a surface close behind its caster goes all the way down to ambient.
    near = R.build_geometry(_block(0.1, floor=0.9), relief=1.0, smooth=0)
    side = R.shading_map(near, R.Light(-0.2, 0.5, height=0.15, ambient=0.3, intensity=1.5))
    assert side.min() >= 0.3 and side[64, 80] == pytest.approx(0.3, abs=0.01)  # in the block's shadow
    g = R.build_geometry(_block(), smooth=0)
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
    # 1.05, not more: the plane is far behind this block, so the shadow on it is faint.
    assert off[64, 85].mean() > on[64, 85].mean() * 1.05, "no cast shadow beside the block when shadows are off"
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


def test_two_requests_arriving_together_load_the_normals_model_once(monkeypatch):
    import threading
    import time

    import diffusers

    loads = []

    class FakePipeline:
        def to(self, device):
            return self

        def __call__(self, img, **kwargs):
            class Out:
                prediction = np.concatenate([np.zeros((1, img.height, img.width, 2), np.float32), np.ones((1, img.height, img.width, 1), np.float32)], axis=-1)

            return Out()

    def slow_load(*args, **kwargs):
        loads.append(1)
        time.sleep(0.2)  # long enough for the second thread to arrive mid-load
        return FakePipeline()

    monkeypatch.setattr(diffusers.MarigoldNormalsPipeline, "from_pretrained", slow_load)
    R._load_normals_model.cache_clear()
    results = []
    threads = [threading.Thread(target=lambda: results.append(R.estimate_normals(Image.new("RGB", (16, 12))))) for _ in range(3)]
    try:
        for th in threads:
            th.start()
        for th in threads:
            th.join()
    finally:
        R._load_normals_model.cache_clear()  # the real model must load for later tests
    assert len(loads) == 1 and len(results) == 3
    assert all(r.shape == (12, 16, 3) for r in results)
