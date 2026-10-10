# Overnight report (night of Oct 9–10)

Branch: `overnight-foundation`, pushed to GitHub. `main` is untouched.

## Recommendation

**All three ideas produced real output tonight, so this is now a choice, not a rescue.** I lean Relight, because most of it is our own code and the rubric marks thin API wrappers down, but it is a close call.

| Idea | What was actually run | Our own code vs hosted model | Confidence it can make a convincing demo |
|---|---|---|---|
| Relight | Full pipeline on 3 real photos locally; the Enhance step once on Gemini | Mostly ours: depth, normals, shading, shadows. Gemini only polishes. | 80% |
| Character Views | One full real run: generated a character, analyzed it, drew a side view, scored it (identity 0.83, checklist 7/7) | Mostly Gemini; ours is the feature spec, checklist and retry loop | 75% |
| Design Autocomplete | Gap detection on 12 synthetic designs (11 correct); two real fills of a missing pricing card | About half: detection, ranking and blending are ours; the fill is Gemini | 70% |

Each real result is a single run on a favourable input. One success shows the path works; it does not show how often it works.

## Look at these first

- `proofs/live/character_side_view.jpg`: a generated test character and the side view the pipeline drew of it.
- `proofs/live/inpaint_pricing_card.jpg`: the missing pricing card filled in, two candidates with their scores. Text is readable; the card's text is centred where its neighbours' is left-aligned, and a faint edge shows where it meets the page.
- `proofs/live/relight_enhance.jpg`: original, our shaded preview, and Gemini's re-render of it.
- `proofs/relight/object.jpg` and `portrait.jpg`: row 2 is the original plan's method, row 3 is the method now in use.
- `proofs/autocomplete/detections/`: blue = blocks found, green = gap reported, dashed red = the true gap.

## Try it yourself

Two terminals. Backend first:

```bash
cd backend && .venv/bin/uvicorn app.main:app --port 8000
```

Then the frontend:

```bash
cd frontend && npm run dev
```

Open http://localhost:3000. Out of the box the frontend runs on canned data and ignores the backend. To connect them, copy `frontend/.env.local.example` to `frontend/.env.local`, set `NEXT_PUBLIC_MOCK=0`, and restart `npm run dev`. The relight page then works fully (it needs no hosted service). The other two pages use stand-in generation until `MOCK_MODE=0` is set in the root `.env`, which starts spending on the Gemini key.

## What exists

| Piece | How it was checked | Confidence it is right |
|---|---|---|
| Backend core: image and mask handling, background jobs, image cache | Automated tests | 90% |
| Scoring: image similarity, palette match, rank-and-retry loop | Tests, plus a sanity run on real photos | 85% the code is right; 50% that scores track "looks good" on generated images |
| Background removal | Ran on a simple test figure | 85% on simple images; unknown on real character art |
| Relight: depth, normals, shading, shadows, endpoints | 17 tests on shapes with known answers, plus the proof sheets | 85% |
| Autocomplete: gap detection | 11/12 on my mockups, 27/31 on an independent reviewer's designs, 133/134 on re-exports | 80% on clean flat designs; 30% on busy, photo-backed or table-like designs |
| Autocomplete: fill, ranking, Poisson blending | Tests with a stand-in generator, plus one real run of two fills | 80% |
| Character Views: analysis, prompts, checklist, retry | Tests with stand-ins, plus one real run. The retry path has never fired on real output. | 80% |
| Gemini calls (planner, analyst, checklist, image generation) | Called for real: 4 text paths and 3 image paths each succeeded once | 85% |
| fal, Replicate and Anthropic calls | Signatures checked against the installed packages and the fal model pages; never run (fal account has no credit, no key for the others) | 55% |
| Frontend: shared core and three pages | Lint and build pass. I loaded each page in a browser against the real local backend: live relighting with a draggable light, gap detection on a sample poster, character cutout and checklist. The helper that built it measured the browser shader against the server render (mean difference about 1.6 levels out of 255). | 90% for relight; 80% for the other two with real generation, which the frontend has not been run with |

The backend suite is 139 tests passing and 6 expected failures. Each expected failure is a design the gap detector is known to get wrong, kept in the suite so the limit stays visible.

## Where the plans were wrong

1. **Relight, normals.** Normals derived from the small depth model left faces almost unshaded. Marigold normals fixed it (about 1–1.5 s once per photo on this Mac's GPU; slow on a CPU-only server).
2. **Relight, falloff.** A plain inverse-square point light made the whole photo go dark when the light moved sideways. The falloff is now measured relative to the scene centre, so exposure stays steady.
3. **Relight, interface.** The plan's `relight(image, x, y, intensity)` server call would lag on every drag. The server now sends depth and normal maps once and the browser shades live.
4. **Autocomplete, SAM.** SAM took about 12 s per image and split photos into pieces instead of treating each as a block. Reading layout blocks directly (flood-fill across an edge map) took about 7 ms and was more accurate. SAM remains as an option.
5. **Character Views, model choice.** Zero123++ (the plan's Option A) only outputs six fixed tilted angles, with no true front, side or back, and I found no hosted MV-Adapter or Era3D. The code uses instruction-based image editing instead, which worked on the first real run with Gemini's image model.
6. **All plans, image provider.** The plans assumed fal.ai or Replicate. Gemini's image model turned out to cover all three generation jobs on one key, so `IMAGE_PROVIDER` now defaults to Gemini when it has a key.

## Independent review

Because you cannot review the code yourself, I had a separate agent hunt for bugs in the backend without seeing my conclusions. It checked the relight math against a brute-force reference and a rendered sphere, the depth and normal encoding sent to the browser, the provider call shapes against the live schemas, and thread safety, and found those correct. It also found real bugs my tests had missed. All of these are fixed, each in its own commit with a test:

1. A mask exported from a browser canvas selected the whole image, so a fill would have regenerated the full width.
2. Blending disturbed pixels well outside a hand-drawn mask (my tests only used rectangles).
3. Gemini's fills came back slightly zoomed and shifted, so the new element landed off its slot. Fills are now aligned to the original first.
4. The character retry prompt asked for a feature again when the problem was that it should not have been drawn.
5. Gemini calls had no timeout, so a stalled request could hang the app.
6. Character cutouts had a dark fringe at their edges.
7. Three small input-handling crashes.

Not fixed: the spending cap is stored in the cache folder, so deleting `.cache` resets the count.

## Second, wider review (run while you slept)

After the first review I ran a larger one: five reviewers in parallel, each finding then attacked by a second agent trying to disprove it. All 27 findings survived. Three rounds of fixes followed, each checked by another skeptic, and I ran the full suite myself before every commit.

**Gap detection on designs I did not draw.** This was the number I had flagged as untrustworthy, and it was:

| Design set | Before | After |
|---|---|---|
| My own 12 mockups | 11 correct | 11 correct |
| 31 designs drawn by an independent reviewer | 23 correct, 5 false positives | 27 correct, 2 false positives |
| 10 probes aimed at weak spots | 2 correct | 7 correct |
| 134 re-exports (JPEG, resized, inside a browser frame) | 124 correct | 133 correct |

The two worst problems are fixed: an invented gap at the end of any complete left- or right-aligned row, and gaps inside framed panels never being examined. What it still gets wrong:

- Elements that touch or share a border (ruled tables, galleries with very thin gutters) are read as one block. No cheap fix.
- Three of four columns filled from the left cannot be told apart from a centred row missing its last card, so the empty fourth column is reported.
- Pale borderless cards exported as JPEG are often missed, and so is a pale card with a saturated icon within 16 px of its edge.
- A plain pale block on a dark page can be reported as an empty box.
- Cards laid over a photo (from the first night's testing).

**Frontend bugs fixed.** A job stayed on "pending" forever if you switched pages while it ran and came back. Regenerate on the character page could never return a new image. Enhance ignored the cast-shadows toggle. Retry after a failed fill paid for the images again. Undo could show the gaps of a different image.

**Backend bugs fixed.** The fill-alignment step could shear a correctly placed fill on low-detail designs; it now applies only zoom and shift. A server crash was reported in the browser as "cannot reach the backend". An all-black upload crashed the palette code. One stray pixel could make a mask select the whole image.

**Confirmed correct.** The browser's relight shading matches the server within 4 levels out of 255 across 96 cases (sizes, light positions, shadows on and off). The frontend's data shapes match the backend field for field.

**Tried and dropped.** A correction for the faint colour step along hand-drawn masks moved the step to the middle of the mask instead, so it was removed. That step remains a cosmetic limit of brush-drawn masks.

## Open risks

- **Deadline: Sunday Oct 11, 11:59 PM** (confirmed by Aaroosh). Three of the four plan documents assume Monday, so their timelines are a day too long. The time zone was not stated; plan for EDT. Freeze features by Sunday early afternoon and keep the evening for the video and the 500-word write-up.
- **Thin-wrapper risk for Character Views.** Gemini did nearly all the work on the test run, and every feature passed first time, so the retry loop (the plan's "caught and fixed" demo moment) had nothing to do. The demo would need harder cases, such as back views or fiddly accessories, to show our part.
- **One real run each.** See the note under the recommendation table.
- **Gap detection is right on about 27 of 31 unfamiliar synthetic designs, not 11 of 12.** See the second review above for what it still misses. No real designer's file has been tried yet, and the detector's thresholds were tuned on drawings, so expect it to do worse on real files than on these.
- **Gemini fills take no mask.** The region is pointed out with an outline and the result is pasted back through the real mask. An alignment step now corrects the small zoom and shift Gemini introduces, but it has only been checked on two real outputs. fal's FLUX Fill takes a true mask but has not been run.
- **The frontend has not been run with real generation.** It was checked against the backend with stand-in generators. The relight page is unaffected, since its live preview uses no hosted service.
- **The frontend was checked in one browser only**, at desktop width. Safari, Firefox and phones are untested.
- **Known relight weak spot.** Light from below gives blotchy shadow bands on faces. Side and top light look convincing.
- **Deployment has not been started.** The local models total about 6 GB and Marigold wants a GPU. A locally recorded demo video avoids this entirely if a live URL is not required.
- **State is in memory.** Uploaded scenes, characters and jobs are lost when the server restarts, and the server must run as a single process.
- **Character Views pass threshold (0.75) is a guess.** One real run scored about 0.9; that is one data point.
- **Licenses.** Depth Anything V2 Small is Apache-2.0. Marigold normals is CreativeML Open RAIL++-M, which has use restrictions worth a read before the write-up. Gemini's and fal's terms were not checked.

## Money spent

- **Gemini images: 9 calls**, against a cap of 10 enforced in code (`GEMINI_IMAGE_CALL_LIMIT`, counted in `.cache/spend.json`). Five were the planned checks. **Four were a mistake:** a test that deliberately switches the stand-in mode off found the real key in `.env` and generated four tiny images. The suite now blanks every key before loading and has a test that fails if one is visible.
- **Gemini text: about 6 calls** on the Flash model.
- **fal: nothing.** The key is valid but the account balance is zero.

## Needs you

1. **Pick the idea** with your team, using the proof images above.
2. **Ask in the hackathon Discord** whether the deadline is EDT or AoE, and whether GPU credits exist.
3. **Decide the Gemini image budget.** One call is left under the cap. To allow more, set `GEMINI_IMAGE_CALL_LIMIT` in `.env` to the new total.
4. **Collect real test images** for the chosen idea and try them: real designs for Autocomplete, real character drawings (including back views) for Character Views, portraits and objects for Relight.
5. **Have each teammate install the secret check** after cloning (one line, at the top of `tools/check_secrets.py`). The repo is public.
6. **Optional: top up fal** at fal.ai/dashboard/billing if you want true mask-based inpainting. Gemini covers everything else.
