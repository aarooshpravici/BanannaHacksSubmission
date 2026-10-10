# Test this first

Saturday Oct 10, evening update (Central), for version `328abc5` or later.

The full plan in [TEST_PLAN.md](TEST_PLAN.md) has 172 cases. You do not need to do them all. This page says what helps most right now, in order. The developer rewrites this page after every update, so check its date before you start.

**What changed since the afternoon update.**

- **Faces under side light.** The dark side of a face now fades in gradually. The hard, straight line across the astronaut's forehead and cheek, and the dark wedge on the cat, should be gone.
- **A static demo.** A copy of the app that needs no server and can sit on a web address. It has the four samples only; uploading and Enhance are switched off there. Its pill is green and reads "demo: runs in your browser".
- **Presets always give the same numbers**: Left x -0.10, Right x 1.10, Top y -0.15, on every window and photo. If that point is beyond the stage, the sun is drawn at the stage's edge.
- **"Reset" is now "Reset light"**, and all five preset buttons fit on one line, on a phone too.
- **"New photo" starts clean**: the light, Colour, Cast shadows, Detailed normals and the Enhance text all go back to their start.
- **"Stop sweep" and "Hold to see original" turn yellow** while they are active.
- **A failed Enhance** shows its red bar above the photo on a laptop window (inside the ENHANCE panel on a phone), so the sidebar no longer scrolls.
- **On a phone a failed load** puts its card under the photo, not on top of it.
- **No live shading and no backend**: one red bar with **Retry**, and the light controls switch off, where there used to be two bars that contradicted each other.
- **Plan B**: the Detailed normals switch is greyed on a sample, so it can no longer turn the sample into a dome.
- Smaller things: our own sentence when a sample cannot be loaded, and shorter grey words in the Enhance box that are no longer cut off.

All 84 screenshots were retaken this evening and 19 were added (103). If you tested earlier today, get the update first: "Getting fixes" in [SETUP.md](SETUP.md#what-to-expect).

**The quickest way in.** If you cannot get the backend installed, you can still test most of the app. Do [Plan B in SETUP.md](SETUP.md#plan-b-no-backend-mock-mode): it needs only Node, takes about five minutes, and the four samples work fully in it. If Aaroosh has given you a demo address, that needs nothing at all: open it in a browser. Only three things need the backend: uploading your own photo, **Enhance** on the normal setup, and turning **Detailed normals** off.

## Do these now

1. **Set the app up on your own computer**, following [SETUP.md](SETUP.md) word for word.
   This tests the instructions as much as the app. Nobody has tried them on a second computer, and nobody has tried the Windows steps at all. Write down each step that confused you or failed, how long the model download took, and what computer you have. If the backend will not install, report where it failed, switch to Plan B, and carry on.
2. **Check that the light works in your browser, on your computer.** Do case **W-16**. It takes five minutes and needs no backend.
   The lighting is drawn by your graphics chip, and the part that draws it was changed again this evening. It has only ever run in Chrome on one Mac. On your computer one of three things happens: the photo responds to the light; a red bar "Live shading is unavailable" appears; or the picture is black or wrong with no message. We need to know which, for every browser and device you have, **even when it simply works**.
3. **Look at the face under side light.** Do case **Q-11**: the **Portrait** sample with **Right**, **Left**, **Top** and a **Sweep**, then the **Cat** sample.
   This is the main change of the round. We need eyes on two things: is the hard, straight line really gone everywhere, and is the side lighting still strong enough to look lit. Give a score and attach a screenshot if you see any hard line.
4. **Do the 10-minute smoke test** in [README.md](README.md#10-minute-smoke-test).
5. **Confirm the fixed bugs.** Each of these was wrong this afternoon. Do them in this order; each takes a minute or two.
   - **C-11** and **C-05**: presets give the same numbers on every window and photo.
   - **C-07**: **Reset light**, and what it leaves alone.
   - **U-07**: **New photo** puts everything back to its start.
   - **L-09** and **K-01**: **Stop sweep** and **Hold to see original** turn yellow.
   - **W-17** and **W-04**: the five preset buttons on one line on a phone.
   - **W-13**: the grey words in the Enhance box are not cut off at 1280 x 720.
   - **R-03**, **R-17** and **R-21**: a failed Enhance shows above the photo and the sidebar does not scroll (needs the backend installed, then stopped).
   - **R-19**: on a phone the failed-load card sits under the photo (needs the backend installed, then stopped).
   - **P-09**: in Plan B the Detailed normals switch is greyed on a sample.
   - **U-22**: the new sentence when a sample cannot be loaded.
6. **The static demo, if you were given an address.** Do group H: **H-01**, **H-03** and **H-04** on a computer, then **H-05** on a real phone.
   This is what a judge will most likely open. It has never been opened from a real web host or on a real phone. No address? Skip this, or on a Mac build it yourself with [Plan C in SETUP.md](SETUP.md#plan-c-the-static-demo-on-your-own-computer) (case H-08).
7. **Shadows.** Do S-01, S-06 and S-07, then give your opinion in Q-05 and Q-06.
   The shadow code was not changed this round. Three things are known and still there: a soft darker column on the rocket's sky, a faint cup shadow on the saucer, and a faint dark fringe beside far shadows. We need to know how much they bother you.
8. **Try your own photos.** Do case T-09, then the picture-quality cases Q-01 to Q-04 and Q-09.
   For anything that looks wrong, send a screenshot and the photo itself.
9. **Open it cold and react.** Do case J-01: sixty seconds with no instructions. Then write what you tried first and what confused you.

## Wait on these

Nothing is being rebuilt right now, so no case is about to go out of date. These are simply lower value today; leave them until the list above is done.

- The unusual-file cases U-13 to U-16.
- The backend-message cases R-09, R-10, R-12 and R-14.
- The no-live-shading cases R-11, R-20 and H-07, unless your browser shows that red bar by itself.
- The arrow-key case L-12 (a known small oddity).
- The access case J-10.
- The cases marked "only with a key" (see below).

## Only Aaroosh

- **Real Enhance** (cases E-10, E-12, E-13 and E-18). It needs a private key and each press costs money. Everyone else tests Enhance with the stand-in, which is free. Case E-11 is not on this list: it needs no key and costs nothing, so anyone with no `.env` file in the project folder can do it.
- **Putting the static demo online** and telling the testers its address.

## How to report

Use the two links under [Reporting what you found](README.md#reporting-what-you-found). One opens a filled-in form for a bug, the other for a finished test run. The developer reads those GitHub issues and nothing else, so anything said only in a chat will not reach them.

One bug per issue. Always include the case ID, your computer and browser, the photo (or the sample's name), and a screenshot. On the hosted demo, write "demo" where the form asks for the pill, and "hosted demo" with the page address where it asks for the version. Before you report, read "Already known: no need to report" at the top of [PENDING.md](PENDING.md#already-known-no-need-to-report): it was rewritten this evening.
