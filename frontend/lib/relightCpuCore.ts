// Relighting on the CPU, for browsers that cannot run the WebGL2 shader
// (lib/relightGL.ts). The maths is lib/relightMath.ts, untouched: this file only
// keeps what does not change between frames and chooses the size to work at.
//
// It has no DOM in it, so it runs the same in a Worker (lib/relightCpu.worker.js)
// and, where Workers are not to be had, on the page's own thread. lib/relightCPU.ts
// is the part the page talks to.

import {
  type SceneArrays,
  type ShadowField,
  type ShadowLayer,
  lightPosition,
  sceneArrays,
  shadePixels,
  shadowHeightField,
  shadowMap,
} from "./relightMath";
import type { FillLight, Light } from "./types";

/**
 * "full" is relightPixels() exactly: the picture the server would send.
 * "preview" is the same maths on a smaller copy of the scene, for while the
 * light is moving.
 */
export type CpuQuality = "preview" | "full";

/**
 * Preview: the longest side of the picture that is shaded, in pixels. The
 * browser stretches it back over the canvas. Smaller is faster and blurrier;
 * 384 keeps a face readable and shades in a few milliseconds on a laptop.
 */
export const PREVIEW_MAX_SIDE = 384;
/**
 * Preview: the longest side of the shadow map (256 at full quality). Marching
 * the shadows is most of the work and goes with the square of this, so half the
 * size is a quarter of the time. The blur is counted in shadow-map pixels, so
 * preview shadows are about twice as soft; they sharpen when the light stops.
 */
export const PREVIEW_SHADOW_SIDE = 128;

/** One picture's pixels, RGBA bytes as a canvas gives them. */
export interface CpuPixels {
  width: number;
  height: number;
  data: Uint8ClampedArray;
}

/** Everything the CPU renderer needs to know about a scene. All three pictures are the scene's size. */
export interface CpuSceneData {
  width: number;
  height: number;
  relief: number;
  image: CpuPixels;
  depth: CpuPixels;
  normals: CpuPixels;
  /** The same three, shrunk so the longest side is PREVIEW_MAX_SIDE at most. */
  preview: { image: CpuPixels; depth: CpuPixels; normals: CpuPixels };
}

export interface CpuFrame {
  quality: CpuQuality;
  width: number;
  height: number;
  /** RGBA bytes, ready for putImageData. */
  pixels: Uint8ClampedArray<ArrayBuffer>;
}

/** sceneArrays() only reads width, height and data, so plain pixels do (a Worker need not have ImageData). */
const arrays = (image: CpuPixels, depth: CpuPixels, normals: CpuPixels, relief: number): SceneArrays =>
  sceneArrays(image as ImageData, depth as ImageData, normals as ImageData, relief);

interface Level {
  scene: SceneArrays;
  field: ShadowField;
  /** The last shadow map and the light position it was made for: sliders that leave the light where it is reuse it. */
  shadow: { key: string; layer: ShadowLayer } | null;
}

export class CpuScene {
  private levels: Record<CpuQuality, Level>;

  constructor(data: CpuSceneData) {
    const full = arrays(data.image, data.depth, data.normals, data.relief);
    const preview = arrays(data.preview.image, data.preview.depth, data.preview.normals, data.relief);
    // shadowHeightField() sizes its map from the scene size it is told, capped at 256: telling it a smaller scene gives the smaller map.
    const shrink = Math.min(1, PREVIEW_SHADOW_SIDE / Math.max(full.width, full.height));
    this.levels = {
      full: { scene: full, field: shadowHeightField(full.depth, full.width, full.height, full.width, full.height, full.relief), shadow: null },
      preview: {
        scene: preview,
        field: shadowHeightField(full.depth, full.width, full.height, full.width * shrink, full.height * shrink, full.relief),
        shadow: null,
      },
    };
  }

  /** `fill` is the fill light, null when it is off. It casts no shadow, so the shadow map kept between frames is the main light's alone. */
  render(light: Light, castShadows: boolean, quality: CpuQuality, fill: FillLight | null = null): CpuFrame {
    const level = this.levels[quality];
    const { scene } = level;
    let shadow: ShadowLayer | null = null;
    if (castShadows) {
      const position = lightPosition(scene.width, scene.height, scene.relief, light);
      const key = position.join(",");
      if (level.shadow?.key !== key) {
        const { field } = level;
        level.shadow = { key, layer: { map: shadowMap(field, scene.relief, position), width: field.width, height: field.height } };
      }
      shadow = level.shadow.layer;
    }
    return { quality, width: scene.width, height: scene.height, pixels: shadePixels(scene, light, shadow, fill) };
  }
}

// --- what the page and the Worker say to each other ---------------------------------

export type CpuRequest =
  | { type: "scene"; data: CpuSceneData }
  | { type: "render"; id: number; light: Light; shadows: boolean; fill: FillLight | null; quality: CpuQuality };

export type CpuReply = { type: "frame"; id: number; frame: CpuFrame; ms: number } | { type: "error"; id: number; message: string };
