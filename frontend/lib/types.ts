// TypeScript mirror of backend/app/schemas.py, field for field. Keep the two in sync.
//
// Images are base64 strings. Requests may carry a `data:image/...;base64,` prefix;
// responses never do. Masks are PNGs the size of their image, white = selected.
// A field that has a default in the Pydantic model is optional here.

// --- shared -------------------------------------------------------------------

export interface Health {
  ok: boolean;
  mock_mode: boolean;
  providers: Record<string, boolean>;
}

export interface JobRef {
  job_id: string;
}

/** Poll GET /jobs/{job_id} about once a second until status is not "pending". */
export interface JobStatus<T = unknown> {
  status: "pending" | "done" | "error";
  /** The idea-specific result model, once status is "done". */
  result: T | null;
  error: string | null;
}

export interface ImageIn {
  image: string;
}

export interface CutoutOut {
  /** PNG with a transparent background. */
  cutout: string;
  /** Hex colors, most common first. */
  palette: string[];
}

export interface ScoreIn {
  reference: string;
  candidate: string;
  prompt?: string | null;
  /** Default: { identity: 0.6, palette: 0.4 } */
  weights?: Record<string, number>;
}

export interface ScoreOut {
  scores: Record<string, number>;
  total: number;
}

// --- relight ------------------------------------------------------------------

export interface LightIn {
  /** 0 = left edge, 1 = right edge; may go outside 0..1. Default 0.2 */
  x?: number;
  /** 0 = top edge, 1 = bottom edge. Default 0.2 */
  y?: number;
  /** Distance in front of the subject, in image widths. 0 < height <= 2. Default 0.25 */
  height?: number;
  /** 0..4. Default 1.5 */
  intensity?: number;
  /** 0..1. Default 0.12 */
  ambient?: number;
  /** Linear RGB multiplier. Default [1, 1, 1] */
  color?: [number, number, number];
}

/** A LightIn with every field filled in, which is what the UI always holds. */
export type Light = Required<LightIn>;

export const DEFAULT_LIGHT: Light = {
  x: 0.2,
  y: 0.2,
  height: 0.25,
  intensity: 1.5,
  ambient: 0.12,
  color: [1, 1, 1],
};

export interface RelightSceneIn {
  image: string;
  /** Use the detailed normals model (slower, much better). Default true */
  detail?: boolean;
}

/** Everything the browser needs to shade the photo itself, live. */
export interface RelightScene {
  scene_id: string;
  width: number;
  height: number;
  /** The photo as the server sees it (resized if it was huge). */
  image: string;
  /** Grayscale PNG, white = near. */
  depth: string;
  /** RGB PNG: R = x (right), G = y (down), B = z (to viewer), each mapped -1..1 -> 0..255. */
  normals: string;
  /** Scene depth in image widths; z = depth * relief. */
  relief: number;
}

export interface RelightRenderIn {
  scene_id: string;
  light?: LightIn;
  /** Default true */
  shadows?: boolean;
}

export interface RelightRender {
  /** JPEG */
  image: string;
}

/** POST /relight/enhance returns JobRef; the job result is RelightRender. */
export interface RelightEnhanceIn {
  scene_id: string;
  light?: LightIn;
  /** Default "" */
  prompt?: string;
}

// --- design autocomplete --------------------------------------------------------

export interface Region {
  id: string;
  /** x, y, w, h in image pixels. */
  bbox: [number, number, number, number];
  mask: string;
  reason: string;
  confidence: number;
  /** Matching blocks the fill should resemble (x, y, w, h); pass to /fill as `references`. */
  siblings: [number, number, number, number][];
}

export interface DetectOut {
  width: number;
  height: number;
  /** Most confident first. */
  regions: Region[];
}

export interface MaskedImageIn {
  image: string;
  mask: string;
}

export interface Suggestion {
  label: string;
  prompt: string;
}

export interface PlanOut {
  analysis: string;
  suggestions: Suggestion[];
}

/** POST /autocomplete/fill returns JobRef; the job result is FillResult. */
export interface FillIn {
  image: string;
  mask: string;
  prompt: string;
  /** 1..8. Default 4 */
  n?: number;
  /** Boxes of elements the fill should look like (Region.siblings). Default [] */
  references?: [number, number, number, number][];
  /** True for "regenerate": skip the cache. Default false */
  fresh?: boolean;
}

export interface FillScores {
  style: number;
  seam: number;
  intent: number;
  total: number;
}

export interface FillCandidate {
  id: string;
  /** Blended into the design. */
  image: string;
  /** Straight from the generator, for the before/after comparison. */
  raw: string;
  scores: FillScores;
}

export interface FillResult {
  /** Best first. */
  candidates: FillCandidate[];
}

// --- turnaround (character views) -------------------------------------------------

export type View = "front" | "three_quarter" | "side" | "back";

export const VIEWS: View[] = ["front", "three_quarter", "side", "back"];

export interface Feature {
  id: string;
  name: string;
  visible_from: View[];
  critical: boolean;
}

export interface CharacterSpec {
  summary: string;
  art_style: string;
  features: Feature[];
  palette: string[];
}

export interface AnalyzeOut {
  character_id: string;
  cutout: string;
  source_view: View;
  spec: CharacterSpec;
}

/** POST /turnaround/generate returns JobRef; the job result is ViewResult. */
export interface GenerateIn {
  character_id: string;
  target_view: View;
  /** The user's edited checklist, if they changed it. */
  features?: Feature[] | null;
}

export interface ChecklistItem {
  feature_id: string;
  expected_visible: boolean;
  present: boolean;
}

export interface ViewScores {
  identity: number;
  palette: number;
  checklist: number;
  total: number;
}

export interface Alternate {
  image: string;
  total: number;
}

export interface ViewResult {
  image: string;
  scores: ViewScores;
  checklist: ChecklistItem[];
  retries: number;
  alternates: Alternate[];
}
