"use client";

// Drafts: the user's own photos, kept on this device so that each can be opened
// again exactly as it was left, with no model run and nothing sent anywhere.
//
// They are kept in the browser's IndexedDB. A cookie could not hold one: it has
// room for about 4 KB, and a photo with its depth and normal maps is a thousand
// times that. A draft is two records under one id (a fingerprint of the
// picture): a small one for the list (name, times, light, fill light, switches,
// a small picture of the lit result) and a large one with the scene. Moving the
// light writes only the small one.
//
// Storage is the browser's to refuse: it can be switched off, full, or held by
// another tab. Every call in here is wrapped. When one fails nothing is thrown
// at the page: the draft is simply not kept, and `problem` is set so that the
// Drafts tab can say so in a line.

import { useSyncExternalStore } from "react";
import { ctx2d, makeCanvas } from "./image";
import { isLocalScene } from "./localScene";
import type { DepthDevice } from "./sceneGeometry";
import type { Light, RelightScene } from "./types";

/** How many drafts are kept. Saving one more drops the one that was changed longest ago. Up to about 2 MB each as measured (a photo 1024 pixels wide, analysed in the browser), so 12 stay well inside what a browser allows a site. */
export const MAX_DRAFTS = 12;
/** The longer side of a draft's small picture, in pixels: twice the width of its card, for a sharp screen. */
const THUMB_SIDE = 320;
/** How long the browser's storage gets to answer, in milliseconds. It answers in a few; past this it is not going to, and the page must not be left waiting. */
const WAIT_MS = 5000;

const DB_NAME = "relight-drafts";
const DB_VERSION = 1;
/** The small records, one per draft: a `Draft`. */
const CARDS = "drafts";
/** The large ones: `{ id, scene }`. */
const SCENES = "scenes";

/** A draft's fill light: its switch and its own numbers, which are kept while it is off. */
export interface DraftFill {
  on: boolean;
  x: number;
  y: number;
  height: number;
  intensity: number;
  /** Its own Colour slider: -1 = cool, 0 = white, 1 = warm. */
  warmth: number;
}

/** One draft as the list shows it, and everything needed to put its light back. The scene is read only when the draft is opened. */
export interface Draft {
  /** A fingerprint of the picture (`fingerprint`), so the same photo chosen twice is one draft. */
  id: string;
  /** The file's name without its ending. */
  name: string;
  /** Milliseconds since 1970, like Date.now(). */
  createdAt: number;
  updatedAt: number;
  light: Omit<Light, "color">;
  /** The Colour slider: -1 = cool, 0 = white, 1 = warm. */
  warmth: number;
  /** The fill light. Null if it was never switched on, and in every draft saved before there was one: such a draft opens with the fill off. */
  fill: DraftFill | null;
  /** Which light the LIGHT panel's sliders were on. The fill only if it was on. */
  picked: "key" | "fill";
  /** Cast shadows. */
  shadows: boolean;
  /** Detailed normals. */
  detail: boolean;
  /** How the depth model was run, when the browser worked the scene out; null when the server did. */
  depthDevice: DepthDevice | null;
  /** The words the Geometry panel had after "depth: this browser," when the draft was made. */
  depthText: string | null;
  /** A small JPEG of the lit picture, as a data: address; "" if none could be made. */
  thumb: string;
}

export interface DraftsState {
  /** False until the browser's storage has answered for the first time. */
  loaded: boolean;
  /** Newest change first. */
  drafts: Draft[];
  /** Drafts cannot be kept: the storage would not open, or the last attempt to write to it failed. */
  problem: boolean;
  /** When this list was read, like Date.now(): what "5 minutes ago" on a card is counted from. */
  at: number;
}

/** A scene the server made is given this in place of its id when its draft is opened: by then the server may have forgotten it, so, like a sample's scene, it has to be sent there again before Enhance or a server render. */
const DRAFT_ID_PREFIX = "draft:";

export const isDraftScene = (scene: RelightScene) => scene.scene_id.startsWith(DRAFT_ID_PREFIX);

// --- what is read back is checked ---------------------------------------------------

const finite = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value);

/** A record's fill light, or null if it has none or it is not whole. A draft is never skipped for its fill: it opens with the fill off. */
function asFill(value: unknown): DraftFill | null {
  const f = value as Partial<DraftFill> | null | undefined;
  if (!f || typeof f !== "object" || typeof f.on !== "boolean") return null;
  if (!finite(f.x) || !finite(f.y) || !finite(f.height) || !finite(f.intensity) || !finite(f.warmth)) return null;
  return { on: f.on, x: f.x, y: f.y, height: f.height, intensity: f.intensity, warmth: f.warmth };
}

/** A record from the list -> a Draft, or null if it is not one (damaged, or written by something else). Such a record is skipped. */
function asDraft(value: unknown): Draft | null {
  const d = value as Partial<Draft> | null;
  if (!d || typeof d !== "object" || typeof d.id !== "string" || typeof d.name !== "string" || !finite(d.createdAt) || !finite(d.updatedAt)) return null;
  const light = d.light as Partial<Draft["light"]> | null | undefined;
  if (!light || !finite(light.x) || !finite(light.y) || !finite(light.height) || !finite(light.intensity) || !finite(light.ambient)) return null;
  if (!finite(d.warmth) || typeof d.shadows !== "boolean" || typeof d.detail !== "boolean") return null;
  const fill = asFill(d.fill);
  return {
    id: d.id,
    name: d.name,
    createdAt: d.createdAt,
    updatedAt: d.updatedAt,
    light: { x: light.x, y: light.y, height: light.height, intensity: light.intensity, ambient: light.ambient },
    warmth: d.warmth,
    fill,
    picked: d.picked === "fill" && fill !== null && fill.on ? "fill" : "key",
    shadows: d.shadows,
    detail: d.detail,
    depthDevice: d.depthDevice === "webgpu" || d.depthDevice === "wasm" ? d.depthDevice : null,
    depthText: typeof d.depthText === "string" ? d.depthText : null,
    // Only ever a picture made on this device: anything else would have the browser fetch an address.
    thumb: typeof d.thumb === "string" && d.thumb.startsWith("data:image/") ? d.thumb : "",
  };
}

function asScene(value: unknown): RelightScene | null {
  const s = value as Partial<RelightScene> | null;
  if (!s || typeof s !== "object" || typeof s.scene_id !== "string" || !finite(s.width) || !finite(s.height) || s.width < 1 || s.height < 1 || !finite(s.relief)) return null;
  if (typeof s.image !== "string" || typeof s.depth !== "string" || typeof s.normals !== "string" || !s.image || !s.depth || !s.normals) return null;
  return { scene_id: s.scene_id, width: s.width, height: s.height, image: s.image, depth: s.depth, normals: s.normals, relief: s.relief };
}

// --- the list the page shows ----------------------------------------------------------

/** What a page drawn ahead of time shows, and every page until the storage has answered: no drafts yet. */
const NOT_READ: DraftsState = { loaded: false, drafts: [], problem: false, at: 0 };

let state = NOT_READ;
/** The list could not be read. */
let unread = false;
/** A draft could not be written, and none has been since. */
let unwritten = false;
/** The storage would not open at all: nothing more is asked of it, unless it answers after all. */
let off = false;
let warned = false;
const listeners = new Set<() => void>();

function publish(drafts: Draft[] = state.drafts): void {
  state = { loaded: true, drafts, problem: unread || unwritten, at: Date.now() };
  for (const listener of listeners) listener();
}

let asked = false;

function subscribe(listener: () => void): () => void {
  // The first page to listen is what starts the reading: nothing in here touches storage while a page is drawn ahead of time.
  if (!asked) refreshDrafts();
  asked = true;
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** The drafts on this device. Empty on the first render, on the server and in the browser alike, and filled in once the storage has been read. */
export function useDrafts(): DraftsState {
  return useSyncExternalStore(
    subscribe,
    () => state,
    () => NOT_READ,
  );
}

// --- IndexedDB ------------------------------------------------------------------------

let opening: Promise<IDBDatabase> | null = null;
let opened = false;

function database(): Promise<IDBDatabase> {
  if (opening) return opening;
  const mine = new Promise<IDBDatabase>((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(CARDS)) db.createObjectStore(CARDS, { keyPath: "id" });
      if (!db.objectStoreNames.contains(SCENES)) db.createObjectStore(SCENES, { keyPath: "id" });
    };
    request.onsuccess = () => {
      const db = request.result;
      const forget = () => {
        if (opening === mine) opening = null;
      };
      // Another tab wants to change the database: let go of it, so this page is never what holds that tab up. It is opened again when next needed.
      db.onversionchange = () => {
        db.close();
        forget();
      };
      // The browser closed it (the site's storage was cleared, say).
      db.onclose = forget;
      opened = true;
      resolve(db);
      // It answered after the page had stopped waiting for it: drafts work after all.
      if (off) {
        off = false;
        refreshDrafts();
      }
    };
    request.onerror = () => reject(request.error ?? new Error("the database could not be opened"));
    // Held by another tab with an older version of it.
    request.onblocked = () => reject(new Error("the database is held open by another tab"));
  });
  opening = mine;
  return mine;
}

/** Storage that never answers must not leave anything waiting. */
function within<T>(work: Promise<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("the browser's storage did not answer")), WAIT_MS);
    work.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error: unknown) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}

/**
 * One transaction over both kinds of record. `work` makes its requests and
 * returns a function that gives the result, which is asked for only once
 * everything has been written.
 */
function transact<T>(mode: IDBTransactionMode, work: (cards: IDBObjectStore, scenes: IDBObjectStore, tx: IDBTransaction) => () => T): Promise<T> {
  return within(
    database().then(
      (db) =>
        new Promise<T>((resolve, reject) => {
          let tx: IDBTransaction;
          try {
            tx = db.transaction([CARDS, SCENES], mode);
          } catch (error) {
            // The connection has been closed under the page: the next job opens a new one.
            opening = null;
            throw error;
          }
          const result = work(tx.objectStore(CARDS), tx.objectStore(SCENES), tx);
          tx.oncomplete = () => {
            try {
              resolve(result());
            } catch (error) {
              reject(error);
            }
          };
          // A failed request stops its transaction, so this hears of every failure.
          tx.onabort = () => reject(tx.error ?? new Error("the transaction was stopped"));
        }),
    ),
  );
}

/**
 * Inside a transaction, after whatever it has just changed: the drafts that
 * are whole (a record that cannot be read is skipped), newest change first,
 * with those over the limit deleted. The function returned gives the list.
 */
function survivors(cards: IDBObjectStore, scenes: IDBObjectStore): () => Draft[] {
  let kept: Draft[] = [];
  const all = cards.getAll();
  const withScene = scenes.getAllKeys();
  // Requests are answered in the order they were made, so `all` has its answer by now.
  withScene.onsuccess = () => {
    const have = new Set(withScene.result);
    const drafts = (all.result as unknown[])
      .map(asDraft)
      .filter((draft): draft is Draft => draft !== null && have.has(draft.id))
      .sort((a, b) => b.updatedAt - a.updatedAt);
    kept = drafts.slice(0, MAX_DRAFTS);
    for (const extra of drafts.slice(MAX_DRAFTS)) {
      cards.delete(extra.id);
      scenes.delete(extra.id);
    }
  };
  return () => kept;
}

// One job at a time, in the order they were asked for.
let queue: Promise<unknown> = Promise.resolve();

/** What a piece of storage work hands back: its answer and, when it has read the list or changed it, the list. */
interface Done<T> {
  value: T;
  drafts?: Draft[];
}

/** Run a piece of storage work after the ones before it. It cannot reject: a failure is noted for the Drafts tab and `fallback` is the answer. */
function job<T>(kind: "read" | "write", fallback: T, work: () => Promise<Done<T>>): Promise<T> {
  const next = queue.then(async () => {
    if (off) return fallback;
    try {
      const { value, drafts } = await work();
      // Reading again does not show that writing works: after a failed save the Drafts tab goes on saying so until one succeeds.
      if (kind === "write") unwritten = false;
      unread = false;
      if (drafts || state.problem !== unwritten) publish(drafts);
      return value;
    } catch (error) {
      if (!opened) off = true;
      if (kind === "write") unwritten = true;
      else unread = true;
      // Once: a light being dragged would otherwise fill the console with the same line.
      if (!warned) console.warn("Relight: drafts cannot be kept in this browser.", error);
      warned = true;
      publish();
      return fallback;
    }
  });
  queue = next;
  return next;
}

// --- what the page asks for -----------------------------------------------------------

/** Read the list again: when the Drafts tab is opened, and to catch what another tab has changed. */
export function refreshDrafts(): void {
  void job("read", undefined, async () => ({ value: undefined, drafts: await transact("readwrite", survivors) }));
}

/**
 * Keep a draft. `scene` is null when the storage already holds this draft's
 * scene and only the light has changed. Resolves false if it was not kept.
 * `urgent`: the page is going away, so the browser is told to finish the
 * writing at once and nothing is read back.
 */
export function saveDraft(draft: Draft, scene: RelightScene | null, urgent = false): Promise<boolean> {
  return job("write", false, async () => {
    // The scene this draft goes with is no longer there (another tab deleted the draft): not a failure of the storage.
    let gone = false;
    try {
      const drafts = await transact("readwrite", (cards, scenes, tx) => {
        if (scene) scenes.put({ id: draft.id, scene });
        else if (!urgent) {
          const held = scenes.count(draft.id);
          held.onsuccess = () => {
            if (held.result > 0) return;
            gone = true;
            tx.abort();
          };
        }
        cards.put(draft);
        if (!urgent) return survivors(cards, scenes);
        tx.commit?.();
        return () => [draft, ...state.drafts.filter((other) => other.id !== draft.id)].slice(0, MAX_DRAFTS);
      });
      return { value: true, drafts };
    } catch (error) {
      if (!gone) throw error;
      return { value: false };
    }
  });
}

/**
 * A draft's scene, ready to be lit: read from this device, nothing is asked of
 * any server. Null if it cannot be read; a draft that is missing its scene, or
 * whose scene is damaged, can never be opened and is taken off the list.
 */
export function readDraftScene(id: string): Promise<RelightScene | null> {
  return job("read", null, async () => {
    const scene = await transact("readonly", (_cards, scenes) => {
      const held = scenes.get(id);
      return () => asScene((held.result as { scene?: unknown } | undefined)?.scene);
    });
    if (scene) return { value: isLocalScene(scene) || isDraftScene(scene) ? scene : { ...scene, scene_id: `${DRAFT_ID_PREFIX}${id}` } };
    return { value: null, drafts: await remove(id) };
  });
}

/** Delete one draft, or with no id all of them, and give the list that is left. */
function remove(id?: string): Promise<Draft[]> {
  return transact("readwrite", (cards, scenes) => {
    for (const records of [cards, scenes]) {
      if (id === undefined) records.clear();
      else records.delete(id);
    }
    return survivors(cards, scenes);
  });
}

export function deleteDraft(id: string): Promise<void> {
  return job("write", undefined, async () => ({ value: undefined, drafts: await remove(id) }));
}

/** Everything, the records that could not be read included. */
export function deleteAllDrafts(): Promise<void> {
  return job("write", undefined, async () => ({ value: undefined, drafts: await remove() }));
}

// --- making a draft -------------------------------------------------------------------

/**
 * A photo's fingerprint, from its bytes as the page holds them (base64): the
 * same picture gives the same one, so choosing a photo that is already a draft
 * replaces that draft. SHA-256 where the browser offers it. It does not on a
 * page opened by a computer's address on the Wi-Fi, which is how a phone opens
 * the dev server: there, the length and two running sums over every character.
 */
export async function fingerprint(base64: string): Promise<string> {
  try {
    const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(base64));
    return Array.from(new Uint8Array(digest).slice(0, 16), (byte) => byte.toString(16).padStart(2, "0")).join("");
  } catch {
    let a = 0x811c9dc5;
    let b = 0x9e3779b9;
    for (let i = 0; i < base64.length; i++) {
      const c = base64.charCodeAt(i);
      a = Math.imul(a ^ c, 0x01000193);
      b = Math.imul(b + c, 0x5bd1e995) ^ (b >>> 13);
    }
    return `f${base64.length.toString(16)}-${(a >>> 0).toString(16)}-${(b >>> 0).toString(16)}`;
  }
}

/** A draft's name: the file's name without its ending. A paste, and a picture fetched from an address that names no file, have only the stand-in names lib/image.ts and the drop box give them. */
export function draftName(fileName: string): string {
  const name = fileName
    .replace(/\.[^./\\]+$/, "")
    .trim()
    .slice(0, 80);
  return !name || name === "pasted image" || name === "dropped image" ? "Pasted photo" : name;
}

/**
 * A small JPEG of a picture that is on the page (the lit canvas, or the photo
 * itself), as a data: address. `width` and `height` are the picture's own.
 * Null if the browser will not give one.
 */
export function smallPicture(source: HTMLCanvasElement | HTMLImageElement, width: number, height: number): string | null {
  try {
    if (source instanceof HTMLImageElement && !(source.complete && source.naturalWidth > 0)) return null;
    const scale = Math.min(1, THUMB_SIDE / Math.max(width, height));
    const canvas = makeCanvas(width * scale, height * scale);
    const ctx = ctx2d(canvas);
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = "high";
    ctx.drawImage(source, 0, 0, canvas.width, canvas.height);
    const url = canvas.toDataURL("image/jpeg", 0.8);
    // A browser that cannot make a JPEG answers with a PNG, or with "data:,".
    return url.startsWith("data:image/jpeg") ? url : null;
  } catch {
    return null;
  }
}

/** When a draft was last changed, in plain words: "just now", "5 minutes ago", "3 hours ago", "yesterday", then the date. */
export function whenChanged(then: number, now: number): string {
  const minutes = Math.floor((now - then) / 60_000);
  if (minutes < 1) return "just now";
  if (minutes < 60) return minutes === 1 ? "1 minute ago" : `${minutes} minutes ago`;
  const midnight = (time: number) => new Date(time).setHours(0, 0, 0, 0);
  const days = Math.round((midnight(now) - midnight(then)) / 86_400_000);
  if (days === 0) return minutes < 120 ? "1 hour ago" : `${Math.floor(minutes / 60)} hours ago`;
  if (days === 1) return "yesterday";
  const date = new Date(then);
  const sameYear = date.getFullYear() === new Date(now).getFullYear();
  return date.toLocaleDateString(undefined, sameYear ? { day: "numeric", month: "long" } : { day: "numeric", month: "long", year: "numeric" });
}
