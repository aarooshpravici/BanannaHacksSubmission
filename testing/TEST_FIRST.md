# Test this first

Saturday Oct 10, late night update, for version `2b385ef` or later.

The full plan in [TEST_PLAN.md](TEST_PLAN.md) has 197 cases. You do not need to do them all. This page says what helps most right now, in order. The developer rewrites this page after every update, so check its date before you start.

**Who is testing what.** Aaroosh is working through the plan from the **end backwards**: group H, then G, J, Q, D, F and so on. Everyone else: work from the **top** of your share, so that two people do not do the same case. Before each case, look at the table [Cases a person has run](PENDING.md#cases-a-person-has-run) and skip what is listed there for your browser and kind of device. Three cases are wanted from everyone all the same: **W-16** on every device you own, **Q-11** and **G-07**.

**Changed in the late night update (version `2b385ef`), after a tester asked for it.** Get the update before you test: "Getting fixes" in [SETUP.md](SETUP.md#what-to-expect).

- **Your own photo now works with no backend.** The browser downloads a depth model (about 25 MB, once) and works out the photo's shape by itself. Nothing is uploaded. This is on in the hosted demo, in Plan B, and in the normal app when the backend is stopped (a new button, **Analyse in this browser**).
- **Plan B no longer lights an uploaded photo as a round dome.** A tester reported the dome as a bug. It is now only behind a button on a failure card.
- **The demo has the dashed box.** The card "This is the in-browser demo." is gone, and the stage button reads **New photo**, not "Other samples".
- **GEOMETRY says where the shape came from.** For such a photo its first sentence starts "Depth estimated in your browser", and there is a new small line that starts "depth:".
- **You can drag a picture from another web page onto the dashed box**, or paste a picture's address. Some sites allow it. For the others a red bar says why and what to do instead.

**Changed at 9:20 PM before that (versions `378919a` and `53e2c26`), after a tester's run on a real phone.** Get the update before you test: "Getting fixes" in [SETUP.md](SETUP.md#what-to-expect).

- **A phone on the same Wi-Fi can now use the app** by the computer's address (W-16 step 8). Before, the page opened on the phone but nothing reacted to a tap.
- **Back closes the "How it works" panel.** On a phone, where the panel fills the screen, Back used to leave the app.
- **Sweep keeps one steady speed.** It used to move almost twice as fast in its first and last second as in between. Same path, same 6 seconds.
- With the keyboard, the scrolling text of the "How it works" card gets a yellow outline, like every other control; it was the browser's blue one.

**What changed in the night update, before those.**

- **The photo is lit even when the graphics chip cannot be used.** The page now has several ways to draw the lit picture and picks the best one your device can do. If the graphics chip cannot be used, the processor draws the picture, and a **grey note** above the photo says so. The red bar "Live shading is unavailable" that used to appear there is gone in that case; so is the dead end on the demo.
- **The page tells you which way it is using.** Open the **GEOMETRY** panel at the bottom of the sidebar. Its last small grey line is new. It starts with "shading:", for example "shading: graphics chip, full quality". We call it the **shading line**.
- **A "How it works" button** in the top bar, left of the pill. It opens a card that explains the app in five steps and says which parts are our own code.
- **On a phone the pill is shorter**: "online" in place of "backend: online, mock providers", and "demo" on the static demo.
- **The Tab key** now stops on "How it works" after the logo, so every keyboard case needs one more Tab than before.

In the late night update 40 screenshots were retaken and 23 were added (175 in all). If you tested earlier today, get the update first: "Getting fixes" in [SETUP.md](SETUP.md#what-to-expect).

**The quickest way in.** The static demo is online at **https://aarooshpravici.github.io/BanannaHacksSubmission/** and needs nothing at all: open it in a browser, on a computer or a phone. (It was published again on Oct 11 at 1:50 AM and now takes your own photo. If you still see a card in place of the dashed box, reload the page.) If you cannot get the backend installed, do [Plan B in SETUP.md](SETUP.md#plan-b-no-backend-mock-mode): it needs only Node, takes about five minutes, and both the four samples and your own photos work in it. Only two things need the backend: **Enhance** on the normal setup, and detailed normals for your own photo.

## Do these now

1. **Upload your own photo with no backend, on your computer and on your phone.** Do case **H-12** on the hosted demo, https://aarooshpravici.github.io/BanannaHacksSubmission/ . With no address, do **P-10** on your computer in [Plan B](SETUP.md#plan-b-no-backend-mock-mode).
   Choose a photo of your own; a face is best. Then tell us three things, even when it simply works: **how long it took** from choosing the photo to the sun appearing (the first photo, and a second one); **what the GEOMETRY panel says** (copy the small grey line that starts "depth:" and the one that starts "shading:"); and **whether the result looks right** (yes / partly / no, with a screenshot).
   Why this is first: it is new tonight, and it is the first thing a judge will try. It has run only in Chrome on one Mac. No phone, no Windows computer, no Safari and no Firefox has tried it, and a phone has much less memory. If the page reloads by itself, goes blank, or shows a card "This photo could not be analysed", that is the most useful report you can send: copy the card's words.
   Known, so no need to report: a face is a little flatter than on the built-in Portrait sample, with a thin outline round the head (K48). Case **Q-12** asks how much that bothers you.
2. **Open it on every device you own, including your phone, and tell us which shading path it reports and whether the light works.** Do case **W-16**. It takes five minutes a device and needs no backend.
   On each device: click the **Portrait** sample. Open **GEOMETRY** and copy its last grey line, the one that starts "shading:". Copy any grey note or red bar above the photo. Drag the sun and click **Sweep**. Then tell us, even when it simply works: the device, the browser, the shading line, and whether the picture follows the sun at once, follows late, or is wrong.
   Why this matters: the drawing was rebuilt on Saturday night so that it works on weaker devices. So far three devices have reported, all with "graphics chip, full quality" (see [PENDING.md](PENDING.md#confirmed-by-testers)); the other paths have only run with features switched off in Chrome on one Mac. A judge will open the demo on whatever device they have. The table at the top of [group F](TEST_PLAN.md#f-shading-paths) says what each wording of the shading line means. A phone is easiest with a demo address (case **H-10**); without one, W-16 step 8 says how to reach your computer from a phone on the same Wi-Fi (one tester has done this; it needs version `378919a` or later).
3. **Look at the face under side light.** Do case **Q-11**: the **Portrait** sample with **Right**, **Left**, **Top** and a **Sweep**, then the **Cat** sample.
   We still have no human opinion on it. Two questions: is the hard, straight line really gone everywhere, and is the side lighting still strong enough to look lit. Give a score and attach a screenshot if you see any hard line.
4. **Read "How it works" as a newcomer.** Do case **G-07**, then **G-01** and **G-03**.
   Click "How it works" in the top bar and read the card once. Is anything in it unclear? Is anything in it wrong, or different from what you saw the app do? Could you tell which steps are someone else's models and which are our own code? A judge who doubts that we built anything will read this card, so every confusing word matters. On a phone, do **G-05** as well.
5. **Set the app up on a second computer**, following [SETUP.md](SETUP.md) word for word.
   This tests the instructions as much as the app. Nobody has tried them on a second computer, and nobody has tried the Windows steps at all. Write down each step that confused you or failed, how long the model download took, and what computer you have. If the backend will not install, report where it failed, switch to Plan B, and carry on.
6. **Do the 10-minute smoke test** in [README.md](README.md#10-minute-smoke-test). It now includes opening "How it works" and copying the shading line.
7. **The rest of the static demo, if you were given an address.** Do **H-10**, **H-01**, **H-02**, **H-03** and **H-09** on a computer, then **H-05** on a real phone.
   This is what a judge will most likely open. No address? Skip this, or on a Mac build it yourself with [Plan C in SETUP.md](SETUP.md#plan-c-the-static-demo-on-your-own-computer) (case H-08).
8. **If your device does not use the graphics chip**, that is: you see a grey note above the photo, or the shading line does not read "graphics chip, full quality". Then you are the only person who can test that path for real. Do **R-06** and **R-11** (grey note, "processor"), **F-02** ("compatibility mode") or **F-03** ("server renders").
   No such device? You can imitate the processor path in Firefox or Chrome; R-06 says how. It is worth ten minutes, after the items above.
9. **Shadows.** Do S-01, S-06 and S-07, then give your opinion in Q-05 and Q-06.
   Three things are known and still there: a soft darker column on the rocket's sky, a faint cup shadow on the saucer, and a faint dark fringe beside far shadows. We need to know how much they bother you.
10. **Try more of your own photos, and a picture from a web page.** Do case T-09 (it now works in Plan B and on the demo too), then **U-23**: drag a picture from another web site onto the dashed box. Then the picture-quality cases Q-01 to Q-04 and Q-09.
   For anything that looks wrong, send a screenshot and the photo itself.
11. **Open it cold and react.** Do case J-01: sixty seconds with no instructions. Then write what you tried first and what confused you.

## Wait on these

Nothing is being rebuilt right now, so no case is about to go out of date. These are simply lower value today; leave them until the list above is done.

- The unusual-file cases U-13 to U-16, and the rarer address messages in U-25.
- The stand-in dome case R-23 (Plan B only; it is a developer's tool now).
- The backend-message cases R-09, R-10 and R-14.
- The red-bar cases F-04 and H-11. You cannot cause them; do them only if the red bar "Live shading is unavailable" appears by itself.
- The arrow-key case L-12 (a known small oddity).
- The access case J-10.
- The cases marked "only with a key" (see below).

## Only Aaroosh

- **Real Enhance** (cases E-10, E-12, E-13 and E-18). It needs a private key and each press costs money. Everyone else tests Enhance with the stand-in, which is free. Case E-11 is not on this list: it needs no key and costs nothing, so anyone with no `.env` file in the project folder can do it.
- **Keeping the online demo up to date.** It is at https://aarooshpravici.github.io/BanannaHacksSubmission/ and does not update by itself; after an app change, `tools/publish_demo.sh` publishes it again.

## How to report

Use the two links under [Reporting what you found](README.md#reporting-what-you-found). One opens a filled-in form for a bug, the other for a finished test run. The developer reads those GitHub issues and nothing else, so anything said only in a chat will not reach them.

One bug per issue. Always include the case ID, your computer and browser, the photo (or the sample's name), a screenshot, and now also the **shading line**: both forms have a place for it. On the hosted demo, write "demo" where the form asks for the pill, and "hosted demo" with the page address where it asks for the version. Before you report, read "Already known: no need to report" at the top of [PENDING.md](PENDING.md#already-known-no-need-to-report): K48 to K55 were added in the late night update, and K19 was rewritten. Both forms ask for the shading line; the bug form now also asks where the photo's shape came from.
