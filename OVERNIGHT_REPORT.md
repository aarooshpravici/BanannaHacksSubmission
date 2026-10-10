# Overnight report (night of Oct 9–10)

Branch: `overnight-foundation` (commits are local; the push was refused, see "Needs you" below).

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

## What exists

| Piece | How it was checked | Confidence it is right |
|---|---|---|
| Backend core: image and mask handling, background jobs, image cache | Automated tests | 90% |
| Scoring: image similarity, palette match, rank-and-retry loop | Tests, plus a sanity run on real photos | 85% the code is right; 50% that scores track "looks good" on generated images |
| Background removal | Ran on a simple test figure | 85% on simple images; unknown on real character art |
| Relight: depth, normals, shading, shadows, endpoints | 17 tests on shapes with known answers, plus the proof sheets | 85% |
| Autocomplete: gap detection | 26 tests, 11/12 mockups, stress test (JPEG, resize, blur, noise) | 80% on clean flat designs; 30% on busy or photo-backed designs |
| Autocomplete: fill, ranking, Poisson blending | Tests with a stand-in generator, plus one real run of two fills | 80% |
| Character Views: analysis, prompts, checklist, retry | Tests with stand-ins, plus one real run. The retry path has never fired on real output. | 80% |
| Gemini calls (planner, analyst, checklist, image generation) | Called for real: 4 text paths and 3 image paths each succeeded once | 85% |
| fal, Replicate and Anthropic calls | Signatures checked against the installed packages and the fal model pages; never run (fal account has no credit, no key for the others) | 55% |
| Frontend | See the "Frontend" section | See there |

The backend suite is 88 tests passing and 1 expected failure (cards over a photo).

## Where the plans were wrong

1. **Relight, normals.** Normals derived from the small depth model left faces almost unshaded. Marigold normals fixed it (about 1–1.5 s once per photo on this Mac's GPU; slow on a CPU-only server).
2. **Relight, falloff.** A plain inverse-square point light made the whole photo go dark when the light moved sideways. The falloff is now measured relative to the scene centre, so exposure stays steady.
3. **Relight, interface.** The plan's `relight(image, x, y, intensity)` server call would lag on every drag. The server now sends depth and normal maps once and the browser shades live.
4. **Autocomplete, SAM.** SAM took about 12 s per image and split photos into pieces instead of treating each as a block. Reading layout blocks directly (flood-fill across an edge map) took about 7 ms and was more accurate. SAM remains as an option.
5. **Character Views, model choice.** Zero123++ (the plan's Option A) only outputs six fixed tilted angles, with no true front, side or back, and I found no hosted MV-Adapter or Era3D. The code uses instruction-based image editing instead, which worked on the first real run with Gemini's image model.
6. **All plans, image provider.** The plans assumed fal.ai or Replicate. Gemini's image model turned out to cover all three generation jobs on one key, so `IMAGE_PROVIDER` now defaults to Gemini when it has a key.

## Open risks

- **Deadline.** The relight doc says Sunday Oct 11, 11:59 PM EDT; the other plans say Monday. Unconfirmed.
- **Thin-wrapper risk for Character Views.** Gemini did nearly all the work on the test run, and every feature passed first time, so the retry loop (the plan's "caught and fixed" demo moment) had nothing to do. The demo would need harder cases, such as back views or fiddly accessories, to show our part.
- **One real run each.** See the note under the recommendation table.
- **My test designs suit my detector.** I drew the autocomplete mockups myself. Real designs are the test that counts. Cards laid over a photo are a known miss.
- **Gemini fills take no mask.** The region is pointed out with an outline and the result is pasted back through the real mask. If the model shifts the layout even slightly, the pasted patch will be misaligned. fal's FLUX Fill takes a true mask but has not been run.
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

1. **Fix the GitHub push.** This Mac is signed in to GitHub as `AarKur`, which has no write access to `aarooshpravici/BanannaHacksSubmission`. Add `AarKur` as a collaborator (repo Settings → Collaborators) and accept the invite, then:
   ```bash
   git push -u origin overnight-foundation
   ```
2. **Decide the Gemini image budget.** One call is left under the cap. To allow more, set `GEMINI_IMAGE_CALL_LIMIT` in `.env` to the new total.
3. **Confirm the deadline and GPU credits** in the hackathon Discord.
4. **Collect real test images** for whichever idea is chosen, and try them: real designs for Autocomplete, real character drawings (including back views) for Character Views, portraits and objects for Relight.
5. **To use the real services in the app**, set `MOCK_MODE=0` in `.env`. It is `1` by default so nothing is spent by accident.
