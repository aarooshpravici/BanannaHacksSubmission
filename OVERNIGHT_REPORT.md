# Overnight report (night of Oct 9–10)

Branch: `overnight-foundation` (commits are local; the push was refused, see "Needs you" below).

## Recommendation

**Pick Relight.** It is the only idea with real output images to look at, it needs no paid API for its core, and it has the strongest "we built this ourselves" story for the judging rubric. Design Autocomplete is second: its gap detection works, but its fill step is untested. Character Views is last: nothing about it has been run for real, and most of it is a hosted model doing the work.

| Idea | What was actually run | Biggest unknown | Confidence it can make a convincing demo |
|---|---|---|---|
| Relight | Full pipeline on 3 real photos, locally | The optional "Enhance" step (needs fal) | 75% |
| Design Autocomplete | Gap detection on 12 synthetic designs (11 correct) | Whether inpainting can draw a matching card with readable text | 45% |
| Character Views | Code paths only, with stand-in generator and LLM | Whether any hosted model keeps a character on-model at a new angle | 35% |

## Look at these first

- `proofs/relight/object.jpg` and `portrait.jpg`: row 2 is the original plan's method, row 3 is the method now in use.
- `proofs/autocomplete/detections/`: blue = blocks found, green = gap reported, dashed red = the true gap.

## What exists

| Piece | How it was checked | Confidence it is right |
|---|---|---|
| Backend core: image and mask handling, background jobs, image cache | Automated tests | 90% |
| Scoring: image similarity, palette match, rank-and-retry loop | Tests, plus a sanity run on real photos | 85% the code is right; 50% that scores track "looks good" on generated images |
| Background removal | Ran on a simple test figure | 85% on simple images; unknown on real character art |
| Relight: depth, normals, shading, shadows, endpoints | 17 tests on shapes with known answers, plus the proof sheets | 85% |
| Autocomplete: gap detection | 26 tests, 11/12 mockups, stress test (JPEG, resize, blur, noise) | 80% on clean flat designs; 30% on busy or photo-backed designs |
| Autocomplete: fill, ranking, Poisson blending | Tests with a stand-in generator | 80% for the code; real output quality unknown |
| Character Views: analysis, prompts, checklist, retry | Tests with stand-in generator and LLM | 75% for the code; real output quality unknown |
| fal, Replicate, Gemini and Anthropic calls | Function signatures checked against the installed packages and the fal model pages; never called | 60% |
| Frontend | See the "Frontend" section | See there |

The backend suite is 85 tests passing and 1 expected failure (cards over a photo).

## Where the plans were wrong

1. **Relight, normals.** Normals derived from the small depth model left faces almost unshaded. Marigold normals fixed it (about 1–1.5 s once per photo on this Mac's GPU; slow on a CPU-only server).
2. **Relight, falloff.** A plain inverse-square point light made the whole photo go dark when the light moved sideways. The falloff is now measured relative to the scene centre, so exposure stays steady.
3. **Relight, interface.** The plan's `relight(image, x, y, intensity)` server call would lag on every drag. The server now sends depth and normal maps once and the browser shades live.
4. **Autocomplete, SAM.** SAM took about 12 s per image and split photos into pieces instead of treating each as a block. Reading layout blocks directly (flood-fill across an edge map) took about 7 ms and was more accurate. SAM remains as an option.
5. **Character Views, model choice.** Zero123++ (the plan's Option A) only outputs six fixed tilted angles, with no true front, side or back, and I found no hosted MV-Adapter or Era3D. The code uses instruction-based editing on fal instead (`nano-banana/edit`, with FLUX Kontext as the alternative). Untested.

## Open risks

- **Deadline.** The relight doc says Sunday Oct 11, 11:59 PM EDT; the other plans say Monday. Unconfirmed.
- **Nothing hosted has been called.** No key was in `.env` during the session. `backend/scripts/live_checks.py` makes one real call per service and saves the results to `proofs/live/`; it is the first thing to run once keys are in.
- **My test designs suit my detector.** I drew the autocomplete mockups myself. Real designs are the test that counts.
- **Known relight weak spot.** Light from below gives blotchy shadow bands on faces. Side and top light look convincing.
- **Deployment has not been started.** The models total about 6 GB and Marigold wants a GPU. A locally recorded demo video avoids this entirely if a live URL is not required.
- **State is in memory.** Uploaded scenes, characters and jobs are lost when the server restarts, and the server must run as a single process.
- **Character Views pass threshold (0.75) is a guess.** It cannot be calibrated until real generations exist.
- **Licenses.** Depth Anything V2 Small is Apache-2.0. Marigold normals is CreativeML Open RAIL++-M, which has use restrictions worth a read before the write-up. Hosted models' terms were not checked.

## Needs you

1. **Paste keys into `.env`** (`FAL_KEY`, `GEMINI_API_KEY`), then run the live checks:
   ```bash
   cd backend && .venv/bin/python -m scripts.live_checks
   ```
2. **Fix the GitHub push.** This Mac is signed in to GitHub as `AarKur`, which has no write access to `aarooshpravici/BanannaHacksSubmission`. Add that account as a collaborator or sign in as the owner, then:
   ```bash
   git push -u origin overnight-foundation
   ```
3. **Confirm the deadline and GPU credits** in the hackathon Discord.
4. **Collect real test images** for whichever idea is chosen (portraits and objects for Relight).
