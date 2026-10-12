// TypeScript mirror of backend/app/schemas.py, field for field. Keep the two in sync.
//
// Images are base64 strings. Requests may carry a `data:image/...;base64,` prefix;
// responses never do.
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
  /** The result model (RelightRender), once status is "done". */
  result: T | null;
  error: string | null;
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

/**
 * A second, weaker light that lifts the shadows the main light leaves. It has a
 * place, a height, an intensity and a colour of its own. It casts no shadow,
 * and it has no ambient: that is shared, and is the main light's.
 */
export interface FillLightIn {
  /** 0 = left edge, 1 = right edge; may go outside 0..1. Default 0.8 */
  x?: number;
  /** 0 = top edge, 1 = bottom edge. Default 0.2 */
  y?: number;
  /** Distance in front of the subject, in image widths. 0 < height <= 2. Default 0.35 */
  height?: number;
  /** 0..4. Default 0.6 */
  intensity?: number;
  /** Linear RGB multiplier. Default [1, 1, 1] */
  color?: [number, number, number];
}

/** A FillLightIn with every field filled in. */
export type FillLight = Required<FillLightIn>;

export const DEFAULT_FILL: FillLight = {
  x: 0.8,
  y: 0.2,
  height: 0.35,
  intensity: 0.6,
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
  /** The fill light. Absent or null = off. */
  fill?: FillLightIn | null;
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
  /** Default true. Whether the render sent to the model has cast shadows. */
  shadows?: boolean;
  /** The fill light in the render sent to the model. Absent or null = off. */
  fill?: FillLightIn | null;
}
