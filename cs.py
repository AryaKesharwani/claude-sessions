#!/usr/bin/env python3
"""cs — find, back up and resume Claude Code sessions from any directory.

Claude Code stores every session at ~/.claude/projects/<encoded-cwd>/<id>.jsonl,
but `claude --resume` only lists sessions for the current folder, and old
sessions are deleted after `cleanupPeriodDays` (30 by default). This tool
indexes all of them, keeps an archive copy so nothing is lost, and resumes a
session by cd-ing into its original folder and running `claude --resume <id>`.
"""

import argparse
import json
import shlex
import os
import shutil
import subprocess
import sys
import time
from pathlib import Path

HOME = Path.home()
PROJECTS = HOME / ".claude" / "projects"
DATA = HOME / ".claude-sessions"
ARCHIVE = DATA / "archive"
INDEX = DATA / "index.json"
PINS = DATA / "pins.json"
SUMMARIES = DATA / "summaries.json"

HEAD_LINES = 400
TAIL_BYTES = 512 * 1024
FULL_SCAN_LIMIT = 8 * 1024 * 1024

DIM, BOLD, CYAN, YELLOW, GREEN, RESET = (
    ("\033[2m", "\033[1m", "\033[36m", "\033[33m", "\033[32m", "\033[0m")
    if sys.stdout.isatty() and not os.environ.get("NO_COLOR")
    else ("",) * 6
)


# ---------- parsing ----------

def _prompt_text(rec):
    """Return the typed text of a human user message, or None."""
    if rec.get("type") != "user" or rec.get("isSidechain") or rec.get("isMeta"):
        return None
    origin = rec.get("origin") or {}
    if origin and origin.get("kind") != "human":
        return None
    content = (rec.get("message") or {}).get("content")
    if isinstance(content, list):
        content = " ".join(
            c.get("text", "") for c in content if isinstance(c, dict) and c.get("type") == "text"
        )
    if not isinstance(content, str):
        return None
    text = " ".join(content.split())
    if not text or text.startswith("<") or text.startswith("Caveat:"):
        return None
    return text


def _apply(info, rec):
    t = rec.get("type")
    if t == "custom-title" and rec.get("customTitle"):
        info["custom_title"] = rec["customTitle"]
    elif t == "ai-title" and rec.get("aiTitle"):
        info["ai_title"] = rec["aiTitle"]
    elif t == "last-prompt" and rec.get("lastPrompt"):
        info["last_prompt"] = " ".join(rec["lastPrompt"].split())
    if rec.get("cwd") and not info.get("cwd"):
        info["cwd"] = rec["cwd"]
    if rec.get("gitBranch") and rec.get("gitBranch") != "HEAD":
        info["branch"] = rec["gitBranch"]
    text = _prompt_text(rec)
    if text:
        info.setdefault("first_prompt", text)
        info["prompts"] = info.get("prompts", 0) + 1


def _records(lines):
    for line in lines:
        try:
            rec = json.loads(line)
        except (ValueError, UnicodeDecodeError):
            continue
        if isinstance(rec, dict):
            yield rec


def parse_session(path: Path):
    st = path.stat()
    info = {"id": path.stem, "file": str(path), "mtime": st.st_mtime, "size": st.st_size}
    with open(path, "rb") as f:
        if st.st_size <= FULL_SCAN_LIMIT:
            for rec in _records(f):
                _apply(info, rec)
        else:
            head = [f.readline() for _ in range(HEAD_LINES)]
            for rec in _records(head):
                _apply(info, rec)
            f.seek(max(0, st.st_size - TAIL_BYTES))
            f.readline()  # skip partial line
            for rec in _records(f):
                _apply(info, rec)
            info["prompts_partial"] = True
    if not info.get("cwd"):
        return None  # empty / metadata-only session
    return info


# ---------- index ----------

def _load_json(path, default):
    try:
        return json.loads(path.read_text())
    except (OSError, ValueError):
        return default


def session_files():
    """Live sessions first, then archived copies of sessions that were cleaned up."""
    files = {}
    for root in (PROJECTS, ARCHIVE):
        if root.is_dir():
            for p in root.glob("*/*.jsonl"):
                files.setdefault(p.stem, p)
    return files


def load_sessions():
    cache = _load_json(INDEX, {})
    out, fresh = [], {}
    for sid, path in session_files().items():
        st = path.stat()
        hit = cache.get(str(path))
        if hit and hit.get("mtime") == st.st_mtime and hit.get("size") == st.st_size:
            info = hit
        else:
            info = parse_session(path) or {"id": sid, "file": str(path), "mtime": st.st_mtime,
                                            "size": st.st_size, "empty": True}
        fresh[str(path)] = info
        if not info.get("empty"):
            info["archived_only"] = ARCHIVE in path.parents
            out.append(info)
    DATA.mkdir(exist_ok=True)
    tmp = INDEX.with_suffix(".tmp")
    tmp.write_text(json.dumps(fresh))
    tmp.replace(INDEX)
    pins = set(_load_json(PINS, []))
    summaries = _load_json(SUMMARIES, {})
    for s in out:
        s["pinned"] = s["id"] in pins
        if s["id"] in summaries:
            s["summary"] = summaries[s["id"]]["text"]
            s["summary_stale"] = summaries[s["id"]]["mtime"] < s["mtime"]
    out.sort(key=lambda s: (not s["pinned"], -s["mtime"]))
    return out


def title(s):
    return s.get("custom_title") or s.get("ai_title") or s.get("first_prompt") or "(untitled)"


def matches(s, terms):
    hay = " ".join(
        str(s.get(k, "")) for k in ("id", "custom_title", "ai_title", "first_prompt", "last_prompt", "cwd", "branch")
    ).lower()
    return all(t.lower() in hay for t in terms)


# ---------- formatting ----------

def ago(ts):
    d = time.time() - ts
    for unit, secs in (("d", 86400), ("h", 3600), ("m", 60)):
        if d >= secs:
            return f"{int(d // secs)}{unit} ago"
    return "just now"


def short_path(p):
    p = str(p)
    return "~" + p[len(str(HOME)):] if p.startswith(str(HOME)) else p


def clip(text, n):
    return text if len(text) <= n else text[: n - 1] + "…"


def row(i, s, width):
    pin = "★ " if s["pinned"] else ""
    arch = f" {YELLOW}[archived]{RESET}" if s.get("archived_only") else ""
    where = short_path(s["cwd"]) + (f" ({s['branch']})" if s.get("branch") else "")
    head = f"{DIM}{i:>3}{RESET}  {BOLD}{pin}{clip(title(s), width - 30)}{RESET}{arch}"
    meta = f"     {CYAN}{where}{RESET}  {DIM}{ago(s['mtime'])} · {s['id'][:8]}{RESET}"
    return head + "\n" + meta


def print_list(sessions, limit):
    width = shutil.get_terminal_size((100, 20)).columns
    for i, s in enumerate(sessions[:limit], 1):
        print(row(i, s, width))
    if len(sessions) > limit:
        print(f"{DIM}  … {len(sessions) - limit} more (use -n or a search term){RESET}")


# ---------- actions ----------

def find(sessions, ref, terms=()):
    """Resolve a list number (from the same filtered list) or an id prefix."""
    pool = [s for s in sessions if matches(s, terms)]
    if ref.isdigit() and int(ref) <= len(pool) and len(ref) < 4:
        return pool[int(ref) - 1]
    hits = [s for s in sessions if s["id"].startswith(ref)]
    if len(hits) == 1:
        return hits[0]
    sys.exit(f"cs: {'ambiguous' if hits else 'no session matching'} '{ref}'")


def restore_if_archived(s):
    """Claude only resumes from ~/.claude/projects, so copy an archived session back."""
    src = Path(s["file"])
    if not s.get("archived_only"):
        return
    dest = PROJECTS / src.parent.name / src.name
    dest.parent.mkdir(parents=True, exist_ok=True)
    shutil.copy2(src, dest)
    print(f"{GREEN}restored{RESET} archived session to {short_path(dest)}")


def resume(s, extra=()):
    restore_if_archived(s)
    cwd = s["cwd"]
    if not os.path.isdir(cwd):
        sys.exit(f"cs: original folder no longer exists: {cwd}")
    claude = shutil.which("claude")
    if not claude:
        sys.exit("cs: `claude` not found on PATH")
    print(f"{DIM}cd {short_path(cwd)} && claude --resume {s['id']} {' '.join(extra)}{RESET}".rstrip())
    os.chdir(cwd)
    os.execv(claude, [claude, "--resume", s["id"], *extra])


def pick(sessions, terms, limit):
    pool = [s for s in sessions if matches(s, terms)]
    if not pool:
        sys.exit("cs: no sessions match")
    if shutil.which("fzf"):
        lines = [
            f"{i}\t{'★ ' if s['pinned'] else ''}{title(s)}\t{short_path(s['cwd'])}\t{ago(s['mtime'])}"
            for i, s in enumerate(pool)
        ]
        r = subprocess.run(
            ["fzf", "--delimiter=\t", "--with-nth=2..", "--height=60%", "--reverse",
             "--prompt=session> "],
            input="\n".join(lines), text=True, stdout=subprocess.PIPE,
        )
        if r.returncode != 0 or not r.stdout.strip():
            return
        return resume(pool[int(r.stdout.split("\t", 1)[0])])
    while True:
        print_list(pool, limit)
        try:
            ans = input(f"\n{BOLD}Resume #{RESET} (number, text to filter, enter to quit): ").strip()
        except (EOFError, KeyboardInterrupt):
            print()
            return
        if not ans:
            return
        if ans.isdigit() and 1 <= int(ans) <= min(limit, len(pool)):
            return resume(pool[int(ans) - 1])
        narrowed = [s for s in pool if matches(s, ans.split())]
        if narrowed:
            pool = narrowed
        else:
            print(f"{YELLOW}no match for '{ans}'{RESET}")
        print()


def backup(quiet=False):
    """Copy new or changed session files into ~/.claude-sessions/archive."""
    copied = 0
    for p in PROJECTS.glob("*/*.jsonl"):
        dest = ARCHIVE / p.parent.name / p.name
        st = p.stat()
        if dest.exists() and dest.stat().st_size == st.st_size and dest.stat().st_mtime >= st.st_mtime:
            continue
        dest.parent.mkdir(parents=True, exist_ok=True)
        shutil.copy2(p, dest)
        copied += 1
    if not quiet:
        total = len(list(ARCHIVE.glob("*/*.jsonl")))
        print(f"backed up {copied} changed session(s); {total} in {short_path(ARCHIVE)}")


def show(s, count):
    print(f"{BOLD}{title(s)}{RESET}")
    print(f"{CYAN}{short_path(s['cwd'])}{RESET}  {DIM}{s.get('branch') or ''}{RESET}")
    print(f"{DIM}id {s['id']} · updated {ago(s['mtime'])} · {s['size'] / 1e6:.1f} MB{RESET}\n")
    prompts = []
    with open(s["file"], "rb") as f:
        for rec in _records(f):
            text = _prompt_text(rec)
            if text:
                prompts.append(text)
    for text in prompts[-count:]:
        print(f"{GREEN}›{RESET} {clip(text, 300)}\n")
    print(f"{DIM}resume: cs resume {s['id'][:8]}{RESET}")


def summarize(s):
    """Ask a small model for a 2-3 sentence recap of the session and cache it."""
    prompts = []
    with open(s["file"], "rb") as f:
        for rec in _records(f):
            text = _prompt_text(rec)
            if text:
                prompts.append(clip(text, 400))
    if len(prompts) > 40:
        prompts = prompts[:10] + ["…"] + prompts[-30:]
    claude = shutil.which("claude")
    if not claude:
        sys.exit("cs: `claude` not found on PATH")
    brief = (
        "Below are the user's messages from a Claude Code coding session in "
        f"{short_path(s['cwd'])} titled \"{title(s)}\". Write a 2-3 sentence plain recap of what "
        "was worked on and where it ended up. No preamble, no markdown.\n\n"
        + "\n".join(f"- {p}" for p in prompts)
    )
    r = subprocess.run(
        [claude, "-p", "--model", "haiku", "--no-session-persistence", "--tools", ""],
        input=brief, text=True, capture_output=True, cwd=str(HOME), timeout=180,
    )
    text = r.stdout.strip()
    if r.returncode != 0 or not text:
        sys.exit(f"cs: summary failed: {(r.stderr or r.stdout).strip()[:300]}")
    cache = _load_json(SUMMARIES, {})
    cache[s["id"]] = {"text": text, "mtime": s["mtime"]}
    DATA.mkdir(exist_ok=True)
    SUMMARIES.write_text(json.dumps(cache, indent=1))
    print(text)


def toggle_pin(s):
    pins = _load_json(PINS, [])
    if s["id"] in pins:
        pins.remove(s["id"])
        print(f"unpinned {title(s)}")
    else:
        pins.append(s["id"])
        print(f"★ pinned {title(s)}")
    DATA.mkdir(exist_ok=True)
    PINS.write_text(json.dumps(pins))


def main():
    ap = argparse.ArgumentParser(prog="cs", description="Find and resume Claude Code sessions from anywhere.")
    sub = ap.add_subparsers(dest="cmd")

    p = sub.add_parser("pick", help="interactive picker (default)")
    p.add_argument("terms", nargs="*")
    p.add_argument("-n", type=int, default=20)

    p = sub.add_parser("ls", help="list sessions, newest first")
    p.add_argument("terms", nargs="*", help="filter words (title, prompt, folder, branch, id)")
    p.add_argument("-n", type=int, default=25)
    p.add_argument("--here", action="store_true", help="only sessions started in this folder")
    p.add_argument("--json", action="store_true")

    p = sub.add_parser("resume", aliases=["r"], help="resume by list number or id prefix")
    p.add_argument("ref")
    p.add_argument("terms", nargs="*", help="same filter used with ls, so numbers line up")
    p.add_argument("--claude-args", default="", help="extra arguments passed to claude, e.g. '--model opus'")

    p = sub.add_parser("show", help="print the last prompts of a session")
    p.add_argument("ref")
    p.add_argument("-n", type=int, default=8)

    p = sub.add_parser("pin", help="pin/unpin a session to the top of the list")
    p.add_argument("ref")

    p = sub.add_parser("summary", help="generate a short AI recap of a session (uses claude -p, haiku)")
    p.add_argument("ref")

    p = sub.add_parser("backup", help="archive session files so cleanup can't delete them")
    p.add_argument("-q", "--quiet", action="store_true")

    args = ap.parse_args()
    if args.cmd == "backup":
        return backup(args.quiet)

    sessions = load_sessions()
    if args.cmd in (None, "pick"):
        return pick(sessions, getattr(args, "terms", []), getattr(args, "n", 20))
    if args.cmd == "ls":
        pool = [s for s in sessions if matches(s, args.terms)]
        if args.here:
            pool = [s for s in pool if s["cwd"] == os.getcwd()]
        if args.json:
            return print(json.dumps(pool[: args.n], indent=2))
        return print_list(pool, args.n)
    if args.cmd in ("resume", "r"):
        return resume(find(sessions, args.ref, args.terms), shlex.split(args.claude_args))
    if args.cmd == "show":
        return show(find(sessions, args.ref), args.n)
    if args.cmd == "summary":
        return summarize(find(sessions, args.ref))
    if args.cmd == "pin":
        return toggle_pin(find(sessions, args.ref))


if __name__ == "__main__":
    main()
