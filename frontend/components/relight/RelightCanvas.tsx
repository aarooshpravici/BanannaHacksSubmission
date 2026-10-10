"use client";

import { type RefObject, useEffect, useRef, useState } from "react";
import { errorMessage } from "@/lib/api";
import { base64ToBitmap } from "@/lib/image";
import { RelightRenderer } from "@/lib/relightGL";
import type { Light, RelightScene } from "@/lib/types";

interface RelightCanvasProps {
  scene: RelightScene;
  light: Light;
  shadows: boolean;
  /** The <canvas>, at the scene's pixel size, for export and snapshots. */
  canvasRef: RefObject<HTMLCanvasElement | null>;
  /** The scene is uploaded and the first frame is drawn. */
  onReady: () => void;
  /** WebGL2 is missing or the shader did not compile: the page falls back to server renders. */
  onUnavailable: (reason: string) => void;
  className?: string;
}

/** The live preview: the scene shaded on the GPU, redrawn whenever the light changes. */
export function RelightCanvas({ scene, light, shadows, canvasRef, onReady, onUnavailable, className }: RelightCanvasProps) {
  const renderer = useRef<RelightRenderer | null>(null);
  const latest = useRef({ light, shadows });
  const callbacks = useRef({ onReady, onUnavailable });
  // Bumped when the browser hands the GPU context back after losing it.
  const [generation, setGeneration] = useState(0);

  useEffect(() => {
    callbacks.current = { onReady, onUnavailable };
  }, [onReady, onUnavailable]);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    let cancelled = false;
    let mine: RelightRenderer | null = null;

    const onLost = (event: Event) => event.preventDefault(); // allow a restore
    const onRestored = () => setGeneration((g) => g + 1);
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
        mine = new RelightRenderer(canvas);
        const [image, depth, normals] = bitmaps;
        mine.setScene({ width: scene.width, height: scene.height, relief: scene.relief, image, depth, normals });
        renderer.current = mine;
        mine.render(latest.current.light, latest.current.shadows);
        callbacks.current.onReady();
      } catch (error) {
        if (!cancelled) callbacks.current.onUnavailable(errorMessage(error));
      } finally {
        for (const bitmap of bitmaps) bitmap.close();
      }
    })();

    return () => {
      cancelled = true;
      canvas.removeEventListener("webglcontextlost", onLost);
      canvas.removeEventListener("webglcontextrestored", onRestored);
      if (renderer.current === mine) renderer.current = null;
      mine?.dispose();
    };
  }, [scene, canvasRef, generation]);

  useEffect(() => {
    latest.current = { light, shadows };
    renderer.current?.render(light, shadows);
  }, [light, shadows]);

  return <canvas ref={canvasRef} width={scene.width} height={scene.height} className={className} />;
}
