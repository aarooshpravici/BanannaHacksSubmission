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
//
// Every texture is stored top row first, so texture row j is image row j and
// v = 0 is the top of the image. Only the final pass, which draws to the
// screen (where y points up), flips.

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
  shadowHeightField,
} from "./relightMath";
import type { Light } from "./types";

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
  o_color = u_final > 0.5 ? vec4(lit, 0.0, 0.0, 1.0) : vec4(acc, 1.0);
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
  if (u_shadows > 0.5) direct *= texture(u_shadow, v_uv).r;
  float shading = u_ambient + u_intensity * direct;

  // apply_shading(): multiply in linear light; above the knee, roll off instead of clipping.
  vec3 lit = srgbToLinear(rgb) * shading * u_color;
  const float knee = ${f(HIGHLIGHT_KNEE)};
  vec3 over = max(lit - knee, 0.0);
  lit = mix(lit, knee + (1.0 - knee) * (1.0 - exp(-over / (1.0 - knee))), greaterThan(lit, vec3(knee)));
  o_color = vec4(clamp(linearToSrgb(lit), 0.0, 1.0), 1.0);
}`;

export interface RelightSceneData {
  width: number;
  height: number;
  relief: number;
  image: ImageBitmap;
  depth: ImageBitmap;
  normals: ImageBitmap;
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
  private floatTargets: boolean;
  private scene: SceneState | null = null;

  /** Throws if WebGL2 is not available or a shader fails to compile. */
  constructor(private canvas: HTMLCanvasElement) {
    const gl = canvas.getContext("webgl2", {
      alpha: false,
      antialias: false,
      depth: false,
      premultipliedAlpha: false,
      preserveDrawingBuffer: true, // so Export and snapshots can read the canvas at any time
    });
    if (!gl) throw new Error("WebGL2 is not available in this browser");
    this.gl = gl;
    // Rendering to half-float keeps the shadow map smooth; 8-bit is a fine fallback.
    this.floatTargets = gl.getExtension("EXT_color_buffer_float") !== null;

    this.shadowProgram = this.link(SHADOW_FRAGMENT, ["u_flip", "u_z", "u_size", "u_light", "u_relief"]);
    this.blurProgram = this.link(BLUR_FRAGMENT, ["u_flip", "u_src", "u_size", "u_dir", "u_final", "u_kernel"]);
    this.shadeProgram = this.link(SHADE_FRAGMENT, [
      "u_flip", "u_image", "u_depth", "u_normals", "u_shadow", "u_aspect", "u_relief",
      "u_light", "u_intensity", "u_ambient", "u_color", "u_shadows",
    ]);

    // One oversized triangle covers the viewport.
    const vao = gl.createVertexArray();
    const quad = gl.createBuffer();
    if (!vao || !quad) throw new Error("WebGL could not allocate buffers.");
    this.vao = vao;
    this.quad = quad;
    gl.bindVertexArray(vao);
    gl.bindBuffer(gl.ARRAY_BUFFER, quad);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]), gl.STATIC_DRAW);
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
  }

  private compile(type: number, source: string): WebGLShader {
    const gl = this.gl;
    const shader = gl.createShader(type);
    if (!shader) throw new Error("WebGL could not create a shader.");
    gl.shaderSource(shader, source);
    gl.compileShader(shader);
    if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
      const log = gl.getShaderInfoLog(shader);
      gl.deleteShader(shader);
      throw new Error(`Shader failed to compile: ${log}`);
    }
    return shader;
  }

  private link(fragment: string, uniformNames: string[]): Program {
    const gl = this.gl;
    const program = gl.createProgram();
    if (!program) throw new Error("WebGL could not create a program.");
    const vs = this.compile(gl.VERTEX_SHADER, VERTEX);
    const fs = this.compile(gl.FRAGMENT_SHADER, fragment);
    gl.attachShader(program, vs);
    gl.attachShader(program, fs);
    gl.bindAttribLocation(program, 0, "a_pos");
    gl.linkProgram(program);
    gl.deleteShader(vs);
    gl.deleteShader(fs);
    if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
      const log = gl.getProgramInfoLog(program);
      gl.deleteProgram(program);
      throw new Error(`Shader program failed to link: ${log}`);
    }
    const uniforms: Program["uniforms"] = {};
    for (const name of uniformNames) uniforms[name] = gl.getUniformLocation(program, name);
    return { program, uniforms };
  }

  private texture(filter: number): WebGLTexture {
    const gl = this.gl;
    const texture = gl.createTexture();
    if (!texture) throw new Error("WebGL could not create a texture.");
    gl.bindTexture(gl.TEXTURE_2D, texture);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, filter);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, filter);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    return texture;
  }

  private bitmapTexture(bitmap: ImageBitmap): WebGLTexture {
    const gl = this.gl;
    const texture = this.texture(gl.LINEAR);
    // The bytes of the PNG must reach the shader untouched, top row first.
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
    gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false);
    gl.pixelStorei(gl.UNPACK_COLORSPACE_CONVERSION_WEBGL, gl.NONE);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, bitmap);
    return texture;
  }

  private target(width: number, height: number, filter: number): Target {
    const gl = this.gl;
    const texture = this.texture(filter);
    // Four channels: the march and the first blur carry one shadow layer in each of R, G and B.
    if (this.floatTargets) gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA16F, width, height, 0, gl.RGBA, gl.HALF_FLOAT, null);
    else gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, width, height, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
    const framebuffer = gl.createFramebuffer();
    if (!framebuffer) throw new Error("WebGL could not create a framebuffer.");
    gl.bindFramebuffer(gl.FRAMEBUFFER, framebuffer);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, texture, 0);
    const status = gl.checkFramebufferStatus(gl.FRAMEBUFFER);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    if (status !== gl.FRAMEBUFFER_COMPLETE) throw new Error("WebGL could not create the shadow buffer.");
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

  /** Upload a scene. The canvas takes the scene's pixel size. */
  setScene(data: RelightSceneData): void {
    const gl = this.gl;
    this.freeScene();
    this.canvas.width = data.width;
    this.canvas.height = data.height;

    // The height field the shadow pass marches: the depth map, area-averaged
    // down to the shadow resolution on the CPU (cv2.resize INTER_AREA), as
    // floats, with its dilated and eroded copies in the next two channels.
    const probe = document.createElement("canvas");
    probe.width = data.depth.width;
    probe.height = data.depth.height;
    const ctx = probe.getContext("2d", { willReadFrequently: true });
    if (!ctx) throw new Error("This browser could not create a 2D canvas.");
    ctx.drawImage(data.depth, 0, 0);
    const pixels = ctx.getImageData(0, 0, probe.width, probe.height).data;
    const depth = new Float32Array(probe.width * probe.height);
    for (let i = 0; i < depth.length; i++) depth[i] = pixels[i * 4] / 255;
    const field = shadowHeightField(depth, probe.width, probe.height, data.width, data.height, data.relief);

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
      if (!this.floatTargets) throw error;
      this.floatTargets = false; // some drivers advertise float targets and then refuse them
      targets = this.makeTargets(field.width, field.height);
    }

    this.scene = {
      width: data.width,
      height: data.height,
      relief: data.relief,
      image: this.bitmapTexture(data.image),
      depth: this.bitmapTexture(data.depth),
      normals: this.bitmapTexture(data.normals),
      z,
      shadowWidth: field.width,
      shadowHeight: field.height,
      targets,
    };
  }

  private makeTargets(width: number, height: number): SceneState["targets"] {
    const gl = this.gl;
    // The last one is sampled bilinearly by the shade pass: that is the
    // cv2.resize(lit, full size, INTER_LINEAR) at the end of shadows().
    return [this.target(width, height, gl.NEAREST), this.target(width, height, gl.NEAREST), this.target(width, height, gl.LINEAR)];
  }

  private bind(unit: number, texture: WebGLTexture, location: WebGLUniformLocation | null): void {
    const gl = this.gl;
    gl.activeTexture(gl.TEXTURE0 + unit);
    gl.bindTexture(gl.TEXTURE_2D, texture);
    gl.uniform1i(location, unit);
  }

  /** Draw the scene lit by `light`. Cheap enough to call on every pointer move. */
  render(light: Light, castShadows: boolean): void {
    const gl = this.gl;
    const scene = this.scene;
    if (!scene || gl.isContextLost()) return;
    const lightPos = lightPosition(scene.width, scene.height, scene.relief, light);
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
    gl.drawArrays(gl.TRIANGLES, 0, 3);
  }

  /**
   * The current frame as RGBA bytes, top row first (for tests and comparisons).
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
