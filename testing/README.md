# Relight tester kit: start here

**What Relight is.** You upload a photo and drag a small sun icon around it; the highlights and shadows on the photo move with the sun, live. The app works out the 3D shape of the photo once (how far away each part is, and which way each surface faces), then your browser redraws the lighting many times a second. An optional "Enhance" button sends the result to an image model for a more photo-like finish.

**What we ask of you.** Run the app on your own computer, follow the steps in this folder, and write down what you see. You are the only eyes on this: the developer is an AI and cannot look at your screen or read the group chat. It only reads **GitHub issues** (and results files passed on by Aaroosh). It does not read chat. See [Reporting](#reporting-what-you-found).

**The project is due Sunday 11:59 PM EDT.** A bug reported early can be fixed. A bug reported Sunday night cannot.

## How long it takes

| Part | Time |
| --- | --- |
| Setup, once ([SETUP.md](SETUP.md)) | 30 to 60 minutes, mostly waiting for downloads |
| 10-minute smoke test (below) | 10 minutes |
| Your share of the full plan ([TEST_PLAN.md](TEST_PLAN.md)) | about 1.5 hours |
| The whole plan alone | 3.5 to 4 hours |

The plan has **137 test cases** in 14 groups. Some need a key, a touch screen or a second browser; skip those you cannot do and mark them NOT RUN.

If setup fails, that is a result too. Report it (see [Reporting](#reporting-what-you-found)) and try "Plan B" in [SETUP.md](SETUP.md#plan-b-no-backend-mock-mode).

## The files in this folder

| File | What it is for |
| --- | --- |
| [README.md](README.md) | This page, and the 10-minute smoke test |
| [SETUP.md](SETUP.md) | Getting the app running on macOS or Windows, and fixing common problems |
| [TEST_PLAN.md](TEST_PLAN.md) | Every test case, with steps, expected result and a screenshot |
| [PENDING.md](PENDING.md) | Problems that are already known (do not report these), and what the developer could **not** check and most needs you to look at |
| [Reporting what you found](#reporting-what-you-found) (bottom of this page) | The two links for reporting a bug or a finished test run, and how to take a screenshot |
| [results/TEMPLATE.md](results/TEMPLATE.md) | Results form to fill in **only** if you cannot use GitHub |
| [photos/](photos/README.md) | The test photos. Everyone uses the same ones |
| [screenshots/](screenshots/) | What each screen should look like (made on a Mac in Chrome, window 1440 x 900) |

## Splitting the work between three testers

Everyone does the smoke test first. Then pick one share and say which in your report. If nobody has agreed a split, take the share for the order you joined (first tester A, second B, third C).

| Share | Groups in [TEST_PLAN.md](TEST_PLAN.md) |
| --- | --- |
| A | Upload (U), Scene preparation (P), Moving the light (L), Controls (C) |
| B | Shadows (S), Compare (K), Enhance (E), Export (X), Picture quality (Q) |
| C | Layout (W), Kinds of photos (T), Errors (R), Speed (D), What a judge would try (J) |

If you have time left, do the "Picture quality (Q)" group as well. It needs human judgement, and three opinions are better than one.

## Words used in this kit

- **Top-right pill**: the small rounded label in the top-right corner that starts with "backend:". It tells you which mode the app is in.
- **Stage**: the big dark area on the left that holds the photo.
- **Sun**: the round button with a sun icon on the stage. It is the light.
- **Sidebar**: the column on the right with three panels: LIGHT, ENHANCE, GEOMETRY. It scrolls. On a small window GEOMETRY is hidden below the bottom edge: scroll the sidebar down to see it.
- **Backend**: the Python program that studies the photo. **Frontend**: the web page.
- **The round black "N" badge** in the bottom-left corner belongs to the development tool (Next.js), not to our app. Ignore it. Do not report it.

## 10-minute smoke test

Before you start: the app is running as described in [SETUP.md](SETUP.md), and the top-right pill reads **backend: online, mock providers** with an amber dot.

Record PASS or FAIL for each step. Report as one issue with the "finished test run" link in [Reporting](#reporting-what-you-found).

**Where the test photos are.** In your home folder: `BanannaHacksSubmission`, then `testing`, then `photos`. macOS: in the file chooser press Cmd+Shift+H to jump to your home folder. Windows: type `%USERPROFILE%\BanannaHacksSubmission\testing\photos` in the address bar of the file chooser and press Enter. Wherever this kit says `testing/photos/...`, it means that folder.

**Step 1. Open the page.** Go to http://localhost:3000.
Expected: yellow words "MOVE THE LIGHT", the title "Relight a photo by dragging the light.", a dashed box "Drop a photo here", and "Use a sample photo" under it.

![Step 1: first page](screenshots/01-landing.jpg)

**Step 2. Load the portrait.** Click the dashed box and choose `testing/photos/01-portrait-astronaut.jpg`.
Expected: the photo appears dimmed with the words "Estimating depth and surface normals…". After a few seconds (much longer if you skipped the model download in SETUP step 4) it brightens and a white sun appears in the upper left of the photo. The sidebar shows x 0.20, y 0.20.

![Step 2: photo loaded](screenshots/04-scene-default-light.jpg)

**Step 3. Light from the left, then the right.** In the LIGHT panel click **Left**, look, then click **Right**.
Expected after Left: the sun jumps to just left of the photo; the left half of the face is bright and the right half darker. After Right: the opposite.

![Step 3: Left](screenshots/06-preset-left.jpg)
![Step 3: Right](screenshots/07-preset-right.jpg)

**Step 4. Drag the sun.** Press on the sun and drag it slowly in a circle around the face, then out past the right edge of the photo.
Expected: the lighting follows your mouse with no visible delay or stutter. The x and y numbers in the sidebar change as you drag. The sun stops at the edge of the stage. With x above 1 the right side of the face is bright.

![Step 4: sun outside the photo](screenshots/13-drag-outside-photo.jpg)

**Step 5. Shadows on an object.** Click **New photo** (top right of the stage). Choose `testing/photos/02-object-coffee.jpg`. Click **Left**. Drag the **Height** slider left to about 0.10. Then click the **Cast shadows** switch off and on again.
Expected with the switch on (yellow): a wide dark shadow to the right of the cup. With it off (grey): that shadow disappears and the right of the saucer gets lighter.

![Step 5: shadows on](screenshots/23-shadows-on.jpg)
![Step 5: shadows off](screenshots/24-shadows-off.jpg)

**Step 6. Compare with the original.** Press and hold **Hold to see original** under the photo, then let go.
Expected: while held, the plain photo shows, with a small tag "Original" in its top-left corner. On release the relit photo comes back.

![Step 6: original shown](screenshots/27-hold-original.jpg)

**Step 7. Enhance.** Scroll the sidebar to the ENHANCE panel and click the yellow **Enhance** button.
Expected: the button reads "Enhancing…"; within a few seconds the stage shows a split picture with a white vertical line, "Live preview" on the left and "Enhanced" on the right. Drag the round handle on the line left and right: the line follows. (In this mode both halves look almost the same. That is expected: Enhance is a stand-in until a key is added.)

![Step 7: Enhance finished](screenshots/30-enhance-done.jpg)

**Step 8. Export.** Click the **Live preview** tab (top left of the stage), then **Export PNG** under the photo.
Expected: a file named `relit.png` is downloaded. Open it: it shows the photo with the lighting you saw, and **no** sun icon on it.

Done. Now write it up as described in the next section.

---

## Reporting what you found

**The developer reads GitHub issues, not chat.** The developer is an AI coding assistant working with Aaroosh. It cannot see the group chat, texts, calls or anything said out loud. If a problem is not in a GitHub issue, the developer will not see it and it will not be fixed. (The only other way in is a results file sent to Aaroosh, described at the end of this section.)

Write things up early. Do not save everything for the end. Before you report, look at "Already known: no need to report" at the top of [PENDING.md](PENDING.md#already-known-no-need-to-report).

### The normal way: a GitHub issue

1. Sign in at https://github.com in any browser. A free account is enough.
2. Click one of these two links. Each opens a new issue in our repository with every heading already written for you:
   - **[Report a bug](https://github.com/aarooshpravici/BanannaHacksSubmission/issues/new?title=%5BCASE-ID%5D%20BLOCKER%20%2F%20WRONG%20%2F%20UGLY%20%2F%20IDEA%3A%20short%20description&body=%3C%21--%20Never%20paste%20a%20key%2C%20a%20password%20or%20the%20contents%20of%20a%20.env%20file.%20This%20repository%20is%20public.%20--%3E%0A%0A%2A%2ATest%20case%20ID%2A%2A%20%28from%20testing%2FTEST_PLAN.md%2C%20or%20%22none%22%29%3A%0A%0A%2A%2AVersion%2A%2A%20%28run%20%60git%20log%20-1%20--format%3D%25h%60%20in%20the%20project%20folder%29%3A%0A%0A%2A%2AComputer%2A%2A%20%28model%2C%20macOS%20or%20Windows%20version%2C%20Apple%20chip%20%2F%20NVIDIA%20card%20%2F%20neither%29%3A%0A%0A%2A%2ABrowser%20and%20version%3A%2A%2A%0A%0A%2A%2ATop-right%20pill%20reads%2A%2A%20%28mock%20%2F%20online%2C%20mock%20providers%20%2F%20online%20%2F%20offline%29%3A%0A%0A%2A%2APhoto%20used%2A%2A%20%28file%20name%20from%20testing%2Fphotos%2C%20or%20describe%20your%20own%29%3A%0A%0A%2A%2ALight%20readout%2A%2A%20%28x%2C%20y%2C%20Height%2C%20Intensity%2C%20Ambient%2C%20Colour%2C%20Cast%20shadows%20on%20or%20off%2C%20Detailed%20normals%20on%20or%20off%29%3A%0A%0A%23%23%20Steps%0A%0A1.%0A2.%0A3.%0A%0A%23%23%20What%20happened%0A%0A%3C%21--%20Copy%20the%20exact%20words%20of%20any%20red%20message.%20--%3E%0A%0A%23%23%20What%20I%20expected%0A%0A%23%23%20Screenshot%0A%0A%3C%21--%20Click%20here%20and%20paste%20%28Cmd%2BV%20or%20Ctrl%2BV%29.%20Show%20the%20whole%20browser%20window.%20--%3E%0A%0A%23%23%20Extra%2C%20if%20something%20failed%20outright%0A%0A%3C%21--%20Last%2020%20lines%20of%20the%20backend%20terminal.%20Red%20lines%20from%20the%20browser%20console%20%28F12%2C%20Console%29.%20--%3E%0A%0A%2A%2ADoes%20it%20happen%20every%20time%3F%2A%2A%20%28yes%20%2F%20sometimes%20%2F%20once%29%0A&labels=bug)**. One thing that went wrong. **One issue per bug.**
   - **[Report a finished test run](https://github.com/aarooshpravici/BanannaHacksSubmission/issues/new?title=Test%20result%3A%20YOUR%20NAME%2C%20share%20A%20%2F%20B%20%2F%20C%20%2F%20smoke%20test%2C%20DATE&body=%3C%21--%20Never%20paste%20a%20key%2C%20a%20password%20or%20the%20contents%20of%20a%20.env%20file.%20This%20repository%20is%20public.%20--%3E%0A%0A%2A%2ATester%3A%2A%2A%0A%0A%2A%2ADate%20and%20time%3A%2A%2A%0A%0A%2A%2AVersion%2A%2A%20%28run%20%60git%20log%20-1%20--format%3D%25h%60%20in%20the%20project%20folder%29%3A%0A%0A%2A%2AComputer%2A%2A%20%28model%2C%20macOS%20or%20Windows%20version%2C%20Apple%20chip%20%2F%20NVIDIA%20card%20%2F%20neither%29%3A%0A%0A%2A%2ABrowser%20and%20version%3A%2A%2A%0A%0A%2A%2ATop-right%20pill%20reads%2A%2A%20%28mock%20%2F%20online%2C%20mock%20providers%20%2F%20online%29%3A%0A%0A%2A%2AWhat%20I%20ran%2A%2A%20%28smoke%20test%20%2F%20share%20A%20%2F%20share%20B%20%2F%20share%20C%20%2F%20other%29%3A%0A%0A%23%23%20Setup%0A%0A-%20Did%20SETUP.md%20work%20as%20written%3F%20%28yes%20%2F%20no%2C%20and%20what%20you%20had%20to%20change%29%3A%0A-%20Minutes%20for%20the%20model%20download%20%28SETUP%20step%204%29%3A%0A-%20Seconds%20per%20photo%20after%20that%20%28case%20D-01%29%3A%0A%0A%23%23%20Smoke%20test%20%28testing%2FREADME.md%29%0A%0AWrite%20PASS%20or%20FAIL%20after%20each.%0A%0A-%20Step%201%20Open%20the%20page%3A%0A-%20Step%202%20Load%20the%20portrait%3A%0A-%20Step%203%20Left%2C%20then%20Right%3A%0A-%20Step%204%20Drag%20the%20sun%3A%0A-%20Step%205%20Shadows%20on%20an%20object%3A%0A-%20Step%206%20Compare%20with%20the%20original%3A%0A-%20Step%207%20Enhance%3A%0A-%20Step%208%20Export%3A%0A%0A%23%23%20Test%20plan%20cases%20%28testing%2FTEST_PLAN.md%29%0A%0AOne%20line%20per%20case%20you%20ran%3A%20%60ID%20%20PASS%20%2F%20FAIL%20%2F%20NOT%20RUN%20%20note%60.%20For%20every%20FAIL%2C%20open%20a%20separate%20%22Bug%20report%22%20issue%20and%20put%20its%20number%20in%20the%20note.%0A%0A%60%60%60%0AU-01%0AU-02%0A%60%60%60%0A%0A%23%23%20Picture%20quality%20scores%20%28group%20Q%29%2C%201%20%3D%20fake%2C%205%20%3D%20like%20a%20real%20photo%0A%0A%60%60%60%0AQ-01%0AQ-02%0AQ-03%0A%60%60%60%0A%0A%23%23%20Items%20from%20testing%2FPENDING.md%20that%20I%20checked%0A%0A%23%23%20The%20three%20worst%20things%20I%20saw%0A%0A1.%0A2.%0A3.%0A%0A%23%23%20The%20best%20thing%20to%20show%20a%20judge%0A%0A%23%23%20Screenshots%0A%0A%3C%21--%20Paste%20here%20%28Cmd%2BV%20or%20Ctrl%2BV%29.%20--%3E%0A)**. Your PASS / FAIL list after a test session.
3. Change the title at the top: replace the words in capitals with your own.
4. Fill in every heading. Paste screenshots straight into the text box (click in the box, press Cmd+V or Ctrl+V).
5. Click **Create** (it may read **Submit new issue**).

Do not use the green **New issue** button on the GitHub site. It will most likely show an empty form with no headings. Use the two links above.

If a link opens an empty form anyway (some apps cut long links short): keep the form open, open [bug-report.md](../.github/ISSUE_TEMPLATE/bug-report.md) or [test-result.md](../.github/ISSUE_TEMPLATE/test-result.md) in another tab, click **Raw**, and copy everything below the second `---` line into the form.

### What every bug issue needs

| Item | Example |
| --- | --- |
| Test case ID | `S-01` (or "none" if you found it by accident) |
| Version | the code printed by `git log -1 --format=%h`, for example `887bda5` |
| Computer | "MacBook Air M2, macOS 15" or "Dell XPS, Windows 11, no NVIDIA card" |
| Browser and version | "Chrome 141" (Chrome menu, Help, About Google Chrome) |
| Top-right pill | "online, mock providers" |
| Photo used | `02-object-coffee.jpg`, or "my own: a selfie, 3024 x 4032" |
| Steps | numbered, exactly what you clicked |
| What happened | what you saw, including the exact words of any red message |
| What you expected | usually the "Expected" text of the test case |
| Screenshot | of the whole browser window |
| Light readout | the x, y and slider values, if the bug is about how the picture looks |

Useful extras when something fails outright:

- **The backend terminal**: copy the last 20 lines.
- **The browser console**: press F12 (macOS: Cmd+Option+I), click **Console**, and copy any red lines.

**Never** include the contents of a `.env` file or anything that looks like a key or password. If a screenshot shows one, crop it out.

Only attach photos you are happy for the public to see. The repository is public.

### How serious is it? Put one of these words in the title

- **BLOCKER**: cannot install, cannot start, or the main thing (drag the light, see the picture change) does not work.
- **WRONG**: works, but does the wrong thing or looks clearly wrong.
- **UGLY**: works, but looks bad or confuses.
- **IDEA**: a suggestion.

Example title: `[S-01] WRONG: shadow stays after Cast shadows is switched off (Windows, Edge)`.

### Taking a screenshot

**macOS**

- Part of the screen: Shift+Cmd+4, then drag a box. The picture is saved on the Desktop.
- One window: Shift+Cmd+4, then Space, then click the window.
- Straight to the clipboard (to paste into an issue): add Ctrl, so Ctrl+Shift+Cmd+4.
- A short video (useful for stutter or flicker): Shift+Cmd+5, choose "Record Selected Portion", click Record; stop with the square button in the menu bar. Drag the video file into the issue.

**Windows**

- Part of the screen: Windows key+Shift+S, then drag a box. The picture goes to the clipboard: click in the issue text box and press Ctrl+V.
- Whole screen saved as a file: Windows key+PrtScn. It is saved in Pictures, Screenshots.
- A short video: Windows key+Shift+R (Snipping Tool, Windows 11), or Windows key+G for the Game Bar.

Capture the **whole browser window**, including the top-right pill and the sidebar. The numbers in the sidebar tell the developer where the light was.

### If you cannot use GitHub

Use this only if you really cannot open a GitHub issue. It is slower: the developer sees nothing until Aaroosh passes your file on.

1. Copy the file [results/TEMPLATE.md](results/TEMPLATE.md) **to your Desktop** and name the copy `results-YOURNAME-DATE.md` (for example `results-sam-oct10.md`). Do not keep it inside the project folder: a later update of the project could get in its way. Any text editor will do: TextEdit, Notepad.
2. Fill it in.
3. Put your screenshots in a folder next to it, also on the Desktop, named `screenshots-YOURNAME`.
4. Send the file and the folder to **Aaroosh** by whatever way you normally reach him. He will pass it to the developer.

### What happens next

The developer reads new GitHub issues, fixes what it can, and answers in the issue with what changed and which test cases to run again. It does not answer in chat. Check your issues for replies. To get a fix, follow "Getting fixes" in [SETUP.md](SETUP.md#what-to-expect).
