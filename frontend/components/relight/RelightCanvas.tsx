"use client";

import { type RefObject, useEffect, useRef, useState } from "react";
import { errorMessage } from "@/lib/api";
import { base64ToBitmap } from "@/lib/image";
import { CpuRelightRenderer, cpuSceneData } from "@/lib/relightCPU";
import { RelightRenderer } from "@/lib/relightGL";
import type { Light, RelightScene } from "@/lib/types";

/**
 * How the picture on the canvas is being made, best first:
 *   "gpu-full"    the WebGL2 shader with half-float shadow buffers
 *   "gpu-packed"  the same shader with 8-bit shadow buffers
 *   "cpu-worker"  lib/relightMath.ts in a Worker
 *   "cpu-main"    lib/relightMath.ts on the page's own thread
 */
export interface ShadingPath {
  kind: "gpu-full" | "gpu-packed" | "cpu-worker" | "cpu-main";
  /** A few words for the page, such as "graphics chip, full quality". */
  label: string;
  /** Why it is not the best path, in plain words; null when it is. */
  why: string | null;
  /** The graphics chip's own name, when the GPU is in use and the browser tells. */
  chip: string | null;
}

/**
 * How long a lost graphics context gets to come back before the CPU takes
 * over, in milliseconds. A restore after sleep or a driver restart takes about
 * a second; much longer and the user is looking at a photo that ignores the light.
 */
const CONTEXT_RESTORE_WAIT_MS = 2500;

/** What the two renderers have in common. */
interface Shader {
  render(light: Light, shadows: boolean): void;
  dispose(): void;
}

interface RelightCanvasProps {
  scene: RelightScene;
  light: Light;
  shadows: boolean;
  /** The <canvas>, at the scene's pixel size, for export and snapshots. */
  canvasRef: RefObject<HTMLCanvasElement | null>;
  /** The scene is loaded and the first picture is drawn. Called again if the path changes later. */
  onReady: (path: ShadingPath) => void;
  /** Neither the GPU nor the CPU could shade the scene: the page falls back to server renders. */
  onUnavailable: (reason: string) => void;
  /** CPU paths only: a full-quality picture took this many milliseconds to shade. */
  onFullRender?: (ms: number) => void;
  /** Set to a function that resolves once the canvas holds the full-quality picture for the current light. */
  settleRef?: RefObject<(() => Promise<void>) | null>;
  className?: string;
}

/**
 * The live preview: the scene shaded on the GPU, or on the CPU where the GPU
 * cannot do it, redrawn whenever the light changes.
 */
export function RelightCanvas({ scene, light, shadows, canvasRef, onReady, onUnavailable, onFullRender, settleRef, className }: RelightCanvasProps) {
  const renderer = useRef<Shader | null>(null);
  const latest = useRef({ light, shadows });
  const callbacks = useRef({ onReady, onUnavailable, onFullRender });
  // Bumped when the browser hands the GPU context back after losing it.
  const [generation, setGeneration] = useState(0);
  // Why the GPU is not in use. Once set, the CPU shades for as long as this component stays mounted,
  // which covers a photo analysed again in place. New photo mounts a new one, which tries the GPU again.
  const [gpuProblem, setGpuProblem] = useState<string | null>(null);

  useEffect(() => {
    callbacks.current = { onReady, onUnavailable, onFullRender };
  }, [onReady, onUnavailable, onFullRender]);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    let cancelled = false;
    let mine: Shader | null = null;
    let restoreTimer: ReturnType<typeof setTimeout> | null = null;

    const onLost = (event: Event) => {
      event.preventDefault(); // allow a restore
      restoreTimer ??= setTimeout(() => setGpuProblem("the graphics chip stopped responding"), CONTEXT_RESTORE_WAIT_MS);
    };
    const onRestored = () => {
      if (restoreTimer !== null) clearTimeout(restoreTimer);
      setGeneration((g) => g + 1);
    };
    canvas.addEventListener("webglcontextlost", onLost);
    canvas.addEventListener("webglcontextrestored", onRestored);

    (async () => {
      let bitmaps: ImageBitmap[] = [];
      try {
        bitmaps = await Promise.all([
          base64ToBitmap(scene.image, true),
          base64ToBitmap(scene.depth, true),
          base64ToBitmap(scene.normals, true),
        ]);
        if (cancelled) return;
        const [image, depth, normals] = bitmaps;

        if (gpuProblem === null) {
          let gpu: RelightRenderer;
          try {
            gpu = new RelightRenderer(canvas);
            mine = gpu;
            gpu.setScene({ width: scene.width, height: scene.height, relief: scene.relief, image, depth, normals });
            gpu.render(latest.current.light, latest.current.shadows);
          } catch (error) {
            // Never leave a blank canvas: say why in the console and hand over to the CPU.
            // That needs a fresh <canvas>, as this one is tied to WebGL for good.
            console.warn("Relight: the GPU cannot shade this, using the CPU instead.", error);
            mine?.dispose();
            mine = null;
            setGpuProblem(errorMessage(error));
            return;
          }
          renderer.current = gpu;
          if (settleRef) settleRef.current = () => Promise.resolve();
          const { grade, why, chip, selfTestMean } = gpu.report;
          canvas.dataset.shading = `gpu-${grade}`;
          canvas.dataset.selfTest = selfTestMean.toFixed(2);
          callbacks.current.onReady({ kind: `gpu-${grade}`, label: grade === "full" ? "graphics chip, full quality" : "graphics chip, compatibility mode", why, chip });
          return;
        }

        const report = (cpu: CpuRelightRenderer): ShadingPath => ({
          kind: cpu.threaded ? "cpu-worker" : "cpu-main",
          label: cpu.threaded ? "processor, in the background" : "processor",
          why: gpuProblem,
          chip: null,
        });
        let first = true;
        const cpu = new CpuRelightRenderer(canvas, cpuSceneData(scene.width, scene.height, scene.relief, image, depth, normals), {
          onFrame: (quality, ms) => {
            if (cancelled) return;
            const path = report(cpu);
            // Changes if the Worker gave up after the first picture.
            if (first || canvas.dataset.shading !== path.kind) callbacks.current.onReady(path);
            first = false;
            canvas.dataset.shading = path.kind;
            canvas.dataset[quality === "full" ? "fullMs" : "previewMs"] = ms.toFixed(1);
            canvas.dataset.quality = quality;
            if (quality === "full") callbacks.current.onFullRender?.(ms);
          },
          onError: (message) => {
            console.warn("Relight: the CPU renderer failed.", message);
            if (!cancelled) callbacks.current.onUnavailable(`${gpuProblem}, and shading on the processor failed too: ${message}`);
          },
        });
        mine = cpu;
        renderer.current = cpu;
        if (settleRef) settleRef.current = () => cpu.whenSettled();
        cpu.render(latest.current.light, latest.current.shadows);
      } catch (error) {
        if (!cancelled) callbacks.current.onUnavailable(gpuProblem === null ? errorMessage(error) : `${gpuProblem}, and shading on the processor failed too: ${errorMessage(error)}`);
      } finally {
        for (const bitmap of bitmaps) bitmap.close();
      }
    })();

    return () => {
      cancelled = true;
      if (restoreTimer !== null) clearTimeout(restoreTimer);
      canvas.removeEventListener("webglcontextlost", onLost);
      canvas.removeEventListener("webglcontextrestored", onRestored);
      if (renderer.current === mine) renderer.current = null;
      if (settleRef) settleRef.current = null;
      mine?.dispose();
    };
  }, [scene, canvasRef, settleRef, generation, gpuProblem]);

  useEffect(() => {
    latest.current = { light, shadows };
    renderer.current?.render(light, shadows);
  }, [light, shadows]);

  // A canvas that has given out a WebGL context can never give a 2D one: the key swaps it for a new element.
  return <canvas key={gpuProblem === null ? "gpu" : "cpu"} ref={canvasRef} width={scene.width} height={scene.height} className={className} />;
}
