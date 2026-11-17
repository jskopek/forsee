"""Load an eye-capture session: metadata, per-camera recordings, dots and frame times.

A session folder holds meta.json, events.jsonl and, per camera, <name>.json, <name>.frames.csv,
<name>.motion.csv and <name>.mov. See tools/eye-capture/README.md for the format.
"""

import csv
import json
import subprocess
from dataclasses import dataclass, field
from pathlib import Path

import numpy as np

SETTLE_S = 0.7  # skip this much of each dot while the eyes are still travelling
IRIS_MM = 11.7  # typical adult visible iris diameter
EYE_ROTATION_RADIUS_MM = 12.0  # iris plane to eye centre of rotation, for pixels per degree


@dataclass
class Dot:
    index: int  # position in the grid
    order: int  # order shown
    x: float  # CSS pixels from the page's top-left
    y: float
    t_on: float  # phone clock, seconds
    t_off: float


@dataclass
class Recording:
    name: str  # file stem, e.g. back-wide-2x
    folder: Path
    info: dict  # <name>.json
    frames: dict  # column -> numpy array, from <name>.frames.csv
    events: list  # this segment's events
    dots: list = field(default_factory=list)

    @property
    def video(self) -> Path:
        return self.folder / f"{self.name}.mov"

    @property
    def t(self) -> np.ndarray:
        return self.frames["t"]

    def segment_event(self, kind):
        return next((e for e in self.events if e["type"] == kind), None)

    def settled_frames(self, dot: Dot, settle=SETTLE_S):
        """Frame numbers whose capture time lies in the settled part of a dot."""
        t = self.t
        return np.nonzero((t >= dot.t_on + settle) & (t < dot.t_off))[0]

    def fx(self):
        return self.info["intrinsics"]["fx"]

    def expected_iris_px(self, distance_cm):
        return self.fx() * IRIS_MM / (distance_cm * 10)


def read_csv_columns(path):
    with open(path, newline="") as f:
        rows = list(csv.reader(f))
    header, body = rows[0], rows[1:]
    data = np.array(body, dtype=float) if body else np.zeros((0, len(header)))
    return {name: data[:, i] for i, name in enumerate(header)}


def load_session(folder):
    folder = Path(folder)
    meta = json.loads((folder / "meta.json").read_text())
    events = [json.loads(line) for line in (folder / "events.jsonl").read_text().splitlines() if line]
    recordings = []
    for info_path in sorted(folder.glob("*.json")):
        if info_path.name == "meta.json":
            continue
        name = info_path.stem
        info = json.loads(info_path.read_text())
        seg = info.get("segment", name)
        seg_events = [e for e in events if e.get("seg") == seg]
        rec = Recording(
            name=name,
            folder=folder,
            info=info,
            frames=read_csv_columns(folder / f"{name}.frames.csv"),
            events=seg_events,
        )
        rec.dots = dots_from_events(seg_events)
        recordings.append(rec)
    recordings.sort(key=lambda r: r.t[0] if len(r.t) else 0)
    return meta, events, recordings


def dots_from_events(events):
    dots, pending = [], {}
    for e in events:
        if e["type"] == "target_on":
            pending[e["order"]] = e
        elif e["type"] == "target_off" and e["order"] in pending:
            on = pending.pop(e["order"])
            dots.append(Dot(on["index"], on["order"], on["x"], on["y"], on["t_phone"], e["t_phone"]))
    return sorted(dots, key=lambda d: d.order)


def read_motion(rec):
    return read_csv_columns(rec.folder / f"{rec.name}.motion.csv")


def video_pts(path):
    """Presentation times of every video frame, in seconds from the start of the file."""
    out = subprocess.run(
        ["ffprobe", "-v", "error", "-select_streams", "v:0", "-show_entries", "packet=pts_time",
         "-of", "csv=p=0", str(path)],
        capture_output=True, text=True, check=True,
    ).stdout
    return np.sort(np.array([float(x) for x in out.split()]))
