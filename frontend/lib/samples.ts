// Built-in sample scenes: a photo with its depth and normal maps already
// estimated, shipped as static files under public/samples/<name>/ (written by
// backend/scripts/make_samples.py). Picking one needs no backend at all.

import { blobToBase64 } from "./image";
import type { RelightScene } from "./types";

export interface SamplePhoto {
  /** Folder name under public/samples. */
  name: string;
  label: string;
  alt: string;
}

export const SAMPLES: SamplePhoto[] = [
  { name: "portrait", label: "Portrait", alt: "An astronaut in an orange suit, head and shoulders" },
  { name: "coffee", label: "Coffee cup", alt: "A coffee cup on a saucer on a wooden table" },
  { name: "cat", label: "Cat", alt: "Close-up of a cat's face" },
  { name: "rocket", label: "Night rocket", alt: "A rocket on its launch pad at night" },
];

const sampleUrl = (sample: SamplePhoto, file: string) => `/samples/${sample.name}/${file}`;

export const sampleThumbUrl = (sample: SamplePhoto) => sampleUrl(sample, "thumb.jpg");

/** The backend never issued these ids: a sample scene has to be sent to it before Enhance or a server render. */
const SAMPLE_ID_PREFIX = "sample:";

export const isSampleScene = (scene: RelightScene) => scene.scene_id.startsWith(SAMPLE_ID_PREFIX);

async function fetchFile(url: string, signal?: AbortSignal): Promise<Response> {
  const res = await fetch(url, { signal });
  if (!res.ok) throw new Error(`Could not load the sample photo (${res.status}).`);
  return res;
}

/** The sample's scene, in the same shape POST /relight/scene returns, read from the static files. */
export async function loadSampleScene(sample: SamplePhoto, signal?: AbortSignal): Promise<RelightScene> {
  const base64 = async (file: string) => blobToBase64(await (await fetchFile(sampleUrl(sample, file), signal)).blob());
  const [meta, image, depth, normals] = await Promise.all([
    fetchFile(sampleUrl(sample, "scene.json"), signal).then((res) => res.json() as Promise<{ width: number; height: number; relief: number }>),
    base64("photo.jpg"),
    base64("depth.png"),
    base64("normals.png"),
  ]);
  return { scene_id: `${SAMPLE_ID_PREFIX}${sample.name}`, width: meta.width, height: meta.height, image, depth, normals, relief: meta.relief };
}
