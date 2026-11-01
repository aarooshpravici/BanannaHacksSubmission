import { useCallback, useEffect, useState } from "react";
import { errorMessage, isAbort, relightRender } from "@/lib/api";
import { API_URL } from "@/lib/config";
import type { FillLight, Light, RelightScene } from "@/lib/types";

const SERVER_RENDER_OFFLINE = `Cannot reach the backend at ${API_URL}. Is it running?`;

/** Runs a backend call that needs a scene id, first obtaining one if the scene is a built-in sample. */
export type WithBackendScene = <T>(scene: RelightScene, offlineMessage: string, call: (sceneId: string) => Promise<T>) => Promise<T>;

/**
 * Fallback for browsers that cannot shade, or shade too slowly: ask the server
 * to render each light position (debounced), instead of shading in the browser.
 * `onFail` is called each time a render fails.
 */
export function useServerPreview(enabled: boolean, scene: RelightScene | null, light: Light, shadows: boolean, fill: FillLight | null, withBackendScene: WithBackendScene, onFail: () => void) {
  const [state, setState] = useState<{ sceneId: string | null; image: string | null; error: string | null }>({ sceneId: null, image: null, error: null });
  // Bumped by retry(). While renders fail the light is locked, so moving it cannot be what asks again.
  const [attempt, setAttempt] = useState(0);
  const retry = useCallback(() => setAttempt((n) => n + 1), []);
  useEffect(() => {
    if (!enabled || !scene) return;
    const controller = new AbortController();
    let cancelled = false;
    const timer = setTimeout(async () => {
      try {
        // With the fill off the request is, to the letter, what it was before there was one.
        const render = await withBackendScene(scene, SERVER_RENDER_OFFLINE, (scene_id) => relightRender({ scene_id, light, shadows, fill: fill ?? undefined }, controller.signal));
        if (!cancelled) setState({ sceneId: scene.scene_id, image: render.image, error: null });
      } catch (error) {
        if (cancelled || isAbort(error)) return;
        setState((s) => ({ ...s, error: errorMessage(error) }));
        onFail();
      }
    }, 150);
    return () => {
      cancelled = true;
      clearTimeout(timer);
      controller.abort();
    };
  }, [enabled, scene, light, shadows, fill, withBackendScene, onFail, attempt]);
  // The last render outlives a change of photo: never show or export it over another scene.
  const image = enabled && scene && state.sceneId === scene.scene_id ? state.image : null;
  return { image, error: enabled ? state.error : null, retry };
}
