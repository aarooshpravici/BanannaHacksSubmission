# Publishing the static demo for free

The static demo is the whole page with no backend: the four built-in samples, and your own photo, whose depth is estimated in the browser (a model of about 25 MB fetched once from huggingface.co and cdn.jsdelivr.net, so the host must not block those). Only Enhance is switched off.

Details marked [CHECK] could not be confirmed from the code, because the static build was still being added when this was written. At that time `frontend/package.json` had no `build:demo` script and `frontend/next.config.ts` had no static-export or base-path setting.

## What "base path" means, and why GitHub Pages needs it

A drag-and-drop host gives you a whole address of your own, such as `https://my-site.example.app/`. The app sits at the top, so its files are at `/samples/...` and `/_next/...`. The base path is empty.

GitHub Pages puts a project site in a folder named after the repository: `https://aarooshpravici.github.io/BanannaHacksSubmission/`. Every file is now under `/BanannaHacksSubmission/...`. If the app is built without being told this, the page loads as blank white text or the sample thumbnails are broken, because the browser looks for files at the top of the site. So the build must be given the base path `/BanannaHacksSubmission`: a leading slash, no slash at the end, same capital letters as the repository name. [CHECK: repository name and owner, from `git remote -v`.]

The environment variable that carries the base path is written below as `NEXT_PUBLIC_BASE_PATH`. [CHECK: the real name. Look in `frontend/next.config.ts` and `frontend/package.json` after the build agent finishes.] The build is assumed to write the finished site to `frontend/out`. [CHECK: the output folder.]

## Step 0 (both options): build it once on your own computer

1. Open the Terminal app.
2. Go to the frontend folder: `cd` followed by a space, then drag the `frontend` folder from Finder into the Terminal window, then press Return.
3. Type `npm ci` and press Return. Wait until it finishes (a minute or two). You only need this once.
4. Type `npm run build:demo` and press Return. [CHECK: script name.]
5. When it finishes without red error text, look for a new folder `frontend/out` containing `index.html`, a folder `_next` and a folder `samples`. [CHECK]
6. Test it before publishing. Type `npx serve out` and press Return, answer `y` if it asks to install `serve`, and open the address it prints (usually `http://localhost:3000`). Click each of the four samples and drag the light. Press Control+C in the Terminal to stop. [CHECK: `npx serve` downloads a small tool the first time. If you were told not to install anything, use `python3 -m http.server 3000 --directory out` instead.]

This test only works for a build with an EMPTY base path. A build made for GitHub Pages will look broken when opened this way; that is expected.

## Option A: drag-and-drop static host (quickest, about 5 minutes)

Use this if the deadline is close. The example is Netlify Drop; Cloudflare Pages "direct upload" works the same way.

1. Do Step 0 with no base path set, so the app expects to sit at the top of the site. If you set the variable earlier in the same Terminal window, type `unset NEXT_PUBLIC_BASE_PATH` first, then run `npm run build:demo` again. [CHECK: variable name.]
2. In a browser, open `https://app.netlify.com/drop`.
3. Sign up for a free account when asked (signing in with GitHub is fine). No payment card is needed. [CHECK: a site dropped without an account is deleted after a short time, so do make the account.]
4. Open Finder and find the `frontend/out` folder.
5. Drag the whole `out` folder onto the box on the web page. Wait for the upload to finish.
6. Netlify shows an address ending in `.netlify.app`. Open it in a new private window.
7. Check: all four thumbnails show; clicking each one loads the photo; dragging the sun changes the lighting; **Sweep** and **Cast shadows** work. Upload one photo of your own in a private window and check it is lit (case H-12), on a phone too.
8. Optional: in **Site configuration**, choose **Change site name** to get a tidier address. [CHECK: menu wording.]
9. To update the site later: build again, open the site's **Deploys** page, and drag the new `out` folder onto it.
10. Put the address in the submission form and in the README.

## Option B: GitHub Pages from this repository

Use this if you want the demo address to sit next to the code. GitHub Pages is free for public repositories, and this one is public.

GitHub builds the site itself from a small instruction file called a workflow. You add the file once.

1. Make sure the static-build changes are committed and pushed to GitHub. The workflow builds what is on GitHub, not what is on your computer. Ask whoever handles commits to do this.
2. On GitHub, open the repository, then **Settings** (top row), then **Pages** (left column).
3. Under **Build and deployment**, set **Source** to **GitHub Actions**.
4. Still in **Settings**, open **Environments**, then **github-pages**. (If it is not listed yet, come back after step 8.) Under **Deployment branches and tags**, add the branch `relight`, or choose **No restriction**. Without this, a deploy from any branch other than the default one fails with a message about environment protection rules. [CHECK: which branch the final code is on. If it has been merged to `main`, skip this step and use `main` in the file below.]
5. Go back to the repository's **Code** tab. Switch the branch dropdown to `relight`. Click **Add file**, then **Create new file**.
6. In the name box type exactly `.github/workflows/pages.yml`.
7. Paste this into the big box:

```yaml
name: Publish demo to GitHub Pages

on:
  push:
    branches: [relight]        # [CHECK] change to main if the code lives there
  workflow_dispatch:

permissions:
  contents: read
  pages: write
  id-token: write

concurrency:
  group: pages
  cancel-in-progress: true

jobs:
  build:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: 24       # [CHECK] the app was developed on Node 26
          cache: npm
          cache-dependency-path: frontend/package-lock.json
      - run: npm ci
        working-directory: frontend
      - run: npm run build:demo  # [CHECK] script name
        working-directory: frontend
        env:
          # The sub-path GitHub Pages serves this repository from.
          NEXT_PUBLIC_BASE_PATH: /${{ github.event.repository.name }}   # [CHECK] variable name
      - uses: actions/upload-pages-artifact@v3
        with:
          path: frontend/out     # [CHECK] output folder

  deploy:
    needs: build
    runs-on: ubuntu-latest
    environment:
      name: github-pages
      url: ${{ steps.deployment.outputs.page_url }}
    steps:
      - id: deployment
        uses: actions/deploy-pages@v4
```

8. Click **Commit changes**, then **Commit changes** again in the box that opens. (This is done on the GitHub website, so it does not touch anyone's local files, but tell your teammates so they pull it.)
9. Open the **Actions** tab. A run called "Publish demo to GitHub Pages" appears with a yellow dot. Wait two to four minutes for a green tick.
10. If it has a red cross, click it, click the failed step and read the last lines. The three usual causes: the script name is not `build:demo`; the output folder is not `frontend/out`; or the environment rule from step 4.
11. Open `https://aarooshpravici.github.io/BanannaHacksSubmission/` in a private window. The first time it can take a few minutes to appear. [CHECK: address.]
12. Check the same things as Option A step 7. Pay special attention to the four thumbnails.

### If the page loads but looks wrong

- **White page with unstyled text, or nothing at all.** The base path is missing or misspelt. It must be `/BanannaHacksSubmission`, with matching capital letters, a leading slash and no trailing slash.
- **The page looks right but the sample thumbnails are broken, or clicking a sample shows a red bar.** The samples are being fetched from `/samples/...` at the top of the site, without the base path. At the time of writing `frontend/lib/samples.ts` built the address as `/samples/<name>/<file>` with no prefix, so this needs the build agent's change to be in place. [CHECK: that the sample addresses, the thumbnails and the icon all include the base path.] This is also open item 28 in `testing/PENDING.md`.
- **A 404 page from GitHub.** Pages is not switched to **GitHub Actions** (step 3), or the workflow has not finished.
- **It works at `/BanannaHacksSubmission/` but `/BanannaHacksSubmission/relight` is a 404.** Link to the top address only. [CHECK: whether the demo build writes a `/relight` page.]

### The other way to use GitHub Pages (no workflow file)

Pages can also publish a folder straight from a branch, but only a folder named `/docs` or the top of a branch. This repository's `docs` folder already holds a report, so this way is messier and is not recommended. If you must: build with the base path set, copy the contents of `frontend/out` into a new branch's top level, add an empty file named `.nojekyll` (without it GitHub ignores the `_next` folder because its name starts with an underscore), and choose that branch under **Settings > Pages > Deploy from a branch**. [CHECK: not tried.]

## After publishing (both options)

1. Open the address on a second computer and, if you can, a phone. Upload one photo of your own in a private window and check it is lit (case H-12), on a phone too. The in-browser analysis of your own photo has only run in Chrome on one Apple-chip Mac (open item 40 in `testing/PENDING.md`).
2. Run test cases U-05 and U-18 to U-21 from `testing/TEST_PLAN.md` on the hosted copy.
3. Add the address to the top of `README.md` and to the submission form.
4. Do not put any key in a build setting. The static demo needs none.
