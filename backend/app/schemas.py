"""Request and response shapes for every endpoint: the API contract.

The frontend's TypeScript types mirror this file. Images are base64 strings
(input may carry a `data:image/...;base64,` prefix; output never does).
Masks are PNGs the size of their image, white = the selected region.
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
    result: Any = None  # the idea-specific result model, once status is "done"
    error: str | None = None


class ImageIn(BaseModel):
    image: str


class CutoutOut(BaseModel):
    cutout: str  # PNG with a transparent background
    palette: list[str]  # hex colors, most common first


class ScoreIn(BaseModel):
    reference: str
    candidate: str
    prompt: str | None = None
    weights: dict[str, float] = {"identity": 0.6, "palette": 0.4}


class ScoreOut(BaseModel):
    scores: dict[str, float]
    total: float


# --- relight ----------------------------------------------------------------


class LightIn(BaseModel):
    x: float = Field(0.2, description="0 = left edge, 1 = right edge; may go outside 0..1")
    y: float = Field(0.2, description="0 = top edge, 1 = bottom edge")
    height: float = Field(0.25, gt=0, le=2, description="distance in front of the subject, in image widths")
    intensity: float = Field(1.5, ge=0, le=4)
    ambient: float = Field(0.12, ge=0, le=1)
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


class RelightRender(BaseModel):
    image: str  # JPEG


class RelightEnhanceIn(BaseModel):
    scene_id: str
    light: LightIn = LightIn()
    prompt: str = ""


# POST /relight/enhance returns JobRef; the job result is RelightRender.


# --- design autocomplete ------------------------------------------------------


class Region(BaseModel):
    id: str
    bbox: tuple[int, int, int, int]  # x, y, w, h in image pixels
    mask: str
    reason: str
    confidence: float


class DetectOut(BaseModel):
    width: int
    height: int
    regions: list[Region]  # most confident first


class MaskedImageIn(BaseModel):
    image: str
    mask: str


class Suggestion(BaseModel):
    label: str
    prompt: str


class PlanOut(BaseModel):
    analysis: str
    suggestions: list[Suggestion]


class FillIn(BaseModel):
    image: str
    mask: str
    prompt: str
    n: int = Field(4, ge=1, le=8)


class FillScores(BaseModel):
    style: float
    seam: float
    intent: float
    total: float


class FillCandidate(BaseModel):
    id: str
    image: str  # blended into the design
    raw: str  # straight from the generator, for the before/after comparison
    scores: FillScores


class FillResult(BaseModel):
    candidates: list[FillCandidate]  # best first


# POST /autocomplete/fill returns JobRef; the job result is FillResult.


# --- turnaround (character views) ---------------------------------------------

View = Literal["front", "three_quarter", "side", "back"]


class Feature(BaseModel):
    id: str
    name: str
    visible_from: list[View]
    critical: bool


class CharacterSpec(BaseModel):
    summary: str
    art_style: str
    features: list[Feature]
    palette: list[str]


class AnalyzeOut(BaseModel):
    character_id: str
    cutout: str
    source_view: View
    spec: CharacterSpec


class GenerateIn(BaseModel):
    character_id: str
    target_view: View
    features: list[Feature] | None = None  # the user's edited checklist, if they changed it


class ChecklistItem(BaseModel):
    feature_id: str
    expected_visible: bool
    present: bool


class ViewScores(BaseModel):
    identity: float
    palette: float
    checklist: float
    total: float


class Alternate(BaseModel):
    image: str
    total: float


class ViewResult(BaseModel):
    image: str
    scores: ViewScores
    checklist: list[ChecklistItem]
    retries: int
    alternates: list[Alternate]


# POST /turnaround/generate returns JobRef; the job result is ViewResult.
