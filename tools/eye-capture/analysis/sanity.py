"""Step 1: check that each recording's frames, clocks and dot events can be trusted.

    analysis/.venv/bin/python analysis/sanity.py captures/<session>
"""

import argparse
import math

import numpy as np

from session import SETTLE_S, load_session, read_motion, video_pts


def angle_deg(a, b):
    a, b = np.asarray(a, float), np.asarray(b, float)
    c = np.dot(a, b) / (np.linalg.norm(a) * np.linalg.norm(b))
    return math.degrees(math.acos(max(-1.0, min(1.0, c))))


def check(rec):
    info, f, t = rec.info, rec.frames, rec.t
    r = {"camera": rec.name}

    # Frame counts: what the phone says it wrote, rows in frames.csv, packets in the video.
    pts = video_pts(rec.video)
    r["written"] = info["framesWritten"]
    r["csv_rows"] = len(t)
    r["video_frames"] = len(pts)
    r["rows_contiguous"] = bool(np.array_equal(f["frame"], np.arange(len(t))))
    r["dropped+skipped"] = info["framesDropped"] + info["framesSkipped"]

    # Frame-time gaps, and whether frames.csv times line up with the video's own timestamps.
    dt = np.diff(t) * 1000
    r["dt_median_ms"] = np.median(dt)
    r["dt_min_ms"] = dt.min()
    r["dt_max_ms"] = dt.max()
    r["gaps_over_1.5x"] = int(np.sum(dt > 1.5 * np.median(dt)))
    if len(pts) == len(t):
        r["csv_vs_video_ms"] = np.max(np.abs((t - t[0]) - (pts - pts[0]))) * 1000
    r["first_t_vs_info_ms"] = (t[0] - info["firstFrameTime"]) * 1000

    # The three phone clocks sampled together at the start, and the first frame against them.
    cc = info["clockCheck"]
    r["clock_spread_ms"] = (max(cc.values()) - min(cc.values())) * 1000
    r["first_frame_vs_clock_ms"] = (t[0] - cc["hostClock"]) * 1000

    # Page-to-phone clock offset measured before and after this recording.
    start, end = rec.segment_event("segment_start"), rec.segment_event("segment_end")
    r["offset_drift_ms"] = (end["sync"]["offset"] - start["sync"]["offset"]) * 1000
    r["rtt_ms"] = f"{start['sync']['rttMs']:.1f}/{end['sync']['rttMs']:.1f}"

    # Dots: all inside the video, how long each was shown, settled frames per dot.
    dots = rec.dots
    r["dots"] = len(dots)
    r["dots_inside_video"] = sum(1 for d in dots if d.t_on >= t[0] and d.t_off <= t[-1])
    dwell = np.array([d.t_off - d.t_on for d in dots]) * 1000
    r["dwell_ms"] = f"{dwell.min():.0f}-{dwell.max():.0f}"
    settled = [len(rec.settled_frames(d)) for d in dots]
    r["settled_frames/dot"] = f"{min(settled)}-{max(settled)}"
    ps, pe = rec.segment_event("pursuit_start"), rec.segment_event("pursuit_end")
    r["pursuit_inside_video"] = bool(ps and pe and ps["t_phone"] >= t[0] and pe["t_phone"] <= t[-1])

    # Focus and exposure during the recording (autofocus was not locked).
    lp = f["lens_position"]
    r["lens_pos"] = f"{lp.min():.3f}-{lp.max():.3f}"
    r["adjusting_focus_%"] = 100 * f["adjusting_focus"].mean()
    r["adjusting_exposure_%"] = 100 * f["adjusting_exposure"].mean()
    r["iso"] = f"{f['iso'].min():.0f}-{f['iso'].max():.0f}"
    r["shutter_ms"] = f"{1000 * f['exposure_s'].min():.1f}-{1000 * f['exposure_s'].max():.1f}"

    # Did the mount move? Gravity direction drift and peak rotation rate during the recording.
    m = read_motion(rec)
    g = np.stack([m["gravity_x"], m["gravity_y"], m["gravity_z"]], axis=1)
    r["gravity_drift_deg"] = max(angle_deg(g[0], gi) for gi in g)
    rot = np.linalg.norm(np.stack([m["rotation_x"], m["rotation_y"], m["rotation_z"]], 1), axis=1)
    r["peak_rotation_dps"] = math.degrees(rot.max())
    r["thermal_end"] = info["thermalStateAtEnd"]
    r["gravity_start"] = info["gravityAtStart"]
    return r


def fmt(v):
    if isinstance(v, float):
        return f"{v:.2f}"
    return str(v)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("session")
    args = ap.parse_args()
    meta, events, recs = load_session(args.session)
    print(f"Session {args.session}  ({meta['phone']['model']}, {meta['side']} cameras, "
          f"eyes {meta['eyesToPhoneCm']} cm from phone, settle {SETTLE_S} s)\n")
    rows = [check(r) for r in recs]
    keys = [k for k in rows[0] if k not in ("camera", "gravity_start")]
    width = max(len(k) for k in keys)
    names = [r["camera"].replace("back-ultrawide-1-7837837934494019x", "back-uw-1.78x") for r in rows]
    colw = max(14, max(len(n) for n in names) + 1)
    print(" " * width + "  " + "".join(n.rjust(colw) for n in names))
    for k in keys:
        print(k.ljust(width) + "  " + "".join(fmt(r.get(k, "")).rjust(colw) for r in rows))

    # Phone orientation between recordings, relative to the first one.
    g0 = rows[0]["gravity_start"]
    moved = [angle_deg(g0, r["gravity_start"]) for r in rows]
    print("gravity_vs_first_rec_deg".ljust(width) + "  " + "".join(f"{m:.2f}".rjust(colw) for m in moved))

    offsets = [e["sync"]["offset"] for e in events if "sync" in e]
    print(f"\nPage-to-phone offset across the whole session: {1000 * (max(offsets) - min(offsets)):.1f} ms "
          f"over {events[-1]['t_phone'] - events[0]['t_phone']:.0f} s")


if __name__ == "__main__":
    main()
