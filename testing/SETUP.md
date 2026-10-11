# Setup: getting Relight running

Follow the part for your computer: [macOS](#macos) or [Windows](#windows). Then read [What to expect](#what-to-expect) and, if something goes wrong, [Troubleshooting](#troubleshooting).

You will keep **two terminal windows** open the whole time: one runs the backend (Python), one runs the frontend (the web page). A terminal is the app where you type commands: "Terminal" on macOS, "PowerShell" on Windows.

You need about **12 GB of free disk space** and a good internet connection for the first run.

**In a hurry, or the backend will not install?** Go to [Plan B](#plan-b-no-backend-mock-mode). It needs only git and Node, takes about five minutes, and lets you test most of the app, with the four built-in sample photos and with your own.

**Were you given a demo address?** The static demo needs no setup: open the address in any browser and go to group H in [TEST_PLAN.md](TEST_PLAN.md#h-hosted-demo-static-build). The demo takes your own photo too. It is not a replacement for this page: only the setup below can run Enhance or give a photo of yours detailed normals.

> Honest note: the developer built and ran the app on one Apple-chip Mac, using Chrome. The Windows commands below were written carefully but **have not been run on a Windows computer**. If a command fails, copy the error text into an issue ([Reporting](README.md#reporting-what-you-found)). That is a useful result.

---

## macOS

### 1. Install the three tools

Open **Terminal** (press Cmd+Space, type `Terminal`, press Return). Check what you already have:

```bash
git --version
python3.12 --version
node --version
```

| Tool | Good answer | If you get "command not found" or a lower number |
| --- | --- | --- |
| git | `git version 2.` anything | Running `git --version` opens a window offering "command line developer tools". Click Install, wait, try again. |
| Python | `Python 3.12.` anything | Open https://www.python.org/downloads/release/python-31210/ , scroll to Files, download **macOS 64-bit universal2 installer** and run it. Do not use the big yellow Download button on python.org: it gives a newer version that will not work here. Close and reopen Terminal. |
| Node | `v22.` or higher | Download the **LTS** installer from https://nodejs.org and run it. Close and reopen Terminal. |

Python must be 3.12. Version 3.13 or newer may fail to install the libraries.

**Check your chip.** Click the Apple menu (top-left corner), then **About This Mac**. If the "Chip" or "Processor" line says **Intel**, the backend may not install: one of its libraries (PyTorch) stopped making new versions for Intel Macs. This is a likely problem, not a certain one; nobody has tried it. Try the steps once. If step 3, step 4 or the first photo fails, copy the error into an issue ([Reporting](README.md#reporting-what-you-found)) and use [Plan B](#plan-b-no-backend-mock-mode). If it says **Apple M1** (or M2, M3, M4), carry on.

### 2. Get the code

```bash
cd ~
git clone https://github.com/aarooshpravici/BanannaHacksSubmission.git
cd BanannaHacksSubmission
git checkout relight
```

The last line should answer `Switched to a new branch 'relight'` or `Already on 'relight'`. We put the folder in your home folder (`~`), not on the Desktop, to avoid a macOS permission prompt.

**If the answer is `error: pathspec 'relight' did not match any file(s) known to git`:** the `relight` branch is not uploaded to GitHub yet. Stop here. Do not continue on the branch you are on: it holds an older app and has no `testing` folder. Tell Aaroosh that the branch is missing, and wait. When he says it is uploaded, run `git fetch origin` and then `git checkout relight` again.

Check that you have the right code:

```bash
ls testing
```

You should see `README.md`, `SETUP.md` and `TEST_PLAN.md` in the list. If you get `No such file or directory`, you are on the wrong branch: read the paragraph above.

### 3. Install the backend (once)

```bash
cd ~/BanannaHacksSubmission/backend
python3.12 -m venv .venv
.venv/bin/python -m pip install --upgrade pip
.venv/bin/python -m pip install -r requirements.txt
```

The last command downloads a few gigabytes and takes 5 to 15 minutes. It ends with a line starting `Successfully installed`.

### 4. Download the models (once)

The backend needs two models (programs that estimate shape from a picture). Together they are several gigabytes. Download them now, where you can see the progress:

```bash
cd ~/BanannaHacksSubmission/backend
MOCK_MODE=1 .venv/bin/python -c "from app.ideas import relight as R; R._depth_model(); R._normals_model(); print('models ready')"
```

Progress bars appear in the terminal. On home internet this takes **10 to 30 minutes or more**. The last line must be exactly:

```
models ready
```

Write down how many minutes it took. If it stops with an error instead, run the same command again: it continues where it stopped. If it fails twice, copy the last 20 lines into an issue. If you run the command again later, it prints `models ready` within about a minute and downloads nothing.

### 5. Start the backend (terminal 1)

```bash
cd ~/BanannaHacksSubmission/backend
MOCK_MODE=1 .venv/bin/python -m uvicorn app.main:app --port 8000
```

Wait for the line `Uvicorn running on http://127.0.0.1:8000`. Leave this window open.

### 6. Start the frontend (terminal 2)

Open a second Terminal window (Cmd+N):

```bash
cd ~/BanannaHacksSubmission/frontend
npm ci
NEXT_PUBLIC_MOCK=0 NEXT_PUBLIC_API_URL=http://localhost:8000 npm run dev
```

`npm ci` is only needed the first time, and again after each `git pull`. It installs exactly the versions the project lists and changes no project file. Wait for a line like `Local: http://localhost:3000`. Leave this window open.

### 7. Open the page

Open **Google Chrome** and go to http://localhost:3000. Then go to [Check that it works](#check-that-it-works).

---

## Windows

### 1. Install the three tools

Open **PowerShell** (press the Windows key, type `PowerShell`, press Enter). Check what you already have:

```powershell
git --version
py -3.12 --version
node --version
```

| Tool | Good answer | If you get an error or a lower number |
| --- | --- | --- |
| git | `git version 2.` anything | Install from https://git-scm.com/download/win. Accept every default. Close and reopen PowerShell. |
| Python | `Python 3.12.` anything | Open https://www.python.org/downloads/release/python-31210/ , scroll to Files, download **Windows installer (64-bit)**, run it and accept the defaults. Do not use the big yellow Download button on python.org: it gives a newer version that will not work here. Close and reopen PowerShell. |
| Node | `v22.` or higher | Download the **LTS** installer from https://nodejs.org and run it. Close and reopen PowerShell. |

Python must be 3.12. Version 3.13 or newer may fail to install the libraries.

### 2. Get the code

```powershell
cd $HOME
git clone https://github.com/aarooshpravici/BanannaHacksSubmission.git
cd BanannaHacksSubmission
git checkout relight
```

The last line should answer `Switched to a new branch 'relight'` or `Already on 'relight'`.

**If the answer is `error: pathspec 'relight' did not match any file(s) known to git`:** the `relight` branch is not uploaded to GitHub yet. Stop here. Do not continue on the branch you are on: it holds an older app and has no `testing` folder. Tell Aaroosh that the branch is missing, and wait. When he says it is uploaded, run `git fetch origin` and then `git checkout relight` again.

Check that you have the right code:

```powershell
dir testing
```

You should see `README.md`, `SETUP.md` and `TEST_PLAN.md` in the list. If you get an error saying the path does not exist, you are on the wrong branch: read the paragraph above.

### 3. Install the backend (once)

```powershell
cd $HOME\BanannaHacksSubmission\backend
py -3.12 -m venv .venv
.venv\Scripts\python.exe -m pip install --upgrade pip
.venv\Scripts\python.exe -m pip install -r requirements.txt
```

The last command downloads a few gigabytes and takes 5 to 15 minutes. It ends with a line starting `Successfully installed`.

### 4. Download the models (once)

The backend needs two models (programs that estimate shape from a picture). Together they are several gigabytes. Download them now, where you can see the progress:

```powershell
cd $HOME\BanannaHacksSubmission\backend
$env:MOCK_MODE = "1"
.venv\Scripts\python.exe -c "from app.ideas import relight as R; R._depth_model(); R._normals_model(); print('models ready')"
```

Progress bars appear in the window. On home internet this takes **10 to 30 minutes or more**. The last line must be exactly:

```
models ready
```

Write down how many minutes it took. If it stops with an error instead, run the last command again: it continues where it stopped. If it fails twice, copy the last 20 lines into an issue. If you run the command again later, it prints `models ready` within about a minute and downloads nothing.

### 5. Start the backend (PowerShell window 1)

```powershell
cd $HOME\BanannaHacksSubmission\backend
$env:MOCK_MODE = "1"
.venv\Scripts\python.exe -m uvicorn app.main:app --port 8000
```

Wait for the line `Uvicorn running on http://127.0.0.1:8000`. Leave this window open. If Windows shows a firewall question about Python, you can click Cancel: the app only talks to your own computer.

### 6. Start the frontend (PowerShell window 2)

Open a second PowerShell window:

```powershell
cd $HOME\BanannaHacksSubmission\frontend
npm.cmd ci
$env:NEXT_PUBLIC_MOCK = "0"
$env:NEXT_PUBLIC_API_URL = "http://localhost:8000"
npm.cmd run dev
```

On Windows type `npm.cmd`, not `npm`. In PowerShell plain `npm` can stop with "running scripts is disabled on this system"; `npm.cmd` is the same program and always works. (Found by a tester on Windows 11.)

`npm.cmd ci` is only needed the first time, and again after each `git pull`. It installs exactly the versions the project lists and changes no project file. Wait for a line like `Local: http://localhost:3000`. Leave this window open.

If `npm` answers "running scripts is disabled on this system", type `npm.cmd` instead of `npm` in both commands.

### 7. Open the page

Open **Google Chrome** (or Edge) and go to http://localhost:3000.

---

## Check that it works

Look at the top-right pill.

| Pill | Meaning | What to do |
| --- | --- | --- |
| amber dot, **backend: online, mock providers** | Correct. Everything is real except Enhance, which is a stand-in. | Start testing. |
| red dot, **backend: offline** | The page cannot find the backend. The four sample photos still work. A photo you upload gets a card with the button **Analyse in this browser**, which works without the backend (case R-22). Enhance and detailed normals do not work. | See [Troubleshooting](#the-pill-says-backend-offline). |
| yellow dot, **backend: mock** | The frontend was started without the two `NEXT_PUBLIC_` settings, so it is not using the backend at all. This is [Plan B](#plan-b-no-backend-mock-mode). | If you meant to use the backend: stop the frontend (Ctrl+C) and start it again with the full command from step 6. |
| green dot, **backend: online** | The backend is running with real Enhance switched on. | Fine only if you meant to. See [Real Enhance](#enhance-mock_mode-and-keys). |
| green dot, **demo: runs in your browser** | This is the static demo, not the app you set up here. It has the four samples and takes your own photo; Enhance is off. | Fine if you opened a demo address or did [Plan C](#plan-c-the-static-demo-on-your-own-computer). If you see it at http://localhost:3000, report it. |

![Correct pill](screenshots/49-status-online-mock-providers.jpg)

On a window narrower than 640 pixels (a phone) the pill is shorter: no "backend:" or "demo:" in front, "online, mock providers" reads just "online", and the demo's pill reads just "demo". Left of the pill, at every width, are the words **How it works**; they open a card that explains the app.

**A ten-second check.** Click the **Portrait** picture under "Or try a sample photo:". The astronaut should open at once with the left of the face bright and the right cheek in shadow. The shadow side fades in softly, with no hard, straight line across the face. Drag the round sun button: the lighting should follow. Then click the **GEOMETRY** row at the bottom of the sidebar and read its last small grey line. On most computers it reads "shading: graphics chip, full quality". Whatever it reads, write it down: test case W-16 in [TEST_PLAN.md](TEST_PLAN.md) asks for it, for every device you own. If the photo does not react, or a red bar appears, report it (W-16 again). A **grey** note above the photo is not an error: see [Troubleshooting](#a-grey-note-says-shading-on-this-devices-processor).

Now do the smoke test in [README.md](README.md#10-minute-smoke-test).

## What to expect

**The models are downloaded in step 4.** They are saved in a folder named `.cache/huggingface` in your home folder (the developer measured about 6 GB in total on disk), so the download happens only once.

**If you skipped step 4, the first photo is very slow, once.** The backend then downloads the models while the page waits. The page only shows "Estimating depth and surface normals…" with no progress bar, for 10 to 30 minutes or more. **This is not a freeze.** Terminal 1 shows the download progress bars. The browser may give up waiting before the download ends (Firefox does after about 5 minutes) and show a card on the photo: "This photo could not be analysed", "Cannot reach the backend at http://localhost:8000. Is it running?". The backend is still downloading. Wait until the progress bars in terminal 1 finish, then click **Retry** on the card. Better: stop, and do step 4.

**After that, how long a photo should take** (from choosing the file to the sun appearing):

| Your computer | Expected | Report it as a problem if |
| --- | --- | --- |
| Mac with an Apple chip (M1 or newer) | About 7 seconds for the first photo after starting the backend, then 1.5 to 2.5 seconds (measured) | Regularly over 10 seconds |
| Windows or Linux with an NVIDIA graphics card set up for PyTorch | Not measured. Probably similar to the Mac | Over 15 seconds |
| Most Windows laptops (no NVIDIA card). The backend then uses only the processor (CPU) | **Not measured.** Could be 10 to 60 seconds per photo. Up to 60 seconds is acceptable for testing | Over 2 minutes, or it never finishes |
| Intel Mac | **Not measured, and the backend may not install at all** (see the "Check your chip" note in macOS step 1). If it does install: as the row above | It does not install, or the first photo fails. Report the error text |

On Windows, the install above normally gives a processor-only setup even if you have a graphics card. That is fine for testing.

**If photos are slow, turn the Detailed normals switch off.** The switch is inside the GEOMETRY panel at the bottom of the sidebar. The panel starts folded into one row: click the row to open it. It only appears after you have chosen a photo, and the switch starts **on**, so on a slow computer the first photo always begins with the slow model. The switch works even while "Estimating depth and surface normals…" is showing (it is the one control that is not locked then). On a slow computer: choose a photo, click the GEOMETRY row at once, and click **Detailed normals** off. The photo starts loading again without the slow model and should be ready in under 5 seconds, with less surface detail. The switch goes back **on** for every new photo (**New photo** puts every control back to its start), so on a slow computer do this again for each photo. **Always write down your times** (test cases D-01 and D-05). We do not know them for your kind of computer.

**The sample photos never wait.** The four samples on the first page come with their shape already worked out, so they open at once on any computer, even with the backend stopped.

**Dragging the light should always be fast.** That part runs in your browser, not in the backend: normally on the graphics chip. If the graphics chip cannot be used, the processor draws the picture instead and a grey note above the photo says so; the picture is then a slightly soft preview while the light moves and sharpens when it stops. If dragging or **Sweep** stutters, report it with the shading line from the GEOMETRY panel (test cases D-02, D-07 and W-16).

**Stopping and restarting.** Press Ctrl+C in each terminal to stop. To start again, repeat only step 5 and step 6 (without `npm ci`). The backend forgets loaded photos when it restarts: reload the page and choose the photo again.

**Getting fixes.** When told a fix is ready, stop both programs, then in either terminal:

```bash
cd ~/BanannaHacksSubmission
git pull
git log -1 --format=%h
```

(On Windows use `cd $HOME\BanannaHacksSubmission`.) The last command prints a short code such as `887bda5`. That is the **version**. Put it in every report. Then run `npm ci` in the `frontend` folder and start both programs again (steps 5 and 6). If `git pull` refuses with a message about local changes, see [Troubleshooting](#git-pull-says-your-local-changes-would-be-overwritten).

## Enhance, MOCK_MODE and keys

- **MOCK_MODE=1** (what the commands above use) means the Enhance button never calls a paid service. It returns a **stand-in**: the same lighting, drawn by the backend instead of the browser. The before/after halves look almost the same. Everything else in the app (shape, shading, shadows) is real.
- **Real Enhance** sends the picture to a hosted image model (Google Gemini, or fal.ai). It needs a **key**: a secret password for a paid account. Each real Enhance costs money. **With a Gemini key the backend stops after 10 calls per computer** (a call that fails still counts as one of the 10). **With a fal.ai key there is NO limit:** every click on Enhance costs money, so count your clicks. Which one you are using shows when you hover over the pill: the service that says `ready` has a key. If both say `ready`, Gemini is used.

**Most testers should not set up real Enhance.** Do it only if Aaroosh has asked you to and given you a key privately.

Rules for a key, with no exceptions:

1. It goes in **one place only**: a file named `.env` in the top folder of the project (`BanannaHacksSubmission/.env`).
2. Never paste a key into chat, an issue, a results file, a screenshot or any other file.
3. Never run `git add .env`. Git is set to ignore the file; leave it that way.
4. If a key ever appears somewhere public, tell Aaroosh at once so it can be cancelled.

Steps for real Enhance:

```bash
# macOS
cd ~/BanannaHacksSubmission
cp .env.example .env
```

```powershell
# Windows
cd $HOME\BanannaHacksSubmission
Copy-Item .env.example .env
```

Open `.env` in a text editor. Put the key after `GEMINI_API_KEY=` (no spaces, no quotes). Change the last line to `MOCK_MODE=0`. Save. Then stop the backend and start it **without** the MOCK_MODE setting:

```bash
# macOS
cd ~/BanannaHacksSubmission/backend
.venv/bin/python -m uvicorn app.main:app --port 8000
```

```powershell
# Windows: use a NEW PowerShell window, so the earlier MOCK_MODE setting is gone
cd $HOME\BanannaHacksSubmission\backend
.venv\Scripts\python.exe -m uvicorn app.main:app --port 8000
```

The pill should turn green and read **backend: online**. Hover over it: it should say `gemini: ready`. Test cases E-10 to E-14 and E-18 in [TEST_PLAN.md](TEST_PLAN.md) say what to try. When finished, go back to the normal start command with `MOCK_MODE=1`.

## Plan B: no backend (mock mode)

Use this if the backend will not install, or if you want the quickest way to try the app. You need only **git** and **Node** (step 1 for your computer, without Python) and the code (step 2). Skip steps 3, 4 and 5. Start only the frontend:

```bash
# macOS
cd ~/BanannaHacksSubmission/frontend
npm ci
NEXT_PUBLIC_MOCK=1 npm run dev
```

```powershell
# Windows
cd $HOME\BanannaHacksSubmission\frontend
npm.cmd ci
$env:NEXT_PUBLIC_MOCK = "1"
npm.cmd run dev
```

Open http://localhost:3000. The pill reads **backend: mock** (yellow dot).

**Use the four sample photos.** Under the dashed box are four pictures: Portrait, Coffee cup, Cat, Rocket. Click one. It opens at once and is lit for real: each sample comes with its true shape, worked out in advance, so the light, the shadows, the **Sweep** button, the sliders, **Hold to see original** and **Export PNG** all behave exactly as in the full setup. They are the same photos as files `01` to `04` in `testing/photos`.

![Plan B: a sample is lit correctly](screenshots/84-mock-sample.jpg)

**Your own photos work too.** Click the dashed box and choose any photo. Your browser works out its shape by itself; the photo is not sent anywhere. The **first** photo downloads a depth model of about 25 MB, so it can take up to a minute; the label on the dimmed photo says what is happening ("Downloading the depth model, 19 MB, once… 42%", then "Working out the shape of your photo…"). Later photos take a few seconds. The result is lit by its real shape. A face is a little flatter than on the Portrait sample, with a thin outline round the head: that is known (K48 in [PENDING.md](PENDING.md#already-known-no-need-to-report), case Q-12). Before the late night update of Oct 10 this mode lit every uploaded photo as a round dome. That is gone; if you see a dome without having clicked **Use a stand-in dome**, report it.

![Plan B: an uploaded file, lit by its real shape (Left preset)](screenshots/56-mock-scene.jpg)

What you can test this way: the smoke test (in step 2 choose the file as written, or click **Portrait**), case W-16 (the most wanted one: which shading path your device uses), case Q-11 (the face under side light), group G (the "How it works" card), cases F-01 and F-02, the sample cases U-05 and U-18 to U-21, and groups L, C, S, K, X and W, using the samples or the photo files. Group U works, and so do the new cases for your own photo with no backend: P-10 to P-13, Q-12, R-08 and R-23. What you cannot test: the backend's own loading screen (P-01), the backend's failed-load card (R-02, R-19, R-22), and anything that says it needs the backend. Mark those NOT RUN.

Three differences in this mode. **Enhance** finishes in about 4 seconds and returns a copy with a little more contrast and a soft glow; nothing is sent anywhere. The **Detailed normals** switch is greyed and cannot be clicked: on a sample it is on, with the line "Always on for a sample photo: its maps were made ahead of time with detailed normals." (case P-09); on your own photo it is off, with the line "Off for your own photo: detailed normals come from a second, much larger model that only the Relight server runs." (case P-12). The words on the loading label are the browser's, not the backend's "Estimating depth and surface normals…".

Say "Plan B" or "mock mode" in your report.

**A second way to use the samples.** In the full setup, the samples also work while the backend is stopped (pill **backend: offline**). Test cases R-16 to R-18 cover that.

## Plan C: the static demo on your own computer

The **static demo** is a copy of the web page made of plain files. It needs no backend and no running program of ours, so it can be put on a web address for the judges. It has the four samples and takes your own photo too: the browser works out the photo's shape, as in Plan B. Only Enhance is switched off, and the page says why. If Aaroosh gave you a demo address, use that and skip this part.

This part is **optional** and **macOS only**. The build command is written for macOS and Linux and is expected to fail on Windows; on Windows wait for a demo address. The developer ran these steps once, on one Mac. You need git, Node and the code (steps 1 and 2 for macOS).

Stop the frontend first if it is running (click terminal 2, press Ctrl+C). Then build the demo:

```bash
cd ~/BanannaHacksSubmission/frontend
npm ci
NEXT_PUBLIC_BASE_PATH=/BanannaHacksSubmission npm run build:demo
```

It takes a minute or two. It must end without a line containing `Error` or `Failed`. Afterwards there is a new folder named `out` inside `frontend` (about 2.3 MB). That folder is the whole demo.

A demo only works at the address it was built for. This one was built for a folder named `BanannaHacksSubmission`, so put it in a folder of that name and start a small web server one level above it:

```bash
rm -rf ~/relight-demo-site
mkdir -p ~/relight-demo-site
cp -R out ~/relight-demo-site/BanannaHacksSubmission
python3 -m http.server 3142 --directory ~/relight-demo-site
```

Leave that window open. Open http://localhost:3142/BanannaHacksSubmission/ in the browser (with the `/` at the end). The pill must be green and read **demo: runs in your browser**.

![The demo's first page](screenshots/96-demo-landing.jpg)

Now do group H in [TEST_PLAN.md](TEST_PLAN.md#h-hosted-demo-static-build), starting with H-08 and then H-12 (your own photo). Say "Plan C" in your report.

Things to know:

- If the page shows words but no pictures, and nothing reacts, the address is wrong: it must contain `/BanannaHacksSubmission/`.
- A wrong address inside the demo (case H-06 step 5) shows the little server's own plain "Error response" page here. Only GitHub Pages shows the app's black 404 page.
- If `python3` is not found, type `python3.12` in its place.
- Stop the little server with Ctrl+C. To go back to the normal app, start the frontend again with the step 6 command (without `npm ci`). The `out` folder and `~/relight-demo-site` can be deleted at any time.
- For whoever puts the demo online: upload everything **inside** `out`, including the hidden file `.nojekyll`. Without that file GitHub Pages does not serve the folder `_next`, and the page stays blank. A site that sits at the top of its address needs a build without the `NEXT_PUBLIC_BASE_PATH=…` part; that build has never been made or tried.

## Troubleshooting

### Windows: "npm : File ...npm.ps1 cannot be loaded because running scripts is disabled on this system"

PowerShell is refusing to run npm's script file. Type `npm.cmd` wherever these instructions say `npm` (for example `npm.cmd ci` and `npm.cmd run dev`). Nothing needs to be changed in Windows.

### Windows on a Snapdragon (ARM) laptop: `pip install` stops at `opencv-python-headless`

The backend's libraries are not all published for the ARM version of Python on Windows. `opencv-python-headless` is one: pip then tries to build it from source and stops, because there is no C compiler. (Found by a tester on a Snapdragon X laptop, Oct 11.)

Quickest: use [Plan B](#plan-b-no-backend-mock-mode), which needs no Python and runs everything except Enhance and the detailed normals for your own photo. The tester's Plan B set-up on that laptop worked as written; a photo of their own then came out covered in dimples (issue 4), which the depth check update of Oct 11 is meant to put right (test case P-15).

If you want the backend all the same, this is the likely way, **not yet tried by anyone**: uninstall the ARM64 Python, install the ordinary one (the file named **Windows installer (64-bit)** on the page in step 1, not the one named ARM64), delete the folder `backend\.venv`, and do step 3 again. That Python runs under Windows' emulation, so expect it to be slow. `py -0p` lists the Pythons Windows knows about; the 3.12 line should not say `arm64`. If it works, or stops somewhere else, say so in an issue with the last 30 lines of the output.

### The pill says "backend: offline"

![Offline pill](screenshots/51-status-offline.jpg)

1. Look at terminal 1. Is the backend still running, and did it print `Uvicorn running on http://127.0.0.1:8000`? If it shows an error, read the next sections.
2. Open http://localhost:8000/health in the browser. You should see text starting `{"ok":true,"mock_mode":true`. If you do, the backend is fine: wait 10 seconds (the pill rechecks every 10 seconds) or reload the page.
   Meanwhile the four sample photos on the first page still work.
3. If `/health` works at http://127.0.0.1:8000/health but not at `localhost`, restart the frontend with `http://127.0.0.1:8000` as the `NEXT_PUBLIC_API_URL` value.
4. If you started the backend on another port, the frontend's `NEXT_PUBLIC_API_URL` must use the same port. Changes to it need a frontend restart.

### "Address already in use" when starting the backend

Text like `[Errno 48] Address already in use` (macOS) or `[WinError 10048]` (Windows) means something already uses port 8000, usually a backend you started earlier in another window. Close that window. If you cannot find it, use another port for both programs:

```bash
# macOS, terminal 1
MOCK_MODE=1 .venv/bin/python -m uvicorn app.main:app --port 8001
# macOS, terminal 2
NEXT_PUBLIC_MOCK=0 NEXT_PUBLIC_API_URL=http://localhost:8001 npm run dev
```

```powershell
# Windows, window 1
$env:MOCK_MODE = "1"
.venv\Scripts\python.exe -m uvicorn app.main:app --port 8001
# Windows, window 2
$env:NEXT_PUBLIC_MOCK = "0"
$env:NEXT_PUBLIC_API_URL = "http://localhost:8001"
npm run dev
```

### The frontend says port 3000 is in use, or refuses to start

If port 3000 is taken by another program, the frontend picks the next free one and prints it, for example `Local: http://localhost:3001`. Use that address. If it refuses to start because another copy is already running in the same folder, close the other terminal that runs `npm run dev`. Two copies cannot run from one folder.

### macOS asks to let "Terminal", "node" or "python" access files in your Desktop or Documents folder

This appears if the project folder is inside Desktop or Documents. Click **Allow** (or **OK**). If you clicked "Don't Allow", the programs cannot read their own files: move the project to your home folder as in step 2, or allow it in System Settings, Privacy & Security, Files and Folders.

### The first photo seems stuck on "Estimating depth and surface normals…"

Almost always the one-time model download, because step 4 was skipped or did not finish. Check terminal 1 for progress bars. See [What to expect](#what-to-expect). If terminal 1 shows a red error instead, copy the last 20 lines into an issue. If the download fails with a message about rate limits, wait a few minutes and click **Retry** on the card over the photo.

### A card says "This photo could not be analysed" while terminal 1 still shows download bars

The card's second line reads "Cannot reach the backend…". The browser stopped waiting, but the backend is still downloading the models. Do not close anything. Wait for the bars in terminal 1 to finish, then click **Retry** on the card. To avoid this, do step 4 (Download the models) before loading a photo.

### A grey note says "Shading on this device's processor…"

![The grey note](screenshots/126-processor-note.jpg)

This is not an error. Your browser cannot use the graphics chip the way the app needs; the words in the note's brackets say why (most often "WebGL2 is not available in this browser"). The processor draws the picture instead. Everything still works, with or without the backend, and on the static demo too. While the light moves the picture is a slightly soft preview; it sharpens about a quarter of a second after the light stops.

We very much want to know about it. Report your device, the browser and its version, the note's exact words, and the last grey line of the opened GEOMETRY panel (it reads "shading: processor, in the background" or "shading: processor"). Test cases W-16, R-06 and R-11. Then, if you like, try whether another browser on the same device uses the graphics chip: use Google Chrome; in Chrome open `chrome://settings/system` and make sure "Use graphics acceleration when available" is on, then restart Chrome; update Chrome.

A second grey note exists: "This device's processor is slow at shading (… s a picture), so the server draws the photo instead. It lags slightly behind the light." It means the processor took more than 1.2 seconds over one picture, so the backend draws each one. Report it in the same way (test case F-03).

### A red bar says "Live shading is unavailable (…)"

![The red bar](screenshots/141-no-shading-at-all-server-renders.jpg)

This should be very rare: neither the graphics chip nor the processor can draw the picture in this browser. The brackets give both reasons. With the backend running the app still works, but each picture is drawn by the backend and arrives a moment late. If the backend cannot be reached (pill "offline"), the bar says so, offers a **Retry** link, and the light controls switch off until a picture arrives. On the static demo there is no backend at all: the bar then reads "… and this demo has no server to shade the photo instead. Open it in a current Chrome, Edge, Firefox or Safari." and the photo cannot be relit. Try another browser, and report it with your device, the browser and its version and the bar's exact words, whole (test cases F-04 and H-11).

### `pip install` fails

Check `python3.12 --version` (macOS) or `py -3.12 --version` (Windows) really says 3.12. Check you have free disk space. Then copy the **last 30 lines** of the error into an issue.

### `python3.12` or `py` is "not found" right after installing

Close the terminal and open a new one. On Windows, if `py` is still missing, run the Python installer again and tick "Add python.exe to PATH".

### You use conda instead of the python.org installer

Replace the `venv` line in step 3 with `conda create -y -p .venv python=3.12`. On macOS the other commands stay the same. On Windows the program is then at `.venv\python.exe` (not `.venv\Scripts\python.exe`); change that in steps 3, 4 and 5.

### The page looks broken after `git pull`

Stop the frontend, run `npm ci` again in the `frontend` folder, start it again, and reload the page with Cmd+Shift+R (macOS) or Ctrl+Shift+R (Windows).

### `git pull` says your local changes would be overwritten

A file in the project folder was changed on your computer by accident. In the `BanannaHacksSubmission` folder run:

```bash
git checkout -- .
git pull
```

The first command throws away accidental edits to the project's own files. It does not touch files you added yourself, but to be safe keep your results files and screenshots on the Desktop, not inside the project folder.

### The pill is green "online" but you wanted the stand-in

The backend was started without `MOCK_MODE=1` and a `.env` file says `MOCK_MODE=0`. Stop it and start it with the step 5 command.
