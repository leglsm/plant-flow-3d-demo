#!/usr/bin/env python3
"""De-identification check (push gate).

Scans every tracked or untracked-but-not-ignored file for forbidden terms.
  - Terms come from the local, git-ignored `.scrub-terms.txt` (one per line):
      plain text   -> case-insensitive, whole-word match
      cs:Text      -> case-sensitive, whole-word match
      re:pattern   -> regular expression (case-insensitive)
      # comment / blank lines ignored
  - Built-in generic patterns (personal e-mail addresses) are always checked.
  - PNG/JPG: printable strings of 6+ chars are checked (not raw bytes).
  - GIF/MP4/WEBM/MOV: only ffprobe metadata tags are checked (compressed
    bytes produce false positives).
  - lib/: if tools/lib-map.json exists, each pinned file must be
    byte-identical to its npm source.
Exit code 0 = clean, 1 = findings or setup error. Matched text is not printed
in full to the console log beyond file:line and the term index.
"""
import json
import os
import re
import subprocess
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
TERMS_FILE = os.path.join(ROOT, ".scrub-terms.txt")
TEXT_EXT = {".js", ".mjs", ".json", ".html", ".css", ".md", ".py", ".txt",
            ".svg", ".yml", ".yaml", ".csv", ".gitignore", ""}
IMG_EXT = {".png", ".jpg", ".jpeg"}
MEDIA_EXT = {".gif", ".mp4", ".webm", ".mov"}
SKIP_FILES = {".scrub-terms.txt"}

BUILTIN = [
    ("builtin:personal-email",
     re.compile(r"[A-Za-z0-9._%+-]+@(?!users\.noreply\.github\.com)(?!example\.(?:com|org))"
                r"[A-Za-z0-9.-]+\.[A-Za-z]{2,}")),
]


def load_terms():
    if not os.path.exists(TERMS_FILE):
        print("SCRUB SETUP ERROR: .scrub-terms.txt is missing (create it locally; it is git-ignored).")
        sys.exit(1)
    pats = []
    with open(TERMS_FILE, encoding="utf-8") as f:
        for n, raw in enumerate(f, 1):
            line = raw.strip()
            if not line or line.startswith("#"):
                continue
            if line.startswith("re:"):
                pats.append((f"term#{n}", re.compile(line[3:], re.I)))
            elif line.startswith("cs:"):
                pats.append((f"term#{n}", re.compile(r"(?<![A-Za-z0-9])" + re.escape(line[3:]) + r"(?![A-Za-z0-9])")))
            else:
                pats.append((f"term#{n}", re.compile(r"(?<![A-Za-z0-9])" + re.escape(line) + r"(?![A-Za-z0-9])", re.I)))
    if not pats:
        print("SCRUB SETUP ERROR: .scrub-terms.txt has no terms.")
        sys.exit(1)
    return pats + BUILTIN


def list_files():
    out = subprocess.run(["git", "ls-files", "-co", "--exclude-standard"], cwd=ROOT,
                         capture_output=True, text=True, check=True).stdout
    return [p for p in out.splitlines() if p and os.path.basename(p) not in SKIP_FILES
            and not p.startswith("node_modules/")]


def strings_of(data, min_len=6):
    return [m.group().decode("ascii") for m in re.finditer(rb"[\x20-\x7e]{%d,}" % min_len, data)]


def media_tags(path):
    try:
        out = subprocess.run(["ffprobe", "-v", "error", "-show_entries", "format_tags:stream_tags",
                              "-of", "json", path], capture_output=True, text=True, check=True).stdout
    except FileNotFoundError:
        print("SCRUB SETUP ERROR: ffprobe not found (needed for media metadata check).")
        sys.exit(1)
    return [out]


def check_lib():
    problems = []
    mp = os.path.join(ROOT, "tools", "lib-map.json")
    if not os.path.exists(mp):
        return problems
    with open(mp, encoding="utf-8") as f:
        mapping = json.load(f)
    for dst, src in mapping.items():
        a, b = os.path.join(ROOT, dst), os.path.join(ROOT, src)
        if not os.path.exists(b):
            problems.append(f"lib: npm source missing for {dst} (run npm install)")
            continue
        with open(a, "rb") as fa, open(b, "rb") as fb:
            if fa.read() != fb.read():
                problems.append(f"lib: {dst} differs from {src}")
    return problems


def main():
    pats = load_terms()
    findings = []
    files = list_files()
    for rel in files:
        path = os.path.join(ROOT, rel)
        if not os.path.isfile(path):
            continue
        ext = os.path.splitext(rel)[1].lower()
        if ext in IMG_EXT:
            with open(path, "rb") as f:
                chunks = strings_of(f.read())
        elif ext in MEDIA_EXT:
            chunks = media_tags(path)
        elif ext in TEXT_EXT or os.path.basename(rel).startswith("."):
            with open(path, encoding="utf-8", errors="replace") as f:
                chunks = f.read().splitlines()
        else:
            with open(path, "rb") as f:
                chunks = strings_of(f.read())
        for i, text in enumerate(chunks, 1):
            for tag, pat in pats:
                if pat.search(text):
                    findings.append(f"{rel}:{i}: {tag}")
    findings += check_lib()
    if findings:
        print(f"SCRUB FAILED — {len(findings)} finding(s):")
        for x in findings:
            print("  " + x)
        sys.exit(1)
    print(f"scrub ok — {len(files)} files, {len(pats)} patterns, 0 findings")


if __name__ == "__main__":
    main()
