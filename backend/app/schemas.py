"""Request and response shapes for every endpoint: the API contract.

The frontend's TypeScript types mirror this file. Images are base64 strings
(input may carry a `data:image/...;base64,` prefix; output never does).
"""

from typing import Any, Literal

from pydantic import BaseModel, Field

# --- shared -----------------------------------------------------------------


class Health(BaseModel):
    ok: bool = True
    mock_mode: bool
    providers: dict[str, bool]


class JobRef(BaseModel):
    job_id: str


class JobStatus(BaseModel):
    """Poll GET /jobs/{job_id} about once a second until status is not "pending"."""

    status: Literal["pending", "done", "error"]
    result: Any = None  # the result model (RelightRender), once status is "done"
    error: str | None = None


# --- relight ----------------------------------------------------------------


class LightIn(BaseModel):
    x: float = Field(0.2, description="0 = left edge, 1 = right edge; may go outside 0..1")
    y: float = Field(0.2, description="0 = top edge, 1 = bottom edge")
    height: float = Field(0.25, gt=0, le=2, description="distance in front of the subject, in image widths")
    intensity: float = Field(1.5, ge=0, le=4)
    ambient: float = Field(0.12, ge=0, le=1)
    color: tuple[float, float, float] = (1.0, 1.0, 1.0)


class FillLightIn(BaseModel):
    """A second, weaker light that lifts the shadows the main light leaves.

    It has a place, a height, an intensity and a colour of its own. It casts no
    shadow, and it has no ambient: that is shared, and is the main light's.
    The defaults are the main light's defaults mirrored to the other side.
    """

    x: float = Field(0.8, description="0 = left edge, 1 = right edge; may go outside 0..1")
    y: float = Field(0.2, description="0 = top edge, 1 = bottom edge")
    height: float = Field(0.35, gt=0, le=2, description="distance in front of the subject, in image widths")
    intensity: float = Field(0.6, ge=0, le=4)
    color: tuple[float, float, float] = (1.0, 1.0, 1.0)


class RelightSceneIn(BaseModel):
    image: str
    detail: bool = Field(True, description="use the detailed normals model (slower, much better)")


class RelightScene(BaseModel):
    """Everything the browser needs to shade the photo itself, live."""

    scene_id: str
    width: int
    height: int
    image: str  # the photo as the server sees it (resized if it was huge)
    depth: str  # grayscale PNG, white = near
    normals: str  # RGB PNG: R = x (right), G = y (down), B = z (to viewer), each mapped -1..1 -> 0..255
    relief: float  # scene depth in image widths; z = depth * relief


class RelightRenderIn(BaseModel):
    scene_id: str
    light: LightIn = LightIn()
    shadows: bool = True
    fill: FillLightIn | None = Field(None, description="the fill light; absent or null = off")


class RelightRender(BaseModel):
    image: str  # JPEG


class RelightEnhanceIn(BaseModel):
    scene_id: str
    light: LightIn = LightIn()
    shadows: bool = True  # match the preview on screen, which can have cast shadows switched off
    fill: FillLightIn | None = None  # and its fill light, when that is on
    prompt: str = ""


# POST /relight/enhance returns JobRef; the job result is RelightRender.
