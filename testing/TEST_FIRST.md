# Test this first

Updated Saturday Oct 10, 2:20 PM Central, for version `a97cde1`.

The full plan in [TEST_PLAN.md](TEST_PLAN.md) has 137 cases. You do not need to do them all today. This page says what helps most right now, in order. The developer rewrites this page after every update, so check its date before you start.

## Do these now

They stay valid after the next update, so nothing here is wasted effort.

1. **Set the app up on your own computer**, following [SETUP.md](SETUP.md) word for word.
   This tests the instructions as much as the app. Nobody has tried them on a second computer, and nobody has tried the Windows steps at all. Write down each step that confused you or failed, how long the model download took, and what computer you have.
2. **Do the 10-minute smoke test** in [README.md](README.md#10-minute-smoke-test).
3. **Try your own photos.** Do case T-09, then the picture-quality cases Q-01, Q-02, Q-03, Q-04, Q-07 and Q-09.
   Use a few different kinds: a face, a pet, an object on a table, a room, something outdoors. The question is simple: does it look like the light really moved, and where does it look fake? For anything that looks wrong, send a screenshot and the photo itself.
4. **Open it cold and react.** Do case J-01: sixty seconds with no instructions. Then write what you tried first, what confused you, and what you expected to happen that did not.
5. **Try a second browser** if you have one (case W-09): Safari, Firefox or Edge.

## Wait on these

An update is being built right now that changes them. If you test them today, you will be testing something that is about to be replaced.

- The **Shadows** group (S) and the two known weak spots, Q-05 and Q-06. Shadows are being rewritten to be softer.
- The **Layout** cases W-01 to W-04. The sidebar and the phone layout are being reworked.
- The **Use a sample photo** button. It is being replaced by four real sample photos.
- Case L-01, the look of the light when a photo first loads. The starting position is changing.

When the update is in, this page will list those as the things to test next, and the screenshots will be retaken to match.

## Only Aaroosh

- **Real Enhance** (cases E-10 to E-13 and E-18). It needs a private key and each press costs money. Everyone else tests Enhance with the stand-in, which is free.

## How to report

Use the two links under [Reporting what you found](README.md#reporting-what-you-found). One opens a filled-in form for a bug, the other for a finished test run. The developer reads those GitHub issues and nothing else, so anything said only in a chat will not reach them.

One bug per issue. Always include the case ID, your computer and browser, the photo, and a screenshot.
