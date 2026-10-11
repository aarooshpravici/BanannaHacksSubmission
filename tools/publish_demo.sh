#!/bin/bash
# Publish the static demo to GitHub Pages.
#
#     tools/publish_demo.sh
#
# Builds the demo from the last commit (not from unsaved work in the folder), in
# a temporary folder, and pushes the finished pages to the branch gh-pages.
# GitHub serves that branch at https://<owner>.github.io/<repository>/ a minute
# or two later. The demo does not update by itself: run this again after the app
# changes.
#
# It does not touch the working folder, the current branch or what is staged.
# GitHub Pages is switched on once, by hand: Settings, Pages, "Deploy from a
# branch", gh-pages, / (root). A workflow would rebuild on every push, but
# pushing one needs a login with the "workflow" permission.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
REMOTE="${1:-origin}"
cd "$ROOT"
# GitHub Pages serves a project from a folder named after the repository.
REPO="$(basename -s .git "$(git remote get-url "$REMOTE")")"
REV="$(git rev-parse --short HEAD)"
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

echo "Building the demo from $REV for /$REPO ..."
git archive HEAD frontend | tar -x -C "$WORK"
(
  cd "$WORK/frontend"
  npm ci --no-audit --no-fund > "$WORK/npm.log" 2>&1 || { tail -20 "$WORK/npm.log"; exit 1; }
  NEXT_PUBLIC_BASE_PATH="/$REPO" NEXT_TELEMETRY_DISABLED=1 npm run build:demo > "$WORK/build.log" 2>&1 || { tail -30 "$WORK/build.log"; exit 1; }
)
OUT="$WORK/frontend/out"
test -f "$OUT/index.html" && test -f "$OUT/.nojekyll"

# These pages are public, and no commit hook looks at them. Stop if a value from
# .env, or this computer's home folder path, has found its way in.
python3 - "$OUT" "$ROOT/.env" <<'EOF'
import re, sys
from pathlib import Path

out, env = Path(sys.argv[1]), Path(sys.argv[2])
needles = {"the home folder path": str(Path.home()).encode()}
if env.exists():
    for line in env.read_text().splitlines():
        m = re.match(r"\s*([A-Za-z0-9_]+)\s*=\s*(\S.*)$", line)
        if m and len(m.group(2).strip("\"' ")) >= 12:
            needles[m.group(1)] = m.group(2).strip("\"' ").encode()
files = [p for p in out.rglob("*") if p.is_file()]
found = sorted({f"{name} in {p.relative_to(out)}" for p in files for name, value in needles.items() if value in p.read_bytes()})
print(f"Checked {len(files)} built files for {len(needles)} private values: {len(found)} found.")
for line in found:
    print("  " + line)
sys.exit(1 if found else 0)
EOF

# A commit that holds only the built pages, made without switching branch.
cd "$OUT"
export GIT_DIR="$ROOT/.git" GIT_WORK_TREE="$OUT" GIT_INDEX_FILE="$WORK/index"
git add -A -f .
COMMIT="$(git commit-tree "$(git write-tree)" -m "Static demo built from $REV")"
unset GIT_WORK_TREE GIT_INDEX_FILE
git push --quiet --force "$REMOTE" "$COMMIT:refs/heads/gh-pages"
echo "Published $REV to the branch gh-pages. It is live a minute or two from now."
