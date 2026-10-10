# Test this first

Updated Saturday Oct 10, late afternoon (Central), for version `f477cf1` or later.

The full plan in [TEST_PLAN.md](TEST_PLAN.md) has 158 cases. You do not need to do them all today. This page says what helps most right now, in order. The developer rewrites this page after every update, so check its date before you start.

**What changed this afternoon.** The first page now has four sample photos (Portrait, Coffee cup, Cat, Rocket) that open at once and need no backend. Cast shadows are soft. Every photo starts with a stronger light, at x 0.12, y 0.35. There is a new **Sweep** button. GEOMETRY is folded into one row, the sidebar fits a laptop window, and the phone layout was rebuilt. A photo that fails to load shows a card with **Retry**. All 84 screenshots were retaken today. If you tested this morning, get the update first: "Getting fixes" in [SETUP.md](SETUP.md#what-to-expect).

**The quickest way in.** If you cannot get the backend installed, you can still test most of the app. Do [Plan B in SETUP.md](SETUP.md#plan-b-no-backend-mock-mode): it needs only Node, takes about five minutes, and the four samples work fully in it. Only three things need the backend: uploading your own photo, **Enhance** on the normal setup, and the **Detailed normals** switch.

## Do these now

1. **Check that the light works in your browser, on your computer.** Do case **W-16**. It takes five minutes and needs no backend.
   The lighting is drawn by your graphics chip, and the part that draws it was rewritten today. It has only ever run in Chrome on one Mac. On your computer one of three things happens: the photo responds to the light; a red bar "Live shading is unavailable" appears; or the picture is black or wrong with no message. We need to know which, for every browser and device you have, **even when it simply works**.
2. **Set the app up on your own computer**, following [SETUP.md](SETUP.md) word for word.
   This tests the instructions as much as the app. Nobody has tried them on a second computer, and nobody has tried the Windows steps at all. Write down each step that confused you or failed, how long the model download took, and what computer you have. If the backend will not install, report where it failed, switch to Plan B, and carry on.
3. **Do the 10-minute smoke test** in [README.md](README.md#10-minute-smoke-test).
4. **Samples without the backend.** Do R-16, R-17 and R-18, then the sample cases U-05 and U-18 to U-21.
   This is the path a judge is most likely to take, and it is new today.
5. **Shadows.** Do S-01, S-06 and S-07, then give your opinion in Q-05 and Q-06.
   The shadows were rewritten to be soft. The cup's shadow on the saucer is now fainter than before; that is known. We need eyes on: are near shadows still clear, are far shadows faint, and is there any hard block or stripe left anywhere.
6. **The starting light and the Sweep button.** Do L-01, Q-07, L-09 and L-10, then D-07.
   Does a first-time visitor see at once that the photo was relit? Does Sweep run smoothly and give the light back?
7. **Layout.** Do W-01, W-04, W-13 and W-15 on whatever screen sizes you have.
   The sidebar should now fit a 1440 x 900 and a 1280 x 720 window without scrolling, and on a phone the controls should start right under the photo.
8. **A failed load.** Do R-02 and R-19.
9. **Try your own photos.** Do case T-09, then the picture-quality cases Q-01 to Q-04 and Q-09.
   For anything that looks wrong, send a screenshot and the photo itself.
10. **Open it cold and react.** Do case J-01: sixty seconds with no instructions. Then write what you tried first and what confused you.

## Wait on these

Nothing is being rebuilt right now, so no case is about to go out of date. These are simply lower value today; leave them until the list above is done.

- The unusual-file cases U-13 to U-16.
- The backend-message cases R-09, R-10, R-12 and R-14.
- The access case J-10.
- The cases marked "only with a key" (see below).

## Only Aaroosh

- **Real Enhance** (cases E-10 to E-13 and E-18). It needs a private key and each press costs money. Everyone else tests Enhance with the stand-in, which is free.

## How to report

Use the two links under [Reporting what you found](README.md#reporting-what-you-found). One opens a filled-in form for a bug, the other for a finished test run. The developer reads those GitHub issues and nothing else, so anything said only in a chat will not reach them.

One bug per issue. Always include the case ID, your computer and browser, the photo (or the sample's name), and a screenshot. Before you report, read "Already known: no need to report" at the top of [PENDING.md](PENDING.md#already-known-no-need-to-report): it was rewritten today.
