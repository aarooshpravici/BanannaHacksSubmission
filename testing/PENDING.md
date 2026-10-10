# Pending: what the developer has NOT verified

The developer is an AI working on one Apple-chip Mac with Chrome. It cannot see a screen the way you do, has no Windows computer, no phone, and is not allowed to spend money on the paid Enhance service while testing. Everything below needs human eyes. **Most important first.**

Case IDs refer to [TEST_PLAN.md](TEST_PLAN.md). When you have checked an item, say so in your report with the item number (for example "PENDING 3: checked, see results").

Last updated: 2026-10-10.

## Already known: no need to report

The developer already knows about these problems in the app. If you see one, do not open an issue for it. Carry on with the test case. Report it only if it is **worse** than the line says, or if you think it is bad enough to cost us with the judges (say so, with the K number: your opinion on priority is wanted).

The developer deletes a line when the problem is fixed. If a line is gone, the problem should be gone too: report it if you still see it.

- **K1. Jagged shadows on the dark rocket photo.** With `04-dark-rocket.jpg` and the light at the side, the tower and rocket throw wide, blocky dark shadows onto the night sky. Cases: T-04, Q-06.
- **K2. The sidebar does not fit a 1440 x 900 window.** The **Enhance** button sits on the bottom edge and the whole GEOMETRY panel is hidden below it. The sidebar scrolls, but its scrollbar is hard to see. Cases: W-01, P-03, J-01.
- **K3. The developer badge covers content.** The round black "N" badge at the bottom left (shown only when the app runs with `npm run dev`) hides the spinner of "Enhancing in the background, keep dragging" and, at phone size, the start of the word "Height". Cases: E-02, W-04, R-08.
- **K4. A stray full stop in the no-live-shading red bar.** It reads "…in this browser.). Showing server renders instead…". The bar also has no X. Cases: R-06, R-11.
- **K5. Presets land at slightly different positions on different window sizes.** On a small window **Top** gives y -0.07, not -0.15, and **Left** / **Right** give x -0.04 / 1.04, not -0.10 / 1.10, so the same preset lights the photo slightly differently. Cases: C-05, T-02, T-05, T-06.
- **K6. The status pill lags by up to 10 seconds.** After the backend stops, the pill still says "online, mock providers" for up to 10 seconds while **Enhance** already fails with "Cannot reach the backend…". Cases: R-03, R-15.
- **K7. A photo that failed to load looks like a loaded one.** It shows at full brightness with greyed buttons and no sun. Only the red bar says something is wrong. Cases: R-02, R-13.
- **K8. Wasted space on phones.** At phone size a square photo sits small in the middle of the stage with large black bands above and below, and the LIGHT controls start below the first screen. Cases: W-04, W-05.
- **K9. The default light is subtle.** With the starting light on the portrait, and with any light on the cat photo, the change is small enough that a visitor may think nothing happened. Cases: L-01, T-03, Q-07.
- **K10. "Hold to see original" does not look pressed.** The button should turn yellow while held; in the developer's screenshot it looks unchanged. Cases: K-01, K-04.
- **K11. Stand-in Enhance: the two halves are not identical.** In the normal setup the "Enhanced" half differs slightly in shadow softness from the "Live preview" half (two different programs draw them). Cases: E-03, Q-10.
- **K12. "New photo" and "Reset" keep some settings.** Both keep the ENHANCE text; "New photo" also keeps the **Cast shadows** and **Detailed normals** switches. Cases: U-07, C-07, P-06.

## Open items

| # | What is not verified | Why the developer could not verify it | Test cases | Status |
| --- | --- | --- | --- | --- |
| 1 | **Does the relighting look believable to a person?** Lit side looks lit, shadows fall the right way, faces look natural, where it looks fake. | Automated checks compare numbers, not looks. The developer viewed the screenshots, but only of four stock photos and one drawn ball. | Q-01 to Q-09, T-09, J-06 | open |
| 2 | **Real Enhance through the page** (backend `MOCK_MODE=0` with a key). | Run **once ever**, from a script, on one photo, and never from the web page. Not allowed to call the paid service during testing. In that one result ([proofs/live/relight_enhance.jpg](../proofs/live/relight_enhance.jpg)) the enhanced picture kept much less of the side lighting than the preview, so it may undo the effect. The fal.ai route has never been run at all. On Aaroosh's Mac 9 of the 10 allowed Gemini calls are already used, so real Enhance there stops after one more call. The limit of 10 exists for Gemini only; with a fal.ai key there is no limit. | E-10, E-12, E-13, E-14, E-18 | open |
| 3 | **Windows.** Install, start commands, speed, the page in Chrome and Edge on Windows. | No Windows computer. The Windows commands in [SETUP.md](SETUP.md) were written from knowledge, not run. | All of SETUP, smoke test, D-01, D-05, W-12 | open |
| 4 | **Computers without an Apple chip or NVIDIA card** (Intel Macs, most Windows laptops). How long a photo takes to prepare. | Only one computer available. The time could be seconds or minutes. The limits in SETUP are targets, not measurements. On an Intel Mac the backend may not install at all (see SETUP, macOS step 1). | D-01, D-05, P-04 | open |
| 5 | **Setup from nothing on a second computer.** A fresh clone, the `python.org` + `venv` route, the one-time model download (SETUP step 4) and how long it takes. | The developer's computer already had everything installed (with conda) and the models downloaded. The download command in step 4 was run there only with the models already present. | SETUP, P-05 | open |
| 6 | **Browsers other than Chrome**: Safari, Firefox, Edge. | Only Chrome (version 154, without a visible window) was used. | W-09 | open |
| 7 | **A real phone or tablet, and touch.** | No phone. Screenshots 45 to 47 are a desktop browser pretending to be phone-sized. Also a phone cannot reach `localhost` on your computer, so with this setup only the phone imitation in Chrome can be tested. | W-04, W-05 | open |
| 8 | **Light from below on faces.** Known weak spot from the first night: blotchy shadow bands. Unknown how bad it looks now and whether it matters for a demo. | Needs a human judgement of "how bad". | Q-05, C-06 | open |
| 9 | **Shadows thrown onto open sky** (dark rocket photo, screenshot 36). Looks like a glitch. Unknown how common it is on ordinary outdoor photos. | Seen on one photo only. | T-04, Q-06, T-09 | open |
| 10 | **Downloads.** The files `relit.png` and `relit-enhanced.png`: that they download, open, have the right size and match the screen. | The screenshot tool did not click the download buttons this round. | X-01 to X-05 | open |
| 11 | **Paste from the clipboard, and the yellow highlight when dragging a file over the drop box.** | Not scripted. | U-03, U-04, U-13, U-14 | open |
| 12 | **Dropping a file anywhere except the drop box** (including onto a loaded photo). The app has no handling for this; the browser probably opens the file and leaves the app. | Not tried. | U-09 | open |
| 13 | **Keyboard use**: arrow keys on the sun and the divider, the white selection ring, Space on "Hold to see original". | The screenshot tool removes keyboard selection before each picture. In Safari a mouse click does not select a button, so use the Tab key to reach the sun before pressing arrow keys. | L-05, L-08, K-03, C-08, C-10, E-04, U-12 | open |
| 14 | **"Hold to see original" turning yellow while held.** The code says it should; in screenshot 27 it looks unchanged. | Too small to tell from the screenshot. Listed as known issue K10 until someone confirms it either way. | K-01, K-04 | open |
| 15 | **Error messages never triggered**: "unknown scene id; upload the photo again" after a backend restart; "FAL_KEY is not set in .env"; "spending cap reached"; "The job is taking too long. Try again."; "could not read image"; "The server hit an unexpected error. See the backend log."; a failed server render. | No honest way to cause them from the page without stopping the backend mid-test, a key, or a broken file. | R-04, R-09, R-10, R-11, R-14, E-11, E-13, E-14, E-18, U-15, X-06 | open |
| 16 | **Hover texts** on the status pill and the small download button. | They do not appear in screenshots. Their wording was read from the code. | R-01, R-05, X-04 | open |
| 17 | **Very short loading states**: "Reading image…" in the drop box and "Preparing the shader…". | They pass in well under a second. | P-01, U-17 | open |
| 18 | **Mouse pointer shapes** (crosshair over the stage, grab hand over the sun) and the file chooser window. | Not visible in screenshots. | L-02, L-03, U-02 | open |
| 19 | **Long sessions**: many photos without reloading, memory, slowdown. | Each automated run loads a few photos and stops. | D-06 | open |
| 20 | **Real-world photos**: phone photos (including `.heic` and sideways ones), see-through PNGs, groups, landscapes, screenshots. | Only the test photos were used. | U-10, U-11, U-16, T-09, T-10, J-08 | open |
| 21 | **Smoothness on other graphics chips**, and browsers where live shading is unavailable. | One Mac only. The fallback (screenshot 52) was imitated, not met on a real computer. | D-02, R-06, R-11, R-12 | open |
| 22 | **A first-time visitor's experience**: is it obvious what to do. | The developer wrote the page and cannot un-know it. | J-01, J-07, Q-07 | open |
| 23 | **A hosted (online) copy of the app.** | None exists yet. Everything is local. | none | open |
| 24 | **The 28 test cases added after the first review of this kit.** Their "Expected" text was written by reading the program code. None was run. Nine carry the line "Developer note: possible bug": the code probably does the wrong thing there, and we need to know how it looks to a person. | Written from code, without a browser. | U-12 to U-17, P-06, L-08, C-10, K-04, E-15 to E-18, X-06, W-10 to W-12, T-10, R-09 to R-15, J-09, J-10 | open |
| 25 | **The two "new issue" links in README.** That they open a filled-in form for someone who is not the repository owner. | The links were built and checked by a program, not clicked in a browser. | README, Reporting | open |

## Log

The developer adds a line here whenever something is checked, fixed or newly found. Newest first.

| Date | Item | What changed |
| --- | --- | --- |
| 2026-10-10 | kit | After a review by a fresh reader: 28 test cases added (137 in total), setup corrected (model download step, `npm ci`, Intel Mac warning, missing-branch advice), reporting changed to two ready-made issue links, known issues moved to the top of this page, screenshots converted from PNG to JPEG (same names, ending `.jpg`). |
| 2026-10-10 | all | List created with the tester kit. 58 screenshots taken in Chrome on macOS. |
