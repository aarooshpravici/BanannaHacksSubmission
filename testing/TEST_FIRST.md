# Test this first

Saturday Oct 10, 9:20 PM, for version `53e2c26` or later.

The full plan in [TEST_PLAN.md](TEST_PLAN.md) has 186 cases. You do not need to do them all. This page says what helps most right now, in order. The developer rewrites this page after every update, so check its date before you start.

**Who is testing what.** Aaroosh is working through the plan from the **end backwards**: group H, then G, J, Q, D, F and so on. Everyone else: work from the **top** of your share, so that two people do not do the same case. Before each case, look at the table [Cases a person has run](PENDING.md#cases-a-person-has-run) and skip what is listed there for your browser and kind of device. Three cases are wanted from everyone all the same: **W-16** on every device you own, **Q-11** and **G-07**.

**Changed at 9:20 PM (versions `378919a` and `53e2c26`), after a tester's run on a real phone.** Get the update before you test: "Getting fixes" in [SETUP.md](SETUP.md#what-to-expect).

- **A phone on the same Wi-Fi can now use the app** by the computer's address (W-16 step 8). Before, the page opened on the phone but nothing reacted to a tap.
- **Back closes the "How it works" panel.** On a phone, where the panel fills the screen, Back used to leave the app.
- **Sweep keeps one steady speed.** It used to move almost twice as fast in its first and last second as in between. Same path, same 6 seconds.
- With the keyboard, the scrolling text of the "How it works" card gets a yellow outline, like every other control; it was the browser's blue one.

**What changed in the night update, before that.**

- **The photo is lit even when the graphics chip cannot be used.** The page now has several ways to draw the lit picture and picks the best one your device can do. If the graphics chip cannot be used, the processor draws the picture, and a **grey note** above the photo says so. The red bar "Live shading is unavailable" that used to appear there is gone in that case; so is the dead end on the demo.
- **The page tells you which way it is using.** Open the **GEOMETRY** panel at the bottom of the sidebar. Its last small grey line is new. It starts with "shading:", for example "shading: graphics chip, full quality". We call it the **shading line**.
- **A "How it works" button** in the top bar, left of the pill. It opens a card that explains the app in five steps and says which parts are our own code.
- **On a phone the pill is shorter**: "online" in place of "backend: online, mock providers", and "demo" on the static demo.
- **The Tab key** now stops on "How it works" after the logo, so every keyboard case needs one more Tab than before.

All 103 screenshots were retaken tonight and 49 were added (152). If you tested earlier today, get the update first: "Getting fixes" in [SETUP.md](SETUP.md#what-to-expect).

**The quickest way in.** If Aaroosh has given you a demo address, that needs nothing at all: open it in a browser, on a computer or a phone. If you cannot get the backend installed, do [Plan B in SETUP.md](SETUP.md#plan-b-no-backend-mock-mode): it needs only Node, takes about five minutes, and the four samples work fully in it. Only three things need the backend: uploading your own photo, **Enhance** on the normal setup, and turning **Detailed normals** off.

## Do these now

1. **Open it on every device you own, including your phone, and tell us which shading path it reports and whether the light works.** Do case **W-16**. It takes five minutes a device and needs no backend.
   On each device: click the **Portrait** sample. Open **GEOMETRY** and copy its last grey line, the one that starts "shading:". Copy any grey note or red bar above the photo. Drag the sun and click **Sweep**. Then tell us, even when it simply works: the device, the browser, the shading line, and whether the picture follows the sun at once, follows late, or is wrong.
   Why this is first: the drawing was rebuilt tonight so that it works on weaker devices, but it was tested only by switching features off in Chrome on one Mac. No real phone, no older laptop, no Windows computer, no Firefox and no Safari has run it. A judge will open the demo on whatever device they have. The table at the top of [group F](TEST_PLAN.md#f-shading-paths) says what each wording of the shading line means. A phone is easiest with a demo address (case **H-10**); without one, W-16 step 8 says how to reach your computer from a phone on the same Wi-Fi (one tester has done this; it needs version `378919a` or later).
2. **Look at the face under side light.** Do case **Q-11**: the **Portrait** sample with **Right**, **Left**, **Top** and a **Sweep**, then the **Cat** sample.
   We still have no human opinion on it. Two questions: is the hard, straight line really gone everywhere, and is the side lighting still strong enough to look lit. Give a score and attach a screenshot if you see any hard line.
3. **Read "How it works" as a newcomer.** Do case **G-07**, then **G-01** and **G-03**.
   Click "How it works" in the top bar and read the card once. Is anything in it unclear? Is anything in it wrong, or different from what you saw the app do? Could you tell which steps are someone else's models and which are our own code? A judge who doubts that we built anything will read this card, so every confusing word matters. On a phone, do **G-05** as well.
4. **Set the app up on a second computer**, following [SETUP.md](SETUP.md) word for word.
   This tests the instructions as much as the app. Nobody has tried them on a second computer, and nobody has tried the Windows steps at all. Write down each step that confused you or failed, how long the model download took, and what computer you have. If the backend will not install, report where it failed, switch to Plan B, and carry on.
5. **Do the 10-minute smoke test** in [README.md](README.md#10-minute-smoke-test). It now includes opening "How it works" and copying the shading line.
6. **The static demo, if you were given an address.** Do **H-10**, **H-01**, **H-03** and **H-09** on a computer, then **H-05** on a real phone.
   This is what a judge will most likely open. It has never been opened from a real web host or on a real phone. No address? Skip this, or on a Mac build it yourself with [Plan C in SETUP.md](SETUP.md#plan-c-the-static-demo-on-your-own-computer) (case H-08).
7. **If your device does not use the graphics chip**, that is: you see a grey note above the photo, or the shading line does not read "graphics chip, full quality". Then you are the only person who can test that path for real. Do **R-06** and **R-11** (grey note, "processor"), **F-02** ("compatibility mode") or **F-03** ("server renders").
   No such device? You can imitate the processor path in Firefox or Chrome; R-06 says how. It is worth ten minutes, after the items above.
8. **Shadows.** Do S-01, S-06 and S-07, then give your opinion in Q-05 and Q-06.
   Three things are known and still there: a soft darker column on the rocket's sky, a faint cup shadow on the saucer, and a faint dark fringe beside far shadows. We need to know how much they bother you.
9. **Try your own photos.** Do case T-09, then the picture-quality cases Q-01 to Q-04 and Q-09.
   For anything that looks wrong, send a screenshot and the photo itself.
10. **Open it cold and react.** Do case J-01: sixty seconds with no instructions. Then write what you tried first and what confused you.

## Wait on these

Nothing is being rebuilt right now, so no case is about to go out of date. These are simply lower value today; leave them until the list above is done.

- The unusual-file cases U-13 to U-16.
- The backend-message cases R-09, R-10 and R-14.
- The red-bar cases F-04 and H-11. You cannot cause them; do them only if the red bar "Live shading is unavailable" appears by itself.
- The arrow-key case L-12 (a known small oddity).
- The access case J-10.
- The cases marked "only with a key" (see below).

## Only Aaroosh

- **Real Enhance** (cases E-10, E-12, E-13 and E-18). It needs a private key and each press costs money. Everyone else tests Enhance with the stand-in, which is free. Case E-11 is not on this list: it needs no key and costs nothing, so anyone with no `.env` file in the project folder can do it.
- **Putting the static demo online** and telling the testers its address.

## How to report

Use the two links under [Reporting what you found](README.md#reporting-what-you-found). One opens a filled-in form for a bug, the other for a finished test run. The developer reads those GitHub issues and nothing else, so anything said only in a chat will not reach them.

One bug per issue. Always include the case ID, your computer and browser, the photo (or the sample's name), a screenshot, and now also the **shading line**: both forms have a place for it. On the hosted demo, write "demo" where the form asks for the pill, and "hosted demo" with the page address where it asks for the version. Before you report, read "Already known: no need to report" at the top of [PENDING.md](PENDING.md#already-known-no-need-to-report): K39, K40 and K43 to K47 were added tonight.
