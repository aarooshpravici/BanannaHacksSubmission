// Live relighting in a WebGL2 fragment shader: a port of
// backend/app/ideas/relight.py (diffuse, shadows, shading_map, apply_shading).
// lib/relightMath.ts is the same math on the CPU and is the reference for this.
//
// Four passes per frame, mirroring the Python step for step:
//   1. shadow march   at <= 256 px, 48 steps toward the light; what blocks the
//                     ray goes into a near, mid or far layer    (shadows(), the loop)
//   2. blur, rows     one Gaussian per layer, sigma 1, 3, 8 px  (cv2.GaussianBlur)
//   3. blur, columns  then the three layers are multiplied into one shadow map
//   4. shade          soft Lambert * falloff * shadow, multiplied into the photo in
//                     linear light with a highlight knee        (diffuse, apply_shading)
//      sampling pass 3 bilinearly, which is the cv2.resize back to full size.
// A fill light needs no pass of its own: it casts no shadow, so it is one more
// soft Lambert * falloff in pass 4 (fill_map), added only when it is switched on.
//
// Every texture is stored top row first, so texture row j is image row j and
// v = 0 is the top of the image. Only the final pass, which draws to the
// screen (where y points up), flips.
//
// What this needs from WebGL2, and what happens without it:
//   - The height field is an RGBA32F texture read with texelFetch (NEAREST).
//     Core WebGL2: float textures may always be sampled unfiltered, so
//     OES_texture_float_linear is NOT needed, here or anywhere else.
//   - The three shadow buffers are RGBA16F. Sampling and LINEAR-filtering
//     half-float is core; DRAWING into it is not and needs EXT_color_buffer_float
//     or EXT_color_buffer_half_float. Without either (many phones), the
//     "packed" grade keeps them in RGBA8, which is always drawable: the layers
//     at 8 bits, the finished shadow map as 16 bits spread over two channels,
//     which the shade pass unpacks and interpolates by hand.
//   - highp float in fragment shaders is required by GLSL ES 3.00 and the march
//     relies on it (positions to 1/32 of a pixel); the format is checked anyway.
//   - The blur's kernel is `BLUR_RADIUS + 1` vec3 uniforms (33; the minimum
//     MAX_FRAGMENT_UNIFORM_VECTORS is 224) and every loop has constant bounds.
//   - Textures and the canvas are at most the scene's size, checked against
//     MAX_TEXTURE_SIZE (at least 2048) when a scene is set.
// Whatever is missing, wrong or refused, the constructor or setScene throws
// and the caller (components/relight/RelightCanvas.tsx) shades on the CPU instead.

import {
  HIGHLIGHT_KNEE,
  MAX_FALLOFF,
  REMAP_SUBPIXEL,
  SHADOW_BIAS,
  SHADOW_BLUR_SIGMAS,
  SHADOW_FAR_STRENGTH,
  SHADOW_GAP_FAR,
  SHADOW_GAP_MID,
  SHADOW_GAP_NEAR,
  SHADOW_SOFTNESS,
  SHADOW_STEPS,
  TERMINATOR_SOFTNESS,
  gaussianKernel,
  lightPosition,
  relightPixels,
  sceneArrays,
  shadowHeightField,
} from "./relightMath";
import type { FillLight, Light } from "./types";

const f = (n: number) => (Number.isInteger(n) ? `${n}.0` : `${n}`);

const VERTEX = `#version 300 es
in vec2 a_pos;
uniform float u_flip; // 1.0 when drawing to the screen
out vec2 v_uv;
void main() {
  vec2 uv = a_pos * 0.5 + 0.5;
  v_uv = vec2(uv.x, mix(uv.y, 1.0 - uv.y, u_flip));
  gl_Position = vec4(a_pos, 0.0, 1.0);
}`;

// shadows(), the loop: for every pixel, walk toward the light and see whether
// the height field rises above the ray. Output the near, mid and far occlusion
// layers in R, G and B. The built-in smoothstep is relight.py's _smoothstep.
const SHADOW_FRAGMENT = `#version 300 es
precision highp float;
precision highp sampler2D;
uniform sampler2D u_z;   // shadow resolution, image widths: R = z, G = crest (dilated z), B = floor (eroded z)
uniform ivec2 u_size;    // shadow resolution (w, h)
uniform vec3 u_light;    // light position in image widths
uniform float u_relief;
out vec4 o_color;

vec2 fetchZ(ivec2 p) {
  if (p.x < 0 || p.y < 0 || p.x >= u_size.x || p.y >= u_size.y) return vec2(0.0); // BORDER_CONSTANT, 0
  return texelFetch(u_z, p, 0).rg;
}

// cv2.remap(z, x, y, INTER_LINEAR) and the same for crest: integer coordinates
// are pixel centres and the fraction is snapped to 1/32 of a pixel.
vec2 sampleZ(vec2 p) {
  p = floor(p * ${f(REMAP_SUBPIXEL)} + 0.5) / ${f(REMAP_SUBPIXEL)};
  vec2 base = floor(p);
  vec2 a = p - base;
  ivec2 i = ivec2(base);
  vec2 top = mix(fetchZ(i), fetchZ(i + ivec2(1, 0)), a.x);
  vec2 bottom = mix(fetchZ(i + ivec2(0, 1)), fetchZ(i + ivec2(1, 1)), a.x);
  return mix(top, bottom, a.y);
}

void main() {
  float w = float(u_size.x);
  vec3 here = texelFetch(u_z, ivec2(gl_FragCoord.xy), 0).rgb;
  // gl_FragCoord is (i + 0.5, j + 0.5): dividing by the width gives positions
  // in image widths for both axes, which keeps the aspect ratio.
  vec3 p = vec3(gl_FragCoord.xy / w, here.r);
  float floorZ = here.b;
  // The ray can only be blocked while it is below the tallest surface.
  float tEnd = clamp((u_relief - p.z) / max(u_light.z - p.z, 1e-6), 0.0, 1.0);
  float bias = ${f(SHADOW_BIAS)} * u_relief; // skip the start so a surface does not shadow itself
  float nearLayer = 0.0; // "near" and "far" alone read too much like GLSL keywords
  float midLayer = 0.0;
  float farLayer = 0.0;
  for (int i = 1; i <= ${SHADOW_STEPS}; i++) {
    float t = tEnd * (float(i) / ${f(SHADOW_STEPS)});
    vec3 q = p + (u_light - p) * t;
    vec2 surface = sampleZ(q.xy * w - 0.5); // x = surface, y = top
    float occlusion = clamp((surface.x - q.z - bias) / ${f(SHADOW_SOFTNESS)}, 0.0, 1.0);
    float gap = (surface.y - floorZ) / u_relief;
    float toMid = smoothstep(${f(SHADOW_GAP_NEAR)}, ${f(SHADOW_GAP_MID)}, gap);
    float toFar = smoothstep(${f(SHADOW_GAP_MID)}, ${f(SHADOW_GAP_FAR)}, gap);
    occlusion = occlusion * (1.0 - (1.0 - ${f(SHADOW_FAR_STRENGTH)}) * smoothstep(${f(SHADOW_GAP_NEAR)}, ${f(SHADOW_GAP_FAR)}, gap));
    nearLayer = max(nearLayer, occlusion * (1.0 - toMid));
    midLayer = max(midLayer, occlusion * toMid * (1.0 - toFar));
    farLayer = max(farLayer, occlusion * toMid * toFar);
  }
  o_color = vec4(nearLayer, midLayer, farLayer, 1.0);
}`;

// One kernel per layer, padded with zeros to the length of the widest so a
// single loop blurs all three: entry k holds the three weights at distance k.
const BLUR_KERNELS = SHADOW_BLUR_SIGMAS.map(gaussianKernel);
const BLUR_RADIUS = Math.max(...BLUR_KERNELS.map((kernel) => kernel.length)) - 1;
const BLUR_WEIGHTS = new Float32Array((BLUR_RADIUS + 1) * 3);
BLUR_KERNELS.forEach((kernel, layer) => kernel.forEach((weight, k) => (BLUR_WEIGHTS[k * 3 + layer] = weight)));

// One direction of cv2.GaussianBlur(layer, (0, 0), sigma), BORDER_REFLECT_101,
// for the three layers at once. The second direction also multiplies the layers
// into the finished shadow map: lit = (1 - near) * (1 - mid) * (1 - far).
const BLUR_FRAGMENT = `#version 300 es
precision highp float;
precision highp sampler2D;
uniform sampler2D u_src;
uniform ivec2 u_size;
uniform ivec2 u_dir;
uniform float u_final; // 1.0 on the second direction
uniform float u_packed; // 1.0 when the targets are 8-bit: the finished map goes out as 16 bits over R and G
uniform vec3 u_kernel[${BLUR_RADIUS + 1}];
out vec4 o_color;

int reflect101(int i, int n) {
  if (n == 1) return 0;
  int period = 2 * (n - 1);
  i = abs(i) % period;
  return i >= n ? period - i : i;
}

void main() {
  ivec2 p = ivec2(gl_FragCoord.xy);
  vec3 acc = vec3(0.0);
  for (int k = -${BLUR_RADIUS}; k <= ${BLUR_RADIUS}; k++) {
    ivec2 q = p + u_dir * k;
    q = ivec2(reflect101(q.x, u_size.x), reflect101(q.y, u_size.y));
    acc += u_kernel[abs(k)] * texelFetch(u_src, q, 0).rgb;
  }
  float lit = (1.0 - acc.r) * (1.0 - acc.g) * (1.0 - acc.b);
  if (u_final < 0.5) {
    o_color = vec4(acc, 1.0);
  } else if (u_packed > 0.5) {
    float steps = floor(clamp(lit, 0.0, 1.0) * 65535.0 + 0.5);
    float high = floor(steps / 256.0);
    o_color = vec4(high / 255.0, (steps - high * 256.0) / 255.0, 0.0, 1.0);
  } else {
    o_color = vec4(lit, 0.0, 0.0, 1.0);
  }
}`;

// diffuse() -> shading_map() -> apply_shading().
const SHADE_FRAGMENT = `#version 300 es
precision highp float;
precision highp sampler2D;
uniform sampler2D u_image;   // the photo, sRGB
uniform sampler2D u_depth;   // nearness, white = near
uniform sampler2D u_normals; // n * 0.5 + 0.5; R = x right, G = y DOWN, B = z to viewer
uniform sampler2D u_shadow;  // 1 = lit, shadow resolution
uniform float u_aspect;      // H / W
uniform float u_relief;
uniform vec3 u_light;        // light position in image widths
uniform float u_intensity;
uniform float u_ambient;
uniform vec3 u_color;
uniform float u_shadows;     // 1.0 = cast shadows
uniform float u_packed;      // 1.0 = u_shadow holds 16-bit values over R and G (see the blur pass)
uniform float u_fill;        // 1.0 = there is a fill light; the three below are its own
uniform vec3 u_fillLight;    // its position in image widths
uniform float u_fillIntensity;
uniform vec3 u_fillColor;
in vec2 v_uv;
out vec4 o_color;

vec3 srgbToLinear(vec3 c) {
  return mix(pow((c + 0.055) / 1.055, vec3(2.4)), c / 12.92, lessThanEqual(c, vec3(0.04045)));
}

vec3 linearToSrgb(vec3 c) {
  return mix(1.055 * pow(max(c, vec3(1e-8)), vec3(1.0 / 2.4)) - 0.055, c * 12.92, lessThanEqual(c, vec3(0.0031308)));
}

// _soft_terminator: max(cos, 0) with the corner rounded off.
float softTerminator(float cosTheta) {
  const float k = ${f(TERMINATOR_SOFTNESS)};
  float eased = max(cosTheta + k, 0.0) * max(cosTheta + k, 0.0) / (4.0 * k);
  return cosTheta >= k ? cosTheta : eased;
}

float unpackShadow(ivec2 p, ivec2 size) {
  vec2 bytes = floor(texelFetch(u_shadow, clamp(p, ivec2(0), size - 1), 0).rg * 255.0 + 0.5);
  return (bytes.x * 256.0 + bytes.y) / 65535.0;
}

// What texture() with LINEAR and CLAMP_TO_EDGE does, for the packed map, whose
// two bytes cannot be interpolated separately.
float packedShadow(vec2 uv) {
  ivec2 size = textureSize(u_shadow, 0);
  vec2 p = uv * vec2(size) - 0.5;
  vec2 base = floor(p);
  vec2 a = p - base;
  ivec2 i = ivec2(base);
  float top = mix(unpackShadow(i, size), unpackShadow(i + ivec2(1, 0), size), a.x);
  float bottom = mix(unpackShadow(i + ivec2(0, 1), size), unpackShadow(i + ivec2(1, 1), size), a.x);
  return mix(top, bottom, a.y);
}

// fill_map(): diffuse() once more, for the fill light, times its intensity. No
// shadow and no ambient. The lines are main()'s own, repeated here and not
// shared with it, so that the main light's arithmetic is the text it always was.
float fillShading(vec3 position, vec3 normal) {
  vec3 toLight = u_fillLight - position;
  float dist = max(length(toLight), 1e-6);
  float cosTheta = dot(normal, toLight) / dist;
  vec3 centre = vec3(0.5, 0.5 * u_aspect, u_relief / 2.0);
  float reference = length(u_fillLight - centre);
  float ratio = reference / dist;
  float falloff = min(ratio * ratio, ${f(MAX_FALLOFF)});
  return u_fillIntensity * (min(softTerminator(cosTheta), 1.0) * falloff);
}

void main() {
  vec4 photo = texture(u_image, v_uv);
  vec3 rgb = mix(vec3(1.0), photo.rgb, photo.a); // to_rgb(): transparency flattens onto white

  // _pixel_positions(): x in [0, 1], y in [0, H/W], z = depth * relief.
  vec3 position = vec3(v_uv.x, v_uv.y * u_aspect, texture(u_depth, v_uv).r * u_relief);
  vec3 normal = normalize(texture(u_normals, v_uv).rgb * 2.0 - 1.0);

  // diffuse(): Lambert, eased to nothing where the surface turns away, with
  // inverse-square falloff measured relative to the centre of the scene so
  // moving the light does not change overall exposure.
  vec3 toLight = u_light - position;
  float dist = max(length(toLight), 1e-6);
  float cosTheta = dot(normal, toLight) / dist;
  vec3 centre = vec3(0.5, 0.5 * u_aspect, u_relief / 2.0);
  float reference = length(u_light - centre);
  float ratio = reference / dist;
  float falloff = min(ratio * ratio, ${f(MAX_FALLOFF)});
  float direct = min(softTerminator(cosTheta), 1.0) * falloff;

  // shading_map(): ambient + intensity * diffuse * shadows.
  if (u_shadows > 0.5) direct *= u_packed > 0.5 ? packedShadow(v_uv) : texture(u_shadow, v_uv).r;
  float shading = u_ambient + u_intensity * direct;

  // apply_shading(): multiply in linear light; above the knee, roll off instead of clipping.
  vec3 lit = srgbToLinear(rgb) * shading * u_color;
  // The fill light: the photo times its share, in its colour. Added to the line
  // above and only when it is on, so that with it off that line is the result,
  // as before.
  if (u_fill > 0.5) lit = lit + srgbToLinear(rgb) * fillShading(position, normal) * u_fillColor;
  const float knee = ${f(HIGHLIGHT_KNEE)};
  vec3 over = max(lit - knee, 0.0);
  lit = mix(lit, knee + (1.0 - knee) * (1.0 - exp(-over / (1.0 - knee))), greaterThan(lit, vec3(knee)));
  o_color = vec4(clamp(linearToSrgb(lit), 0.0, 1.0), 1.0);
}`;

/** A decoded picture: what createImageBitmap returns, or raw pixels. */
type Pixels = ImageBitmap | ImageData;

export interface RelightSceneData {
  width: number;
  height: number;
  relief: number;
  image: Pixels;
  depth: Pixels;
  normals: Pixels;
}

/**
 * How the shadow buffers are kept, chosen once per context:
 *   "full"    half-float buffers (needs a float colour-buffer extension)
 *   "packed"  8-bit buffers, which every WebGL2 context can draw into
 */
export type GpuGrade = "full" | "packed";

export interface GpuReport {
  grade: GpuGrade;
  /** Why the grade is not "full", in plain words; null when it is. */
  why: string | null;
  /** The graphics chip's own name, where the browser gives it out (for bug reports). */
  chip: string;
  /** Mean difference from the CPU reference on the built-in test scene, in 8-bit levels. */
  selfTestMean: number;
}

/**
 * The fewest bits of precision a fragment shader's highp float may have.
 * GLSL ES 3.00 demands 23 (a 32-bit float); the shadow march needs about 13
 * for its 1/32-pixel positions in a 256-pixel map, plus headroom for the
 * differences of nearly equal heights.
 */
const MIN_HIGHP_FLOAT_BITS = 23;

/**
 * The self-test: how far, on average, the picture the GPU draws of a small
 * built-in scene may be from the CPU reference, in 8-bit levels. A healthy GPU
 * is well under 1; shadows missing altogether, or garbage in a buffer, is
 * several times this. Set too low it would turn working GPUs away to the much
 * slower CPU path; too high and a broken driver gets through.
 */
const SELF_TEST_MAX_MEAN = 3;
const SELF_TEST_WIDTH = 64;
const SELF_TEST_HEIGHT = 48;
const SELF_TEST_RELIEF = 0.3;
/**
 * Low and to the left, so the block in the test scene throws a long shadow
 * across it. Stronger than before the test picture had a fill light (2.4, from
 * 1.8): the fill lifts that shadow a little, and with the old strength a chip
 * that drew no shadows at all would have slipped under SELF_TEST_MAX_MEAN.
 */
const SELF_TEST_LIGHT: Light = { x: 0.05, y: 0.45, height: 0.12, intensity: 2.4, ambient: 0.06, color: [1, 0.9, 0.8] };
/**
 * The test picture's fill light, so that a chip that gets the fill wrong is
 * caught by the same one picture. Off the left edge, low, and in a colour of
 * its own, where it adds most to the lit side and least to the block's shadow.
 * Measured with lib/relightMath.ts: a picture drawn without the fill is off by
 * 10.0 levels on average, and one without the shadows by 3.4 (3.1 before there
 * was a fill), both over the limit.
 */
const SELF_TEST_FILL: FillLight = { x: -0.4, y: 0.6, height: 0.05, intensity: 0.6, color: [0.7, 0.86, 1] };

/** A floor sloping gently away, with a raised block in the middle: every part of the shader has something to do. */
function selfTestScene(): { image: ImageData; depth: ImageData; normals: ImageData } {
  const w = SELF_TEST_WIDTH;
  const h = SELF_TEST_HEIGHT;
  const image = new ImageData(w, h);
  const depth = new ImageData(w, h);
  const normals = new ImageData(w, h);
  for (let j = 0; j < h; j++) {
    for (let i = 0; i < w; i++) {
      const p = (j * w + i) * 4;
      const block = i >= 24 && i < 40 && j >= 16 && j < 32;
      image.data.set([90 + i * 2, 200 - j * 2, 120 + ((i * j) % 64), 255], p);
      const near = block ? 230 : 40 + Math.round((j / h) * 30);
      depth.data.set([near, near, near, 255], p);
      // Mostly facing the viewer, tilting across the picture so the diffuse term varies.
      normals.data.set([128 + Math.round((i / w - 0.5) * 80), 128 + Math.round((j / h - 0.5) * 80), 235, 255], p);
    }
  }
  return { image, depth, normals };
}

interface Program {
  program: WebGLProgram;
  uniforms: Record<string, WebGLUniformLocation | null>;
}

interface Target {
  texture: WebGLTexture;
  framebuffer: WebGLFramebuffer;
}

interface SceneState {
  width: number;
  height: number;
  relief: number;
  image: WebGLTexture;
  depth: WebGLTexture;
  normals: WebGLTexture;
  z: WebGLTexture;
  shadowWidth: number;
  shadowHeight: number;
  /** the three layers as marched, the layers row-blurred, the finished shadow map */
  targets: [Target, Target, Target];
}

export class RelightRenderer {
  private gl: WebGL2RenderingContext;
  private shadowProgram: Program;
  private blurProgram: Program;
  private shadeProgram: Program;
  private vao: WebGLVertexArrayObject;
  private quad: WebGLBuffer;
  private grade: GpuGrade = "packed";
  private why: string | null = null;
  private chip = "unknown";
  private selfTestMean = 0;
  private scene: SceneState | null = null;

  /**
   * Throws, with a message fit to show the user, if WebGL2 is not available, a
   * shader fails to compile or link, or the GPU draws the built-in test scene
   * wrongly in every grade. Driver logs go to the console.
   */
  constructor(private canvas: HTMLCanvasElement) {
    const gl = canvas.getContext("webgl2", {
      alpha: false,
      antialias: false,
      depth: false,
      premultipliedAlpha: false,
      preserveDrawingBuffer: true, // so Export and snapshots can read the canvas at any time
    });
    if (!gl) throw new Error("WebGL2 is not available in this browser");
    if (gl.isContextLost()) throw new Error("the browser has switched its graphics context off");
    this.gl = gl;

    const precision = gl.getShaderPrecisionFormat(gl.FRAGMENT_SHADER, gl.HIGH_FLOAT);
    if (!precision || precision.precision < MIN_HIGHP_FLOAT_BITS) {
      throw new Error("this graphics chip's shaders do not compute precisely enough");
    }
    const info = gl.getExtension("WEBGL_debug_renderer_info");
    if (info) this.chip = String(gl.getParameter(info.UNMASKED_RENDERER_WEBGL));
    // Either extension makes RGBA16F something a shader can draw into.
    const floatTargets = gl.getExtension("EXT_color_buffer_float") !== null || gl.getExtension("EXT_color_buffer_half_float") !== null;

    this.shadowProgram = this.link(SHADOW_FRAGMENT, ["u_flip", "u_z", "u_size", "u_light", "u_relief"]);
    this.blurProgram = this.link(BLUR_FRAGMENT, ["u_flip", "u_src", "u_size", "u_dir", "u_final", "u_packed", "u_kernel"]);
    this.shadeProgram = this.link(SHADE_FRAGMENT, [
      "u_flip", "u_image", "u_depth", "u_normals", "u_shadow", "u_aspect", "u_relief",
      "u_light", "u_intensity", "u_ambient", "u_color", "u_shadows", "u_packed",
      "u_fill", "u_fillLight", "u_fillIntensity", "u_fillColor",
    ]);

    // One oversized triangle covers the viewport.
    const vao = gl.createVertexArray();
    const quad = gl.createBuffer();
    if (!vao || !quad) throw new Error("the graphics chip is out of memory");
    this.vao = vao;
    this.quad = quad;
    gl.bindVertexArray(vao);
    gl.bindBuffer(gl.ARRAY_BUFFER, quad);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]), gl.STATIC_DRAW);
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);

    this.chooseGrade(floatTargets);
  }

  /** Which grade is in use and why: fixed once the constructor returns, unless a scene's buffers are refused. */
  get report(): GpuReport {
    return { grade: this.grade, why: this.why, chip: this.chip, selfTestMean: this.selfTestMean };
  }

  /**
   * Try each grade the context claims to support, best first, on the built-in
   * test scene, and keep the first whose picture matches the CPU reference.
   * An extension being listed is not proof that it works on this driver.
   */
  private chooseGrade(floatTargets: boolean): void {
    const test = selfTestScene();
    const reference = relightPixels(sceneArrays(test.image, test.depth, test.normals, SELF_TEST_RELIEF), SELF_TEST_LIGHT, true, SELF_TEST_FILL);
    let why: string | null = floatTargets ? null : "this graphics chip cannot draw into floating-point buffers";
    for (const grade of floatTargets ? (["full", "packed"] as const) : (["packed"] as const)) {
      this.grade = grade;
      try {
        this.setScene({ width: SELF_TEST_WIDTH, height: SELF_TEST_HEIGHT, relief: SELF_TEST_RELIEF, ...test });
        if (this.grade !== grade) throw new Error("the shadow buffers were refused"); // setScene stepped down by itself
        this.render(SELF_TEST_LIGHT, true, SELF_TEST_FILL);
        const drawn = this.readPixels();
        let sum = 0;
        for (let p = 0; p < drawn.length; p += 4) {
          sum += Math.abs(drawn[p] - reference[p]) + Math.abs(drawn[p + 1] - reference[p + 1]) + Math.abs(drawn[p + 2] - reference[p + 2]);
        }
        const mean = sum / ((drawn.length / 4) * 3);
        if (!(mean <= SELF_TEST_MAX_MEAN)) throw new Error(`the test picture is off by ${mean.toFixed(1)} levels on average`);
        this.selfTestMean = mean;
        this.why = why;
        this.freeScene();
        return;
      } catch (error) {
        console.warn(`Relight: the "${grade}" GPU path failed its self-test on ${this.chip}:`, error);
        why = "floating-point shadow buffers do not work on this graphics chip";
        this.freeScene();
      }
    }
    throw new Error("this graphics chip drew a test picture wrongly");
  }

  private compile(type: number, source: string): WebGLShader {
    const gl = this.gl;
    const shader = gl.createShader(type);
    if (!shader) throw new Error("the graphics chip is out of memory");
    gl.shaderSource(shader, source);
    gl.compileShader(shader);
    if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
      // The driver's log is for whoever debugs this; the user gets one plain sentence.
      console.warn("Relight: a shader failed to compile.", gl.getShaderInfoLog(shader));
      gl.deleteShader(shader);
      throw new Error("the shader did not compile on this graphics chip");
    }
    return shader;
  }

  private link(fragment: string, uniformNames: string[]): Program {
    const gl = this.gl;
    const program = gl.createProgram();
    if (!program) throw new Error("the graphics chip is out of memory");
    const vs = this.compile(gl.VERTEX_SHADER, VERTEX);
    const fs = this.compile(gl.FRAGMENT_SHADER, fragment);
    gl.attachShader(program, vs);
    gl.attachShader(program, fs);
    gl.bindAttribLocation(program, 0, "a_pos");
    gl.linkProgram(program);
    gl.deleteShader(vs);
    gl.deleteShader(fs);
    if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
      console.warn("Relight: a shader program failed to link.", gl.getProgramInfoLog(program));
      gl.deleteProgram(program);
      throw new Error("the shader did not link on this graphics chip");
    }
    const uniforms: Program["uniforms"] = {};
    for (const name of uniformNames) uniforms[name] = gl.getUniformLocation(program, name);
    return { program, uniforms };
  }

  private texture(filter: number): WebGLTexture {
    const gl = this.gl;
    const texture = gl.createTexture();
    if (!texture) throw new Error("the graphics chip is out of memory");
    gl.bindTexture(gl.TEXTURE_2D, texture);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, filter);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, filter);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    return texture;
  }

  private pixelTexture(pixels: Pixels): WebGLTexture {
    const gl = this.gl;
    const texture = this.texture(gl.LINEAR);
    // The bytes of the PNG must reach the shader untouched, top row first.
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
    gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false);
    gl.pixelStorei(gl.UNPACK_COLORSPACE_CONVERSION_WEBGL, gl.NONE);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, pixels);
    return texture;
  }

  private target(width: number, height: number, filter: number): Target {
    const gl = this.gl;
    const texture = this.texture(filter);
    // Four channels: the march and the first blur carry one shadow layer in each of R, G and B.
    if (this.grade === "full") gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA16F, width, height, 0, gl.RGBA, gl.HALF_FLOAT, null);
    else gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, width, height, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
    const framebuffer = gl.createFramebuffer();
    if (!framebuffer) throw new Error("the graphics chip is out of memory");
    gl.bindFramebuffer(gl.FRAMEBUFFER, framebuffer);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, texture, 0);
    const status = gl.checkFramebufferStatus(gl.FRAMEBUFFER);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    if (status !== gl.FRAMEBUFFER_COMPLETE) {
      gl.deleteTexture(texture);
      gl.deleteFramebuffer(framebuffer);
      throw new Error("the graphics chip refused a shadow buffer");
    }
    return { texture, framebuffer };
  }

  private freeScene(): void {
    const gl = this.gl;
    const scene = this.scene;
    if (!scene) return;
    for (const texture of [scene.image, scene.depth, scene.normals, scene.z]) gl.deleteTexture(texture);
    for (const target of scene.targets) {
      gl.deleteTexture(target.texture);
      gl.deleteFramebuffer(target.framebuffer);
    }
    this.scene = null;
  }

  /** Upload a scene. The canvas takes the scene's pixel size. Throws if the GPU cannot hold it. */
  setScene(data: RelightSceneData): void {
    const gl = this.gl;
    this.freeScene();
    const limit = gl.getParameter(gl.MAX_TEXTURE_SIZE) as number;
    if (Math.max(data.width, data.height) > limit) throw new Error(`the photo is larger than this graphics chip can hold (${limit} pixels a side)`);
    this.canvas.width = data.width;
    this.canvas.height = data.height;
    // A browser short of memory hands back a smaller drawing buffer than it was asked for.
    if (gl.drawingBufferWidth !== data.width || gl.drawingBufferHeight !== data.height) throw new Error("the browser could not make a canvas the size of the photo");
    while (gl.getError() !== gl.NO_ERROR); // start clean, so the check at the end is about this scene

    // The height field the shadow pass marches: the depth map, area-averaged
    // down to the shadow resolution on the CPU (cv2.resize INTER_AREA), as
    // floats, with its dilated and eroded copies in the next two channels.
    let pixels: Uint8ClampedArray;
    if (data.depth instanceof ImageData) {
      pixels = data.depth.data;
    } else {
      const probe = document.createElement("canvas");
      probe.width = data.depth.width;
      probe.height = data.depth.height;
      const ctx = probe.getContext("2d", { willReadFrequently: true });
      if (!ctx) throw new Error("this browser could not create a 2D canvas");
      ctx.drawImage(data.depth, 0, 0);
      pixels = ctx.getImageData(0, 0, probe.width, probe.height).data;
    }
    const depth = new Float32Array(data.depth.width * data.depth.height);
    for (let i = 0; i < depth.length; i++) depth[i] = pixels[i * 4] / 255;
    const field = shadowHeightField(depth, data.depth.width, data.depth.height, data.width, data.height, data.relief);

    const packed = new Float32Array(field.width * field.height * 4);
    for (let i = 0; i < field.z.length; i++) {
      packed[i * 4] = field.z[i];
      packed[i * 4 + 1] = field.crest[i];
      packed[i * 4 + 2] = field.floor[i];
    }
    const z = this.texture(gl.NEAREST);
    gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA32F, field.width, field.height, 0, gl.RGBA, gl.FLOAT, packed);

    let targets: SceneState["targets"];
    try {
      targets = this.makeTargets(field.width, field.height);
    } catch (error) {
      if (this.grade !== "full") {
        gl.deleteTexture(z);
        throw error;
      }
      // Some drivers advertise float targets and then refuse them.
      this.grade = "packed";
      this.why = "this graphics chip refused floating-point shadow buffers";
      targets = this.makeTargets(field.width, field.height);
    }

    this.scene = {
      width: data.width,
      height: data.height,
      relief: data.relief,
      image: this.pixelTexture(data.image),
      depth: this.pixelTexture(data.depth),
      normals: this.pixelTexture(data.normals),
      z,
      shadowWidth: field.width,
      shadowHeight: field.height,
      targets,
    };
    const problem = gl.getError();
    if (problem !== gl.NO_ERROR) {
      this.freeScene();
      throw new Error(problem === gl.OUT_OF_MEMORY ? "the graphics chip is out of memory" : `the graphics chip refused the photo (WebGL error ${problem})`);
    }
  }

  private makeTargets(width: number, height: number): SceneState["targets"] {
    const gl = this.gl;
    const made: Target[] = [];
    try {
      // The last one is sampled bilinearly by the shade pass: that is the
      // cv2.resize(lit, full size, INTER_LINEAR) at the end of shadows(). Half-float
      // lets the GPU do it; the packed map is interpolated in the shader instead.
      for (const filter of [gl.NEAREST, gl.NEAREST, this.grade === "full" ? gl.LINEAR : gl.NEAREST]) made.push(this.target(width, height, filter));
    } catch (error) {
      for (const target of made) {
        gl.deleteTexture(target.texture);
        gl.deleteFramebuffer(target.framebuffer);
      }
      throw error;
    }
    return made as SceneState["targets"];
  }

  private bind(unit: number, texture: WebGLTexture, location: WebGLUniformLocation | null): void {
    const gl = this.gl;
    gl.activeTexture(gl.TEXTURE0 + unit);
    gl.bindTexture(gl.TEXTURE_2D, texture);
    gl.uniform1i(location, unit);
  }

  /** Draw the scene lit by `light`, and by `fill` when there is one (it casts no shadow). Cheap enough to call on every pointer move. */
  render(light: Light, castShadows: boolean, fill: FillLight | null = null): void {
    const gl = this.gl;
    const scene = this.scene;
    if (!scene || gl.isContextLost()) return;
    const lightPos = lightPosition(scene.width, scene.height, scene.relief, light);
    const packed = this.grade === "packed" ? 1 : 0;
    gl.bindVertexArray(this.vao);
    gl.disable(gl.BLEND);
    gl.disable(gl.DEPTH_TEST);

    if (castShadows) {
      const [march, rows, blurred] = scene.targets;
      gl.viewport(0, 0, scene.shadowWidth, scene.shadowHeight);

      let u = this.shadowProgram.uniforms;
      gl.useProgram(this.shadowProgram.program);
      gl.bindFramebuffer(gl.FRAMEBUFFER, march.framebuffer);
      gl.uniform1f(u.u_flip, 0);
      this.bind(0, scene.z, u.u_z);
      gl.uniform2i(u.u_size, scene.shadowWidth, scene.shadowHeight);
      gl.uniform3f(u.u_light, lightPos[0], lightPos[1], lightPos[2]);
      gl.uniform1f(u.u_relief, scene.relief);
      gl.drawArrays(gl.TRIANGLES, 0, 3);

      u = this.blurProgram.uniforms;
      gl.useProgram(this.blurProgram.program);
      gl.uniform1f(u.u_flip, 0);
      gl.uniform2i(u.u_size, scene.shadowWidth, scene.shadowHeight);
      gl.uniform3fv(u.u_kernel, BLUR_WEIGHTS);
      gl.uniform1f(u.u_packed, packed);
      gl.bindFramebuffer(gl.FRAMEBUFFER, rows.framebuffer);
      this.bind(0, march.texture, u.u_src);
      gl.uniform2i(u.u_dir, 1, 0);
      gl.uniform1f(u.u_final, 0);
      gl.drawArrays(gl.TRIANGLES, 0, 3);
      gl.bindFramebuffer(gl.FRAMEBUFFER, blurred.framebuffer);
      this.bind(0, rows.texture, u.u_src);
      gl.uniform2i(u.u_dir, 0, 1);
      gl.uniform1f(u.u_final, 1);
      gl.drawArrays(gl.TRIANGLES, 0, 3);
    }

    const u = this.shadeProgram.uniforms;
    gl.useProgram(this.shadeProgram.program);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.viewport(0, 0, scene.width, scene.height);
    gl.uniform1f(u.u_flip, 1);
    this.bind(0, scene.image, u.u_image);
    this.bind(1, scene.depth, u.u_depth);
    this.bind(2, scene.normals, u.u_normals);
    this.bind(3, scene.targets[2].texture, u.u_shadow);
    gl.uniform1f(u.u_aspect, scene.height / scene.width);
    gl.uniform1f(u.u_relief, scene.relief);
    gl.uniform3f(u.u_light, lightPos[0], lightPos[1], lightPos[2]);
    gl.uniform1f(u.u_intensity, light.intensity);
    gl.uniform1f(u.u_ambient, light.ambient);
    gl.uniform3f(u.u_color, light.color[0], light.color[1], light.color[2]);
    gl.uniform1f(u.u_shadows, castShadows ? 1 : 0);
    gl.uniform1f(u.u_packed, packed);
    gl.uniform1f(u.u_fill, fill ? 1 : 0);
    if (fill) {
      const fillPos = lightPosition(scene.width, scene.height, scene.relief, fill);
      gl.uniform3f(u.u_fillLight, fillPos[0], fillPos[1], fillPos[2]);
      gl.uniform1f(u.u_fillIntensity, fill.intensity);
      gl.uniform3f(u.u_fillColor, fill.color[0], fill.color[1], fill.color[2]);
    }
    gl.drawArrays(gl.TRIANGLES, 0, 3);
  }

  /**
   * The current frame as RGBA bytes, top row first (for the self-test and comparisons).
   * Call right after render().
   */
  readPixels(): Uint8Array {
    const gl = this.gl;
    const { width, height } = this.canvas;
    const raw = new Uint8Array(width * height * 4);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.pixelStorei(gl.PACK_ALIGNMENT, 1);
    gl.readPixels(0, 0, width, height, gl.RGBA, gl.UNSIGNED_BYTE, raw);
    const out = new Uint8Array(raw.length);
    const row = width * 4;
    for (let y = 0; y < height; y++) out.set(raw.subarray((height - 1 - y) * row, (height - y) * row), y * row);
    return out;
  }

  /** Free GPU resources. The context itself is left alone so the canvas can be reused. */
  dispose(): void {
    const gl = this.gl;
    this.freeScene();
    for (const p of [this.shadowProgram, this.blurProgram, this.shadeProgram]) gl.deleteProgram(p.program);
    gl.deleteBuffer(this.quad);
    gl.deleteVertexArray(this.vao);
  }
}
