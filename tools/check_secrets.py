#!/usr/bin/env python3
"""Refuse to let secrets into the repository.

    python3 tools/check_secrets.py --staged    what is about to be committed (used by the pre-commit hook)
    python3 tools/check_secrets.py --tree      every file git would track in the working folder
    python3 tools/check_secrets.py --history   every file in every commit on every branch

Three kinds of check:
  1. file names that should never be committed (.env, private keys);
  2. text that looks like a credential (known key formats, hard-coded key assignments);
  3. the actual values in the local .env, searched for literally, so a key in a
     format this script has never heard of is still caught.
Matches are reported by file and line with the value masked. Exits 1 if anything is found.

Install the hook once per clone:
    printf '#!/bin/sh\nexec python3 tools/check_secrets.py --staged\n' > .git/hooks/pre-commit && chmod +x .git/hooks/pre-commit
"""

import re
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]

FORBIDDEN_NAMES = re.compile(
    r"(^|/)(\.env(\.[^/]*)?|.*\.pem|.*\.p12|.*\.pfx|id_rsa|id_ed25519|credentials\.json|token\.json|\.netrc|\.modal\.toml)$"
)
ALLOWED_NAMES = re.compile(r"(^|/)\.env\.(example|sample|template)$|(^|/)\.env\.local\.example$")

PATTERNS = {
    "Google API key": r"AIza[0-9A-Za-z_\-]{35}",
    "fal key": r"\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}:[0-9a-f]{32}\b",
    "Anthropic key": r"sk-ant-[A-Za-z0-9_\-]{20,}",
    "OpenAI-style key": r"\bsk-(proj-)?[A-Za-z0-9_\-]{32,}",
    "Replicate token": r"\br8_[A-Za-z0-9]{30,}",
    "Hugging Face token": r"\bhf_[A-Za-z0-9]{30,}",
    "GitHub token": r"\b(gh[pousr]_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{40,})",
    "AWS access key": r"\bAKIA[0-9A-Z]{16}\b",
    "private key block": r"-----BEGIN [A-Z ]*PRIVATE KEY-----",
    "hard-coded credential": r"""(?i)\b(api[_-]?key|secret|token|passw(or)?d|auth)\w*\s*[:=]\s*["'][^"'\s<>{}$]{20,}["']""",
    "key in a URL": r"(?i)[?&](key|api_key|token|access_token)=[A-Za-z0-9_\-]{20,}",
}
PLACEHOLDER = re.compile(r"(?i)your|example|placeholder|changeme|xxxx|\.\.\.")
COMPILED = {name: re.compile(rx) for name, rx in PATTERNS.items()}


def env_values() -> dict[str, bytes]:
    """Secret-looking values from the local .env files, keyed by variable name."""
    values = {}
    for env in (ROOT / ".env", ROOT / "frontend" / ".env.local", ROOT / "backend" / ".env"):
        if not env.exists():
            continue
        for line in env.read_text(errors="replace").splitlines():
            name, sep, value = line.partition("=")
            value = value.strip().strip("\"'")
            if sep and len(value) >= 12 and not name.strip().startswith("#"):
                values[name.strip()] = value.encode()
    return values


def git(*args: str) -> bytes:
    return subprocess.run(["git", "-C", str(ROOT), *args], capture_output=True, check=True).stdout


def scan(label: str, path: str, data: bytes, literals: dict[str, bytes]) -> list[str]:
    found = []
    if FORBIDDEN_NAMES.search(path) and not ALLOWED_NAMES.search(path):
        found.append(f"{label}{path}: file of this name must not be committed")
    for name, value in literals.items():
        if value in data:
            line = data[: data.index(value)].count(b"\n") + 1
            found.append(f"{label}{path}:{line}: contains the real value of {name} from .env")
    if b"\0" in data[:8000]:
        return found  # binary: only the literal search applies
    text = data.decode(errors="replace")
    for name, rx in COMPILED.items():
        for m in rx.finditer(text):
            if PLACEHOLDER.search(m.group(0)):
                continue
            line = text.count("\n", 0, m.start()) + 1
            found.append(f"{label}{path}:{line}: looks like a {name} ({m.group(0)[:6]}...{len(m.group(0))} chars)")
    return found


def main() -> int:
    mode = sys.argv[1] if len(sys.argv) > 1 else "--staged"
    literals = env_values()
    findings: list[str] = []
    checked = 0
    if mode == "--staged":
        for path in git("diff", "--cached", "--name-only", "--diff-filter=ACMR", "-z").decode().split("\0"):
            if path:
                findings += scan("", path, git("show", f":{path}"), literals)
                checked += 1
    elif mode == "--tree":
        for path in git("ls-files", "-co", "--exclude-standard", "-z").decode().split("\0"):
            if path and (ROOT / path).is_file():
                findings += scan("", path, (ROOT / path).read_bytes(), literals)
                checked += 1
    elif mode == "--history":
        seen = set()
        for row in git("rev-list", "--all", "--objects").decode().splitlines():
            sha, _, path = row.partition(" ")
            if not path or sha in seen:
                continue
            seen.add(sha)
            if git("cat-file", "-t", sha).strip() == b"blob":
                findings += scan(f"[{sha[:8]}] ", path, git("cat-file", "blob", sha), literals)
                checked += 1
        messages = git("log", "--all", "--format=%H%n%B")
        findings += scan("", "(commit messages)", messages, literals)
    else:
        print(__doc__)
        return 2
    for f in sorted(set(findings)):
        print("SECRET CHECK:", f)
    names = ", ".join(sorted(literals)) or "none (no .env found, so only pattern checks ran)"
    print(f"{mode[2:]}: {checked} files checked, {len(set(findings))} problems. Literal values searched for: {names}")
    return 1 if findings else 0


if __name__ == "__main__":
    sys.exit(main())
