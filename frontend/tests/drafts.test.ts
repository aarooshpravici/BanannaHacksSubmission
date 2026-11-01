// lib/drafts.ts without a browser: the checks on what is read back from
// storage, the draft's name, the photo's fingerprint and the "5 minutes ago"
// words. Saving, reading and deleting go through IndexedDB, which Node does not
// have, so they are left to the smoke test (tools/smoke.mjs). Importing the
// module touches no storage: it only starts reading when a page subscribes.

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { describe, test } from "node:test";
import { asDraft, asFill, asScene, draftName, fingerprint, isDraftScene, whenChanged } from "../lib/drafts";

const DRAFT = {
  id: "0123456789abcdef0123456789abcdef",
  name: "coffee",
  createdAt: 1_760_000_000_000,
  updatedAt: 1_760_000_100_000,
  light: { x: 0.12, y: 0.35, height: 0.12, intensity: 1.8, ambient: 0.06 },
  warmth: 0.5,
  fill: { on: true, x: 0.8, y: 0.2, height: 0.35, intensity: 0.6, warmth: -0.2 },
  picked: "fill",
  shadows: true,
  detail: false,
  depthDevice: "wasm",
  depthText: "processor, 2.1 s",
  thumb: "data:image/jpeg;base64,AAAA",
};

const SCENE = { scene_id: "local:1", width: 600, height: 400, image: "aW1n", depth: "ZGVw", normals: "bm9y", relief: 0.3 };

describe("asDraft: a record read back from storage", () => {
  test("a whole record comes back as it was", () => {
    assert.deepEqual(asDraft(structuredClone(DRAFT)), DRAFT);
  });

  test("anything it does not know is left behind", () => {
    const draft = asDraft({ ...DRAFT, light: { ...DRAFT.light, color: [1, 0, 0] }, extra: "x" });
    assert.ok(draft);
    assert.equal("extra" in draft, false);
    assert.deepEqual(Object.keys(draft.light).sort(), ["ambient", "height", "intensity", "x", "y"]);
  });

  test("a damaged record is skipped", () => {
    const broken: unknown[] = [
      null,
      undefined,
      "a string",
      42,
      { ...DRAFT, id: 7 },
      { ...DRAFT, name: undefined },
      { ...DRAFT, createdAt: Number.NaN },
      { ...DRAFT, updatedAt: "yesterday" },
      { ...DRAFT, light: null },
      { ...DRAFT, light: { ...DRAFT.light, x: Number.POSITIVE_INFINITY } },
      { ...DRAFT, light: { ...DRAFT.light, ambient: undefined } },
      { ...DRAFT, warmth: "warm" },
      { ...DRAFT, shadows: 1 },
      { ...DRAFT, detail: "yes" },
    ];
    for (const record of broken) assert.equal(asDraft(record), null, JSON.stringify(record) ?? String(record));
  });

  test("a damaged fill does not lose the draft: it opens with the fill off and the key picked", () => {
    for (const fill of [undefined, null, "on", { ...DRAFT.fill, on: "yes" }, { ...DRAFT.fill, warmth: Number.NaN }, { ...DRAFT.fill, height: undefined }]) {
      const draft = asDraft({ ...DRAFT, fill });
      assert.ok(draft, JSON.stringify(fill));
      assert.equal(draft.fill, null);
      assert.equal(draft.picked, "key");
    }
  });

  test("the fill is picked only if it is on", () => {
    assert.equal(asDraft({ ...DRAFT, fill: { ...DRAFT.fill, on: false } })?.picked, "key");
    assert.equal(asDraft({ ...DRAFT, picked: "something else" })?.picked, "key");
    assert.equal(asDraft(DRAFT)?.picked, "fill");
  });

  test("an unknown depth device, depth text or picture is dropped, not trusted", () => {
    const draft = asDraft({ ...DRAFT, depthDevice: "gpu", depthText: 3, thumb: "https://example.com/x.jpg" });
    assert.ok(draft);
    assert.equal(draft.depthDevice, null);
    assert.equal(draft.depthText, null);
    assert.equal(draft.thumb, "");
    assert.equal(asDraft({ ...DRAFT, depthDevice: "webgpu" })?.depthDevice, "webgpu");
  });

  test("asFill keeps exactly the fill's own numbers", () => {
    assert.deepEqual(asFill({ ...DRAFT.fill, color: [1, 1, 1] }), DRAFT.fill);
    assert.equal(asFill({ on: true }), null);
  });
});

describe("asScene: a draft's scene read back from storage", () => {
  test("a whole scene comes back as it was", () => {
    assert.deepEqual(asScene({ ...SCENE, extra: 1 }), SCENE);
  });

  test("a scene with a missing or empty picture, or no size, is not one", () => {
    const broken: unknown[] = [
      null,
      { ...SCENE, scene_id: 1 },
      { ...SCENE, width: 0 },
      { ...SCENE, height: Number.NaN },
      { ...SCENE, relief: "0.3" },
      { ...SCENE, image: "" },
      { ...SCENE, depth: undefined },
      { ...SCENE, normals: null },
    ];
    for (const record of broken) assert.equal(asScene(record), null, JSON.stringify(record));
  });

  test("isDraftScene knows a scene opened from a draft by its id", () => {
    assert.equal(isDraftScene({ ...SCENE, scene_id: "draft:abc" }), true);
    assert.equal(isDraftScene(SCENE), false);
  });
});

describe("draftName", () => {
  test("is the file's name without its ending", () => {
    assert.equal(draftName("IMG_0042.JPG"), "IMG_0042");
    assert.equal(draftName("holiday.photo.heic"), "holiday.photo");
    assert.equal(draftName("  spaced out .png"), "spaced out");
    assert.equal(draftName("no-ending"), "no-ending");
  });

  test("a paste, a drop with no file name, or nothing at all is a pasted photo", () => {
    for (const name of ["pasted image.png", "dropped image", "", ".jpg", "   "]) assert.equal(draftName(name), "Pasted photo", JSON.stringify(name));
  });

  test("is cut to 80 characters", () => {
    assert.equal(draftName(`${"a".repeat(200)}.jpg`).length, 80);
  });
});

describe("fingerprint", () => {
  test("is the first half of the SHA-256 of the picture's base64, in hex", async () => {
    const base64 = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";
    assert.equal(await fingerprint(base64), createHash("sha256").update(base64).digest("hex").slice(0, 32));
  });

  test("the same picture gives the same one, another picture another", async () => {
    assert.equal(await fingerprint("abc"), await fingerprint("abc"));
    assert.notEqual(await fingerprint("abc"), await fingerprint("abd"));
  });

  test("without SHA-256 (a page on a Wi-Fi address) it falls back to running sums, still the same for the same picture", async () => {
    const real = Object.getOwnPropertyDescriptor(globalThis, "crypto");
    Object.defineProperty(globalThis, "crypto", { value: { subtle: { digest: () => Promise.reject(new Error("not here")) } }, configurable: true });
    try {
      const a = await fingerprint("abc");
      assert.match(a, /^f3-[0-9a-f]+-[0-9a-f]+$/);
      assert.equal(await fingerprint("abc"), a);
      assert.notEqual(await fingerprint("abd"), a);
    } finally {
      if (real) Object.defineProperty(globalThis, "crypto", real);
    }
  });
});

describe("whenChanged", () => {
  const now = new Date(2026, 9, 11, 15, 30).getTime();
  const minutes = (n: number) => now - n * 60_000;

  test("counts minutes and hours today", () => {
    assert.equal(whenChanged(now - 20_000, now), "just now");
    assert.equal(whenChanged(minutes(1), now), "1 minute ago");
    assert.equal(whenChanged(minutes(5), now), "5 minutes ago");
    assert.equal(whenChanged(minutes(70), now), "1 hour ago");
    assert.equal(whenChanged(minutes(185), now), "3 hours ago");
  });

  test("then yesterday, then the date", () => {
    assert.equal(whenChanged(new Date(2026, 9, 10, 23, 0).getTime(), now), "yesterday");
    assert.equal(whenChanged(new Date(2026, 9, 1, 12, 0).getTime(), now), new Date(2026, 9, 1).toLocaleDateString(undefined, { day: "numeric", month: "long" }));
    assert.equal(whenChanged(new Date(2025, 0, 2).getTime(), now), new Date(2025, 0, 2).toLocaleDateString(undefined, { day: "numeric", month: "long", year: "numeric" }));
  });
});
