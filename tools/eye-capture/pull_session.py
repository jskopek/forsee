#!/usr/bin/env python3
"""Copies a recording session from the phone to this computer and prints a
short summary of what it contains.

    python3 tools/eye-capture/pull_session.py http://192.168.1.23:8080            # newest
    python3 tools/eye-capture/pull_session.py http://192.168.1.23:8080 --list
    python3 tools/eye-capture/pull_session.py http://192.168.1.23:8080 20261115-143022-jm-back
    python3 tools/eye-capture/pull_session.py http://192.168.1.23:8080 all

Files land in tools/eye-capture/captures/<session>/ (ignored by git). Files that
are already there with the right size are skipped, so it is safe to run again.

Needs only the Python standard library.
"""

from __future__ import annotations

import argparse
import json
import sys
import urllib.error
import urllib.parse
import urllib.request
from pathlib import Path

DEFAULT_OUT = Path(__file__).resolve().parent / "captures"
CHUNK = 1 << 20


def fetch_json(url: str) -> dict:
    with urllib.request.urlopen(url, timeout=15) as response:
        return json.load(response)


def megabytes(count: int) -> str:
    return f"{count / 1e6:.1f} MB"


def download(url: str, destination: Path, expected: int) -> None:
    partial = destination.with_name(destination.name + ".part")
    done = 0
    with urllib.request.urlopen(url, timeout=60) as response, partial.open("wb") as handle:
        while True:
            chunk = response.read(CHUNK)
            if not chunk:
                break
            handle.write(chunk)
            done += len(chunk)
            if expected > 5 * CHUNK:
                percent = 100 * done / expected
                print(f"\r    {destination.name}: {percent:5.1f}%", end="", flush=True)
    if expected > 5 * CHUNK:
        print()
    if done != expected:
        partial.unlink(missing_ok=True)
        raise OSError(f"{destination.name}: got {done} bytes, expected {expected}")
    partial.replace(destination)


def pull(base: str, session: dict, out: Path) -> Path:
    directory = out / session["id"]
    directory.mkdir(parents=True, exist_ok=True)
    print(f"{session['id']}  ({len(session['files'])} files, {megabytes(session['bytes'])})")
    for entry in session["files"]:
        destination = directory / entry["name"]
        if destination.exists() and destination.stat().st_size == entry["bytes"]:
            continue
        quoted = urllib.parse.quote
        url = f"{base}/files/{quoted(session['id'])}/{quoted(entry['name'])}"
        download(url, destination, entry["bytes"])
    return directory


def count_events(path: Path) -> dict[str, dict[str, int]]:
    """Counts events of each type for each segment."""
    counts: dict[str, dict[str, int]] = {}
    if not path.exists():
        return counts
    for line in path.read_text().splitlines():
        try:
            event = json.loads(line)
        except json.JSONDecodeError:
            continue
        segment = counts.setdefault(event.get("seg") or "", {})
        segment[event.get("type", "?")] = segment.get(event.get("type", "?"), 0) + 1
    return counts


def summarise(directory: Path) -> None:
    events = count_events(directory / "events.jsonl")
    segments = sorted(
        path
        for path in directory.glob("*.json")
        if path.name != "meta.json" and (directory / f"{path.stem}.mov").exists()
    )
    if not segments:
        print("    No finished recordings in this session.")
        return
    for path in segments:
        info = json.loads(path.read_text())
        video = directory / f"{path.stem}.mov"
        parts = [
            f"{info.get('width', '?')}x{info.get('height', '?')}",
            f"{info.get('framesWritten', 0)} frames",
        ]
        if info.get("meanFps"):
            parts.append(f"{info['meanFps']:.1f} fps")
        lost = info.get("framesSkipped", 0) + info.get("framesDropped", 0)
        if lost:
            parts.append(f"{lost} frames lost")
        focus = info.get("minFocusDistanceMM", -1)
        if focus and focus > 0:
            parts.append(f"closest focus {focus / 10:.0f} cm")
        dots = events.get(path.stem, {}).get("target_on", 0)
        parts.append(f"{dots} dots")
        parts.append(megabytes(video.stat().st_size))
        if info.get("error"):
            parts.append(f"ERROR: {info['error']}")
        print(f"    {path.stem}: " + ", ".join(parts))


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    parser.add_argument("phone", help="address shown in the app, e.g. http://192.168.1.23:8080")
    parser.add_argument(
        "session", nargs="?", default="latest", help="a session name, 'latest' (default) or 'all'"
    )
    parser.add_argument("--list", action="store_true", help="list sessions and stop")
    parser.add_argument("--out", type=Path, default=DEFAULT_OUT, help="where to put the files")
    arguments = parser.parse_args()

    base = arguments.phone.rstrip("/")
    if "://" not in base:
        base = "http://" + base
    try:
        sessions = fetch_json(f"{base}/api/sessions")["sessions"]
    except (urllib.error.URLError, OSError) as error:
        print(f"Could not reach the phone at {base}: {error}", file=sys.stderr)
        return 1

    if arguments.list:
        for session in sessions:
            print(f"{session['id']}  ({len(session['files'])} files, {megabytes(session['bytes'])})")
        return 0
    if not sessions:
        print("The phone has no sessions yet.")
        return 0

    if arguments.session == "all":
        chosen = sessions
    elif arguments.session == "latest":
        chosen = sessions[:1]
    else:
        chosen = [session for session in sessions if session["id"] == arguments.session]
        if not chosen:
            print(f"No session called {arguments.session}. Try --list.", file=sys.stderr)
            return 1

    for session in chosen:
        try:
            directory = pull(base, session, arguments.out)
        except (urllib.error.URLError, OSError) as error:
            print(f"Download failed: {error}", file=sys.stderr)
            return 1
        summarise(directory)
        print(f"    saved to {directory}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
