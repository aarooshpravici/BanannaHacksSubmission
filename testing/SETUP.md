# Setup: getting Relight running

Follow the part for your computer: [macOS](#macos) or [Windows](#windows). Then read [What to expect](#what-to-expect) and, if something goes wrong, [Troubleshooting](#troubleshooting).

You will keep **two terminal windows** open the whole time: one runs the backend (Python), one runs the frontend (the web page). A terminal is the app where you type commands: "Terminal" on macOS, "PowerShell" on Windows.

You need about **12 GB of free disk space** and a good internet connection for the first run.

**In a hurry, or the backend will not install?** Go to [Plan B](#plan-b-no-backend-mock-mode). It needs only git and Node, takes about five minutes, and lets you test most of the app with the four built-in sample photos.

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
npm ci
$env:NEXT_PUBLIC_MOCK = "0"
$env:NEXT_PUBLIC_API_URL = "http://localhost:8000"
npm run dev
```

`npm ci` is only needed the first time, and again after each `git pull`. It installs exactly the versions the project lists and changes no project file. Wait for a line like `Local: http://localhost:3000`. Leave this window open.

If `npm` answers "running scripts is disabled on this system", type `npm.cmd` instead of `npm` in both commands.

### 7. Open the page

Open **Google Chrome** (or Edge) and go to http://localhost:3000.

---

## Check that it works

Look at the top-right pill.

| Pill | Meaning | What to do |
| --- | --- | --- |
| amber dot, **backend: online, mock providers** | Correct. Everything is real except Enhance, which is a stand-in. | Start testing. |
| red dot, **backend: offline** | The page cannot find the backend. The four sample photos still work; uploading a photo, Enhance and the Detailed normals switch do not. | See [Troubleshooting](#the-pill-says-backend-offline). |
| yellow dot, **backend: mock** | The frontend was started without the two `NEXT_PUBLIC_` settings, so it is not using the backend at all. This is [Plan B](#plan-b-no-backend-mock-mode). | If you meant to use the backend: stop the frontend (Ctrl+C) and start it again with the full command from step 6. |
| green dot, **backend: online** | The backend is running with real Enhance switched on. | Fine only if you meant to. See [Real Enhance](#enhance-mock_mode-and-keys). |

![Correct pill](screenshots/49-status-online-mock-providers.jpg)

**A ten-second check.** Click the **Portrait** picture under "Or try a sample photo:". The astronaut should open at once with the left of the face bright and the right cheek in shadow. Drag the round sun button: the lighting should follow. If a red bar appears, or the photo does not react, report it (test case W-16 in [TEST_PLAN.md](TEST_PLAN.md)).

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

**If photos are slow, turn the Detailed normals switch off.** The switch is inside the GEOMETRY panel at the bottom of the sidebar. The panel starts folded into one row: click the row to open it. It only appears after you have chosen a photo, and the switch starts **on**, so on a slow computer the first photo always begins with the slow model. The switch works even while "Estimating depth and surface normals…" is showing (it is the one control that is not locked then). On a slow computer: choose a photo, click the GEOMETRY row at once, and click **Detailed normals** off. The photo starts loading again without the slow model and should be ready in under 5 seconds, with less surface detail. The app keeps the switch off for later photos until you reload the page or click a sample. **Always write down your times** (test cases D-01 and D-05). We do not know them for your kind of computer.

**The sample photos never wait.** The four samples on the first page come with their shape already worked out, so they open at once on any computer, even with the backend stopped.

**Dragging the light should always be fast.** That part runs in your browser, on the graphics chip, not in the backend. If dragging or **Sweep** stutters, report it (test cases D-02 and D-07).

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
npm ci
$env:NEXT_PUBLIC_MOCK = "1"
npm run dev
```

Open http://localhost:3000. The pill reads **backend: mock** (yellow dot).

**Use the four sample photos.** Under the dashed box are four pictures: Portrait, Coffee cup, Cat, Rocket. Click one. It opens at once and is lit for real: each sample comes with its true shape, worked out in advance, so the light, the shadows, the **Sweep** button, the sliders, **Hold to see original** and **Export PNG** all behave exactly as in the full setup. They are the same photos as files `01` to `04` in `testing/photos`.

![Plan B: a sample is lit correctly](screenshots/84-mock-sample.jpg)

**Do not judge the lighting on a photo you upload.** In this mode the app cannot study an uploaded file. It pretends every uploaded photo is a round dome in the middle of the picture, so the lighting looks like a ball pressed into the photo. That is expected. Uploading is still useful for testing the dashed box, the error messages and the layout.

![Plan B: an uploaded file gets a made-up dome](screenshots/56-mock-scene.jpg)

What you can test this way: the smoke test (click **Portrait** in step 2), case W-16 (the most wanted one), the sample cases U-05 and U-18 to U-21, and groups L, C, S, K, X and W, using the samples wherever a case names one of the four main test photos. Group U also works, with the dome. What you cannot test: the loading screen, the failed-load card, and anything that says it needs the backend. Mark those NOT RUN.

Three differences in this mode. **Enhance** finishes in about 4 seconds and returns a copy with a little more contrast and a soft glow; nothing is sent anywhere. The **Detailed normals** switch: on an uploaded file it changes nothing visible. **Do not click it on a sample in this mode.** The sample then loses its real shape and is lit as the round dome. To get it back, click **New photo** and click the sample again. An uploaded big photo is shrunk to 1536 pixels on its longest side, not 1024 (this matters for case X-02).

Say "Plan B" or "mock mode" in your report.

**A second way to use the samples.** In the full setup, the samples also work while the backend is stopped (pill **backend: offline**). Test cases R-16 to R-18 cover that.

## Troubleshooting

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

### A red bar says "Live shading is unavailable (…). Showing server renders instead…"

![No WebGL](screenshots/52-no-webgl-fallback.jpg)

Your browser cannot use the graphics chip the way the app needs (the usual words in the brackets are "WebGL2 is not available in this browser"). With the backend running the app still works, but each move of the light is drawn by the backend and arrives a moment late. Without the backend (Plan B, or pill "offline") the photo cannot be relit at all. Try, in this order: use Google Chrome; in Chrome open `chrome://settings/system` and make sure "Use graphics acceleration when available" is on, then restart Chrome; update Chrome. Whether or not that fixes it, report it with your computer model, browser version and the exact words in the brackets (test cases W-16 and R-06).

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
