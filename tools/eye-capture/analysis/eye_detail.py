"""Steps 2 and 3: iris size, sharpness and eye finding per camera, on settled fixation frames.

    .venv/bin/python eye_detail.py ../captures/<session> [--every 3] [--camera back-tele]

Two passes per recording:
  1. On the middle settled frame of each dot, find the participant's right eye (nearer the phone
     here, and the one the telephoto sees) with MediaPipe, or the direct finder if MediaPipe
     finds no face, and fit the iris freely. The medians give the iris size and position.
  2. On every Nth settled frame: MediaPipe (full frame, then crops if the face is small); the
     direct finder cold (whole frame, iris size from the lens and a 35-100 cm range) to measure
     how well it works alone; then the iris fit, started from MediaPipe's guess or else from the
     direct finder searching near the pass-1 position, with the ellipse's long axis held within
     15% of the pass-1 size.
Per-frame results go to <session>/analysis/eye_detail.<camera>.csv, a contact sheet of fits to
<session>/analysis/eye_fits.<camera>.jpg, and a summary table is printed.
"""

import argparse
import csv
import math
from pathlib import Path

import cv2
import numpy as np

from eyes import MediaPipeEyes, direct_eyes, edge_width, eye_sharpness, fit_iris, radius_range
from session import EYE_ROTATION_RADIUS_MM, IRIS_MM, load_session

FIELDS = [
    "frame", "t", "dot_index", "dot_order",
    "mp_found", "mp_right_x", "mp_right_y", "mp_right_d", "mp_left_d",
    "cold_found", "cold_x", "cold_y", "cold_r", "cold_is_right_eye",
    "source", "fit_ok", "cx", "cy", "major", "minor", "inliers", "rays", "rms_px",
    "edge_px", "edge_rays", "contrast", "sharpness",
]


def read_frames(video, wanted):
    """Yield (frame number, BGR image) for the wanted frame numbers, decoding sequentially."""
    cap = cv2.VideoCapture(str(video))
    for n in range(max(wanted) + 1):
        if n not in wanted:
            cap.grab()
            continue
        ok, bgr = cap.read()
        if not ok:
            break
        yield n, bgr
    cap.release()


def guess_right_eye(bgr, mpe, r_min, r_max, near=None):
    """Right-eye guess: MediaPipe if it finds a face, else the direct finder. Also the cold result."""
    mp_eyes = {e.side: e for e in mpe.detect(bgr)}
    cold = direct_eyes(bgr, r_min, r_max, max_eyes=1)
    if "right" in mp_eyes:
        return mp_eyes, cold, mp_eyes["right"], "mediapipe"
    if near is not None:
        found = direct_eyes(bgr, r_min, r_max, near=near, max_eyes=1)
        if found:
            return mp_eyes, cold, found[0], "direct-near"
    if cold:
        return mp_eyes, cold, cold[0], "direct-cold"
    return mp_eyes, cold, None, None


def eye_prior(rec, mpe, r_min, r_max):
    """Pass 1: iris size and position from the middle settled frame of every dot."""
    mids = {int(f[len(f) // 2]) for d in rec.dots if len(f := rec.settled_frames(d))}
    fits = []
    for n, bgr in read_frames(rec.video, mids):
        _, _, guess, _ = guess_right_eye(bgr, mpe, r_min, r_max)
        if guess is None:
            continue
        gray = cv2.cvtColor(bgr, cv2.COLOR_BGR2GRAY).astype(np.float32)
        fit = fit_iris(gray, guess.centre, guess.radius)
        if fit is not None and fit["inliers"] >= 0.5 * fit["rays"]:
            fits.append((fit["centre"][0], fit["centre"][1], fit["major"]))
    if len(fits) < 5:
        return None
    f = np.array(fits)
    major = np.median(f[:, 2])
    centre = np.median(f[:, :2], axis=0)
    near_ok = np.linalg.norm(f[:, :2] - centre, axis=1) < 2 * major  # ignore stray detections
    major = np.median(f[near_ok, 2])
    return float(centre[0]), float(centre[1]), float(major), int(near_ok.sum()), len(mids)


def process(rec, every, out_dir, mpe):
    targets = {}
    for d in rec.dots:
        for n in rec.settled_frames(d)[::every]:
            targets[int(n)] = d
    r_min, r_max = radius_range(rec.fx())
    prior = eye_prior(rec, mpe, r_min, r_max)
    if prior is None:
        print(f"  {rec.name}: no consistent eye in pass 1")
        return [], None
    px, py, pmajor, n_used, n_tried = prior
    print(f"  {rec.name}: pass 1 iris {pmajor:.1f} px at ({px:.0f}, {py:.0f}) from {n_used}/{n_tried} dots")
    near = (px, py, pmajor / 2)
    major_range = (0.85 * pmajor, 1.15 * pmajor)
    rows, sheet = [], []
    for n, bgr in read_frames(rec.video, set(targets)):
        d = targets[n]
        gray = cv2.cvtColor(bgr, cv2.COLOR_BGR2GRAY)
        grayf = gray.astype(np.float32)
        row = {"frame": n, "t": rec.t[n], "dot_index": d.index, "dot_order": d.order}
        mp_eyes, cold, guess, source = guess_right_eye(bgr, mpe, r_min, r_max, near)
        row["mp_found"] = int(bool(mp_eyes))
        if "right" in mp_eyes:
            row.update(mp_right_x=mp_eyes["right"].centre[0], mp_right_y=mp_eyes["right"].centre[1],
                       mp_right_d=2 * mp_eyes["right"].radius, mp_left_d=2 * mp_eyes["left"].radius)
        row["cold_found"] = int(bool(cold))
        if cold:
            row.update(cold_x=cold[0].centre[0], cold_y=cold[0].centre[1], cold_r=cold[0].radius)
        row["source"] = source or ""
        fit = fit_iris(grayf, guess.centre, pmajor / 2, major_range=major_range) if guess is not None else None
        ok = fit is not None and fit["inliers"] >= 0.4 * fit["rays"] and fit["rms_px"] < 0.04 * fit["major"]
        row["fit_ok"] = int(ok)
        if fit is not None:
            row.update(cx=fit["centre"][0], cy=fit["centre"][1], major=fit["major"], minor=fit["minor"],
                       inliers=fit["inliers"], rays=fit["rays"], rms_px=fit["rms_px"])
        if ok:
            w, nrays, contrast = edge_width(grayf, fit)
            row.update(edge_px=w, edge_rays=nrays, contrast=contrast, sharpness=eye_sharpness(gray, fit))
            if len(sheet) < 12 and d.order % 2 == 0 and not any(s[0] == d.order for s in sheet):
                sheet.append((d.order, overlay(bgr, fit, d)))
        # Did the cold finder land on the eye? Judged against the fitted iris.
        if cold and ok:
            row["cold_is_right_eye"] = int(np.linalg.norm(cold[0].centre - fit["centre"]) < 0.25 * fit["major"])
        rows.append(row)
        if len(rows) % 100 == 0:
            print(f"  {rec.name}: {len(rows)}/{len(targets)} frames", flush=True)

    with open(out_dir / f"eye_detail.{rec.name}.csv", "w", newline="") as f:
        w = csv.DictWriter(f, FIELDS)
        w.writeheader()
        w.writerows(rows)
    if sheet:
        tiles = [s[1] for s in sheet] + [np.zeros_like(sheet[0][1])] * ((-len(sheet)) % 4)
        grid = np.vstack([np.hstack(tiles[i : i + 4]) for i in range(0, len(tiles), 4)])
        cv2.imwrite(str(out_dir / f"eye_fits.{rec.name}.jpg"), grid, [cv2.IMWRITE_JPEG_QUALITY, 85])
    return rows, prior


def overlay(bgr, fit, dot):
    c, major = fit["centre"], fit["major"]
    half_w, half_h = int(1.4 * major), int(0.7 * major)
    x, y = int(c[0]), int(c[1])
    crop = bgr[max(0, y - half_h) : y + half_h, max(0, x - half_w) : x + half_w].copy()
    (ex, ey), axes, ang = fit["ellipse"]
    ell = ((ex - max(0, x - half_w), ey - max(0, y - half_h)), axes, ang)
    cv2.ellipse(crop, ell, (0, 255, 0), max(1, int(major / 120)))
    crop = cv2.resize(crop, (400, 200), interpolation=cv2.INTER_AREA)
    cv2.putText(crop, f"dot {dot.index} major {major:.0f}px", (5, 18), cv2.FONT_HERSHEY_SIMPLEX, 0.5,
                (0, 0, 255), 1)
    return crop


def summarise(rec, rows):
    def col(name, only_ok=True):
        v = [r[name] for r in rows if name in r and r[name] is not None and (r.get("fit_ok") or not only_ok)]
        return np.array(v, float)

    n = len(rows)
    ok = [r for r in rows if r.get("fit_ok")]
    major = col("major")
    s = {"camera": rec.name, "frames": n}
    s["mediapipe_%"] = 100 * np.mean([r["mp_found"] for r in rows])
    s["cold_direct_found_%"] = 100 * np.mean([r["cold_found"] for r in rows])
    agree = [r["cold_is_right_eye"] for r in rows if "cold_is_right_eye" in r]
    s["cold_direct_on_eye_%"] = 100 * np.mean(agree) if agree else float("nan")
    for src in ("mediapipe", "direct-near", "direct-cold"):
        s[f"from_{src}_%"] = 100 * np.mean([r.get("source") == src for r in rows])
    s["fit_ok_%"] = 100 * len(ok) / n
    s["iris_major_px"] = np.median(major)
    s["iris_major_iqr"] = np.subtract(*np.percentile(major, [75, 25]))
    s["iris_minor_px"] = np.median(col("minor"))
    mp_d = col("mp_right_d", only_ok=False)
    s["mediapipe_iris_px"] = np.median(mp_d) if len(mp_d) else float("nan")
    s["implied_dist_cm"] = rec.fx() * IRIS_MM / s["iris_major_px"] / 10
    s["px_per_deg"] = s["iris_major_px"] / IRIS_MM * EYE_ROTATION_RADIUS_MM * math.pi / 180
    s["px_per_deg_at_60cm"] = rec.fx() * EYE_ROTATION_RADIUS_MM * math.pi / 180 / 600
    s["edge_px"] = np.median(col("edge_px"))
    s["edge_mm_on_eye"] = s["edge_px"] * IRIS_MM / s["iris_major_px"]
    s["iris_/_edge"] = s["iris_major_px"] / s["edge_px"]
    s["sharpness"] = np.median(col("sharpness"))
    s["contrast"] = np.median(col("contrast"))
    s["fit_rms_px"] = np.median(col("rms_px"))
    # Iris-centre spread within each fixation, in degrees of eye rotation (median over dots).
    spreads = []
    for idx in {r["dot_index"] for r in ok}:
        pts = np.array([[r["cx"], r["cy"]] for r in ok if r["dot_index"] == idx])
        if len(pts) >= 4:
            spreads.append(np.sqrt(np.mean(np.sum((pts - np.median(pts, 0)) ** 2, 1))))
    s["fixation_jitter_px"] = np.median(spreads) if spreads else float("nan")
    s["fixation_jitter_deg"] = s["fixation_jitter_px"] / s["px_per_deg"]
    return s


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("session")
    ap.add_argument("--every", type=int, default=3, help="use every Nth settled frame")
    ap.add_argument("--camera", action="append", help="only these recordings (file stem)")
    args = ap.parse_args()
    meta, _, recs = load_session(args.session)
    out_dir = Path(args.session) / "analysis"
    out_dir.mkdir(exist_ok=True)
    mpe = MediaPipeEyes()
    summaries = []
    for rec in recs:
        if args.camera and rec.name not in args.camera:
            continue
        print(f"{rec.name}: {rec.info['cameraName']} zoom {rec.info['zoom']:.2f}, fx {rec.fx():.0f}", flush=True)
        rows, prior = process(rec, args.every, out_dir, mpe)
        if rows:
            summaries.append(summarise(rec, rows))

    keys = [k for k in summaries[0] if k != "camera"]
    names = [s["camera"].replace("back-ultrawide-1-7837837934494019x", "back-uw-1.78x") for s in summaries]
    kw = max(len(k) for k in keys)
    colw = max(15, max(len(nm) for nm in names) + 1)
    lines = [" " * kw + "  " + "".join(nm.rjust(colw) for nm in names)]
    for k in keys:
        vals = [s[k] for s in summaries]
        lines.append(k.ljust(kw) + "  " + "".join(
            (f"{v:.2f}" if isinstance(v, float) else str(v)).rjust(colw) for v in vals))
    text = "\n".join(lines)
    print("\n" + text)
    (out_dir / "eye_detail_summary.txt").write_text(text + "\n")


if __name__ == "__main__":
    main()
