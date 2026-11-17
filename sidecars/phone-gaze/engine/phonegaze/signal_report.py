"""Error diagnosis: why is the error what it is, per condition, in numbers. Owner: Sweep.

For each condition of a run (see ``sweep.py`` for the inputs) it answers, from the recorded
observations (stage 1 of the sweep, cached):

- **availability**: share of frames with the face, each eye, the iris fit, the reflection and a
  distance; the recording's frame rate and its gaps;
- **precision floor**: the scatter of each raw measurement within a fixation (iris centre,
  reflection, eye corners, head rotation and position, the gaze direction an estimator gives),
  converted into degrees of gaze with the measured geometry (focal length, distance, and the
  eye's ~10 mm from rotation centre to iris), so each signal's noise is in the same unit;
- **signal strength**: how much of each measurement's variation is explained by where the dot
  was (between-dot share of variance, horizontal and vertical separately), and the observed
  pixels per degree against what the camera geometry predicts;
- **ceiling versus achieved**: a flexible model fitted on ALL dots, validation included (a lower
  bound on what any calibration could reach with this signal), next to the held-out error;
- **bias versus jitter**: constant offset, scale error, screen-region pattern, left eye versus
  right eye, drift over the session, and how much the head moved in each phase;
- a plain-language **verdict** naming the dominant limit and the most promising next step.

Command line::

    python -m phonegaze diagnose <run id | run file | folder of recordings | recording>
        [--vision auto|real|oracle] [--config PATH] [--out DIR] [--json]

The sweep runs the same diagnosis on its winner and puts it in its leaderboard and summary.
Nothing here has seen a real recording yet.
"""

from __future__ import annotations

import argparse
import copy
import json
import logging
import math
import sys
from pathlib import Path
from typing import Any

import numpy as np

from .config import Config
from .lab import LabError
from .types import Observation, _jsonable

log = logging.getLogger(__name__)

SETTLE_S = 0.3
"""Frames this long after a dot appears are left out of the within-fixation numbers."""

THRESHOLDS = {
    "availability": 0.8,  # usable-eye share below this is a problem
    "noise_deg": 1.0,  # within-fixation scatter of the main signal above this is a problem
    "weak_signal": 0.6,  # between-dot share of variance below this is a problem
    "offset_deg": 0.8,  # constant offset above this (and most of the error) is a problem
    "head_mm": 30.0,  # head movement within a phase or between phases above this is notable
    "drift_deg_per_min": 0.5,
    "scale": 0.2,  # |slope - 1| above this
}


# --------------------------------------------------------------------------------------------
# Small helpers
# --------------------------------------------------------------------------------------------


def _eye_radius_m() -> float:
    from .models.features import EYE_IRIS_DISTANCE_M

    return float(EYE_IRIS_DISTANCE_M)


def _px_per_deg(obs: Observation) -> float | None:
    """Pixels the iris centre moves per degree of eye rotation, from the camera geometry."""
    if obs.intrinsics is None or not obs.distance:
        return None
    fx = float(obs.intrinsics.fx)
    return fx * _eye_radius_m() * math.pi / 180.0 / float(obs.distance)


def _median(v: list[float]) -> float | None:
    v = [x for x in v if x is not None and math.isfinite(x)]
    return float(np.median(v)) if v else None


def _r(v: Any, nd: int = 3) -> Any:
    if isinstance(v, float):
        return round(v, nd) if math.isfinite(v) else None
    if isinstance(v, dict):
        return {k: _r(x, nd) for k, x in v.items()}
    if isinstance(v, (list, tuple)):
        return [_r(x, nd) for x in v]
    return v


def _head_angles_deg(o: Observation) -> tuple[float, float] | None:
    from .models.features import head_angles

    a = head_angles(o)
    return None if a is None else (math.degrees(a[0]), math.degrees(a[1]))


def _gaze_angles_deg(o: Observation, side: str) -> tuple[float, float] | None:
    from .models.features import dir_angles, unit

    g = o.eye(side).gaze_dir
    if g is None:
        return None
    u = unit(np.asarray(g, float))
    if u is None:
        return None
    a = dir_angles(u)
    return math.degrees(a[0]), math.degrees(a[1])


def _feature(o: Observation, name: str, side: str) -> tuple[float, float] | None:
    """A raw measurement of one eye (pixels, or degrees for angles)."""
    e = o.eye(side)
    if name == "iris":
        return None if e.iris_center is None or e.blink else (float(e.iris_center[0]), float(e.iris_center[1]))
    if name == "reflection":
        return None if e.reflection_center is None else (float(e.reflection_center[0]), float(e.reflection_center[1]))
    if name == "corners":
        if e.inner_corner is None or e.outer_corner is None:
            return None
        return ((e.inner_corner[0] + e.outer_corner[0]) / 2.0, (e.inner_corner[1] + e.outer_corner[1]) / 2.0)
    if name == "iris_minus_corners":
        a, b = _feature(o, "iris", side), _feature(o, "corners", side)
        return None if a is None or b is None else (a[0] - b[0], a[1] - b[1])
    if name == "iris_minus_reflection":
        a, b = _feature(o, "iris", side), _feature(o, "reflection", side)
        return None if a is None or b is None else (a[0] - b[0], a[1] - b[1])
    if name == "gaze_dir":
        return _gaze_angles_deg(o, side)
    raise ValueError(name)


PIXEL_SIGNALS = ("iris", "reflection", "corners", "iris_minus_corners", "iris_minus_reflection")
ANGLE_SIGNALS = ("gaze_dir",)


# --------------------------------------------------------------------------------------------
# The parts of the report
# --------------------------------------------------------------------------------------------


def availability(cond: Any, os_: Any) -> dict[str, Any]:
    obs: list[Observation] = os_.obs
    n = len(obs)
    out: dict[str, Any] = {"frames": n}
    if n:

        def share(fn: Any) -> float:
            return sum(1 for o in obs if fn(o)) / n

        out["face"] = share(lambda o: o.face_rect is not None or o.head_rotation is not None or o.left.found or o.right.found)
        out["left_eye"] = share(lambda o: bool(o.left.found))
        out["right_eye"] = share(lambda o: bool(o.right.found))
        out["either_eye"] = share(lambda o: bool(o.left.found or o.right.found))
        out["iris_fit"] = share(lambda o: o.left.iris_center is not None or o.right.iris_center is not None)
        out["iris_edge"] = share(lambda o: any(o.provenance.get(f"{s}.iris_center") == "iris_edge" for s in ("left", "right")))
        out["reflection"] = share(lambda o: o.left.reflection_center is not None or o.right.reflection_center is not None)
        out["distance"] = share(lambda o: bool(o.distance))
        out["blink"] = share(lambda o: bool(o.left.blink and o.right.blink))
        out["gaze_dir"] = share(lambda o: o.left.gaze_dir is not None or o.right.gaze_dir is not None)
        out["usable"] = share(lambda o: any((o.eye(s).iris_center is not None or o.eye(s).gaze_dir is not None) and not o.eye(s).blink for s in ("left", "right")))
    seg = getattr(cond, "segment", None)
    if seg is not None and seg.n_rows > 2:
        dt = np.diff(np.asarray(seg.times, float))
        dt = dt[np.isfinite(dt) & (dt > 0)]
        if len(dt):
            med = float(np.median(dt))
            out["fps"] = 1.0 / med if med > 0 else None
            gaps = dt[dt > 3 * med]
            out["gaps"] = int(len(gaps))
            out["longest_gap_s"] = float(gaps.max()) if len(gaps) else 0.0
            out["seconds"] = float(seg.times[-1] - seg.times[0])
    return out


def _dot_frames(cond: Any, os_: Any, phases: tuple[str, ...]) -> list[tuple[Any, list[Observation]]]:
    from .sweep import _window

    return [(d, _window(os_, d.t0 + SETTLE_S, d.t1)) for d in cond.dots if d.phase in phases]


def precision_floor(cond: Any, os_: Any) -> dict[str, Any]:
    """Median over dots of each measurement's within-dot standard deviation, in its own unit and
    in degrees of gaze."""
    dots = _dot_frames(cond, os_, ("calibration", "poses", "validation"))
    ppd = _median([_px_per_deg(o) for _, fr in dots for o in fr[::5]])
    dist = _median([o.distance for _, fr in dots for o in fr[::5] if o.distance])
    out: dict[str, Any] = {"px_per_deg_geometry": ppd, "distance_m": dist, "eye_radius_mm": _eye_radius_m() * 1000.0, "signals": {}}
    for name in PIXEL_SIGNALS + ANGLE_SIGNALS:
        sds: dict[str, list[float]] = {"x": [], "y": []}
        for _, fr in dots:
            for side in ("left", "right"):
                vals = [v for v in (_feature(o, name, side) for o in fr) if v is not None]
                if len(vals) >= 4:
                    a = np.array(vals, float)
                    sds["x"].append(float(np.std(a[:, 0], ddof=1)))
                    sds["y"].append(float(np.std(a[:, 1], ddof=1)))
        if not sds["x"]:
            continue
        sx, sy = _median(sds["x"]), _median(sds["y"])
        unit = "deg" if name in ANGLE_SIGNALS else "px"
        e: dict[str, Any] = {"unit": unit, "sd_x": sx, "sd_y": sy}
        if unit == "deg":
            e["deg_x"], e["deg_y"] = sx, sy
        elif ppd:
            e["deg_x"], e["deg_y"] = sx / ppd, sy / ppd
        if e.get("deg_x") is not None:
            e["deg"] = float(math.hypot(e["deg_x"], e["deg_y"]))
        out["signals"][name] = e
    # head pose
    rot: list[float] = []
    pos: list[float] = []
    for _, fr in dots:
        angs = [a for a in (_head_angles_deg(o) for o in fr) if a is not None]
        if len(angs) >= 4:
            a = np.array(angs)
            rot.append(float(math.hypot(np.std(a[:, 0], ddof=1), np.std(a[:, 1], ddof=1))))
        ps = [np.asarray(o.head_position, float) * 1000.0 for o in fr if o.head_position is not None]
        if len(ps) >= 4:
            pos.append(float(np.linalg.norm(np.std(np.array(ps), axis=0, ddof=1))))
    if rot:
        out["signals"]["head_rotation"] = {"unit": "deg", "sd": _median(rot), "deg": _median(rot)}
    if pos:
        mm = _median(pos)
        out["signals"]["head_position"] = {"unit": "mm", "sd": mm, "deg": math.degrees(math.atan2(mm, (dist or 0.6) * 1000.0)) if mm is not None else None}
    main = out["signals"].get("iris_minus_corners") or out["signals"].get("iris") or out["signals"].get("gaze_dir")
    out["main_signal"] = next((k for k in ("iris_minus_corners", "iris", "gaze_dir") if k in out["signals"]), None)
    out["main_deg"] = main.get("deg") if main else None
    return out


def _target_angles(cond: Any, d: Any, dist_m: float) -> tuple[float, float] | None:
    mm = cond.screen.mm_per_point
    if mm is None:
        return None
    x = (d.x - cond.screen.width / 2) * mm[0]
    y = (d.y - cond.screen.height / 2) * mm[1]
    return math.degrees(math.atan2(x, dist_m * 1000.0)), math.degrees(math.atan2(y, dist_m * 1000.0))


def signal_strength(cond: Any, os_: Any, floor: dict[str, Any]) -> dict[str, Any]:
    """Between-dot share of variance per measurement and axis (head still: the first head
    position's dots and validation), and observed pixels per degree versus the geometry."""
    dots = [(d, fr) for d, fr in _dot_frames(cond, os_, ("calibration", "validation")) if d.pose_group == 0]
    dist = floor.get("distance_m") or 0.6
    out: dict[str, Any] = {"signals": {}, "px_per_deg_geometry": floor.get("px_per_deg_geometry")}
    names = list(PIXEL_SIGNALS + ANGLE_SIGNALS) + ["head_rotation"]
    for name in names:
        res: dict[str, Any] = {}
        for ax, k in (("horizontal", 0), ("vertical", 1)):
            per_side = []
            for side in ("left", "right") if name != "head_rotation" else ("head",):
                means, tang, allv, groups = [], [], [], []
                for gi, (d, fr) in enumerate(dots):
                    if name == "head_rotation":
                        vals = [a[k] for a in (_head_angles_deg(o) for o in fr) if a is not None]
                    else:
                        vals = [v[k] for v in (_feature(o, name, side) for o in fr) if v is not None]
                    ta = _target_angles(cond, d, dist)
                    if len(vals) < 3 or ta is None:
                        continue
                    means.append(float(np.mean(vals)))
                    tang.append(ta[k])
                    allv += vals
                    groups += [gi] * len(vals)
                if len(means) < 4:
                    continue
                a = np.array(allv)
                total = float(np.var(a))
                g = np.array(groups)
                within = float(np.mean([np.var(a[g == i]) for i in np.unique(g)]))
                share = 1.0 - within / total if total > 0 else 0.0
                t = np.array(tang)
                if np.ptp(t) < 1.0:
                    continue
                slope = float(np.polyfit(t, np.array(means), 1)[0])
                r2 = float(np.corrcoef(t, np.array(means))[0, 1] ** 2) if np.std(means) > 0 else 0.0
                per_side.append({"side": side, "explained": max(0.0, share), "r2_with_target": r2, "per_deg": abs(slope)})
            if per_side:
                res[ax] = {
                    "explained": float(np.mean([p["explained"] for p in per_side])),
                    "r2_with_target": float(np.mean([p["r2_with_target"] for p in per_side])),
                    "per_deg": float(np.mean([p["per_deg"] for p in per_side])),
                    "sides": per_side,
                }
        if res:
            res["unit"] = "deg" if name in ANGLE_SIGNALS or name == "head_rotation" else "px"
            out["signals"][name] = res
    ppd = floor.get("px_per_deg_geometry")
    main = out["signals"].get("iris_minus_corners") or out["signals"].get("iris")
    if main and ppd:
        out["sensitivity_vs_geometry"] = {ax: main[ax]["per_deg"] / ppd for ax in ("horizontal", "vertical") if ax in main}
    out["main_signal"] = "iris_minus_corners" if "iris_minus_corners" in out["signals"] else ("iris" if "iris" in out["signals"] else ("gaze_dir" if "gaze_dir" in out["signals"] else None))
    return out


def head_movement(cond: Any, os_: Any) -> dict[str, Any]:
    """Per phase: how far the head moved (5th-95th percentile range of the position, mm, and of
    the rotation, degrees), and how far its median moved from the calibration phase."""
    from .sweep import _window

    out: dict[str, Any] = {}
    centre: dict[str, np.ndarray] = {}
    for ph in ("calibration", "poses", "validation", "pursuit"):
        if ph == "pursuit":
            if cond.pursuit is None:
                continue
            fr = _window(os_, float(cond.pursuit[0, 0]), float(cond.pursuit[-1, 0]))
        else:
            fr = [o for d in cond.dots if d.phase == ph for o in _window(os_, d.t0, d.t1)]
        ps = np.array([np.asarray(o.head_position, float) * 1000.0 for o in fr if o.head_position is not None])
        angs = np.array([a for a in (_head_angles_deg(o) for o in fr) if a is not None])
        e: dict[str, Any] = {"frames": len(fr)}
        if len(ps) >= 5:
            lo, hi = np.percentile(ps, [5, 95], axis=0)
            e["range_mm"] = [float(v) for v in hi - lo]
            e["moved_mm"] = float(np.linalg.norm(hi - lo))
            centre[ph] = np.median(ps, axis=0)
        if len(angs) >= 5:
            lo, hi = np.percentile(angs, [5, 95], axis=0)
            e["rotation_range_deg"] = [float(v) for v in hi - lo]
        out[ph] = e
    if "calibration" in centre:
        for ph, c in centre.items():
            if ph != "calibration":
                out[ph]["shift_from_calibration_mm"] = float(np.linalg.norm(c - centre["calibration"]))
    return out


def ceiling(cond: Any, os_: Any, base: Config, vision: dict[str, Any]) -> dict[str, Any]:
    """In-sample error of flexible models fitted on every dot (validation included)."""
    from dataclasses import replace

    from . import calibration as calib
    from .models import build_models
    from .sweep import build_samples, condition_config

    cfg = condition_config(base, cond, vision, {"model": "auto"})
    ss = build_samples(cond, os_, cfg)
    allsamp = ss["calibration"] + ss["poses"] + [replace(s, kind="grid") for s in ss["validation"]]
    if len({s.dot_id for s in allsamp}) < 5:
        return {"error": "too few usable dots"}
    out: dict[str, Any] = {}
    for name in ("ridge", "kernel", "geometric"):
        m = copy.deepcopy(cfg.models)
        m.candidates = [name]
        try:
            res = calib.fit_all(allsamp, cond.screen, build_models(m))
        except Exception as exc:  # noqa: BLE001
            out[name] = {"error": str(exc)}
            continue
        rep = res.reports[0] if res.reports else None
        if rep is not None and rep.ok:
            out[name] = {"train_deg": rep.train_error_deg, "loo_deg": rep.loo_error_deg}
    ok = [v["train_deg"] for v in out.values() if isinstance(v, dict) and v.get("train_deg") is not None]
    out["ceiling_deg"] = min(ok) if ok else None
    return out


def bias(cond: Any, row: dict[str, Any] | None) -> dict[str, Any]:
    """From a setup's validation dots: constant offset, scale, region pattern, drift."""
    from .sweep import breakdown

    out: dict[str, Any] = {}
    per = (row or {}).get("per_dot") or []
    if len(per) < 3:
        return {"error": "too few validation dots were predicted"}
    err = np.array([p[1] for p in per], float)
    dx = np.array([p[2] for p in per], float)
    dy = np.array([p[3] for p in per], float)
    off = (float(np.mean(dx)), float(np.mean(dy)))
    out["accuracy_deg"] = float(np.mean(err))
    out["offset_deg"] = list(off)
    out["offset_size_deg"] = float(math.hypot(*off))
    resid = np.hypot(dx - off[0], dy - off[1])
    out["error_without_offset_deg"] = float(np.mean(resid))
    out["offset_share"] = 1.0 - out["error_without_offset_deg"] / out["accuracy_deg"] if out["accuracy_deg"] > 0 else 0.0
    b = breakdown(row or {}, cond.screen)
    out["horizontal_deg"], out["vertical_deg"], out["regions"] = b["horizontal_deg"], b["vertical_deg"], b["regions"]
    mm = cond.screen.mm_per_point
    dist = 0.6
    if mm is not None:
        tx = np.array([math.degrees(math.atan2((p[4] - cond.screen.width / 2) * mm[0], dist * 1000.0)) for p in per])
        ty = np.array([math.degrees(math.atan2((p[5] - cond.screen.height / 2) * mm[1], dist * 1000.0)) for p in per])
        sc = {}
        for ax, t, d in (("horizontal", tx, dx), ("vertical", ty, dy)):
            if np.ptp(t) >= 2.0:
                sc[ax] = float(np.polyfit(t, t + d, 1)[0])
        out["scale"] = sc
    t = np.array([p[6] for p in per], float)
    if np.ptp(t) > 10:
        mins = (t - t.min()) / 60.0
        out["drift_deg_per_min"] = [float(np.polyfit(mins, dx, 1)[0]), float(np.polyfit(mins, dy, 1)[0])]
        out["validation_minutes"] = float(mins.max())
    out["precision_deg"] = (row or {}).get("prec_deg")
    return out


def eye_comparison(cond: Any, os_: Any, base: Config, vision: dict[str, Any], fit: dict[str, Any]) -> dict[str, Any]:
    """The same setup with only the left eye, then only the right eye."""
    from .lab import _blank_eye
    from .sweep import ObsSet, evaluate

    out: dict[str, Any] = {}
    for side in ("left", "right"):
        blanked = ObsSet(t=os_.t, obs=[_blank_eye(o, side) for o in os_.obs], stats=os_.stats)
        try:
            r = evaluate(cond, blanked, base, vision, fit)
        except Exception as exc:  # noqa: BLE001
            out[side] = {"error": str(exc)}
            continue
        out[side] = {"acc_deg": r.get("acc_deg"), "coverage": r.get("coverage"), "error": r.get("error")}
    return out


# --------------------------------------------------------------------------------------------
# The verdict
# --------------------------------------------------------------------------------------------


def verdict(d: dict[str, Any]) -> tuple[str, str, list[dict[str, Any]]]:
    """``(verdict, next step, findings)``: every finding has a rough size in degrees; the
    largest is the verdict."""
    T = THRESHOLDS
    findings: list[dict[str, Any]] = []
    av = d.get("availability") or {}
    fl = d.get("precision_floor") or {}
    st = d.get("signal_strength") or {}
    ce = d.get("ceiling") or {}
    bi = d.get("bias") or {}
    hm = d.get("head") or {}
    ach = d.get("achieved_deg")
    usable = av.get("usable")
    if usable is not None and usable < T["availability"]:
        what = "eyes" if (av.get("either_eye") or 0) < T["availability"] else "an iris measurement"
        findings.append(
            {
                "kind": "availability",
                "size": (1 - usable) * 6.0,
                "text": f"{what} were found in only {usable:.0%} of frames (face {av.get('face', 0):.0%}, left eye {av.get('left_eye', 0):.0%}, right eye {av.get('right_eye', 0):.0%})",
                "next": "make the eyes easy to find first: check the Aim page framing, more light, a lower zoom or estimators.face_confidence 0.15 with face_tiles on, then record this setup again",
            }
        )
    main = fl.get("main_deg")
    if main is not None and main > T["noise_deg"]:
        sig = {"iris_minus_corners": "the iris measurement (relative to the eye corners)", "iris": "the iris measurement", "gaze_dir": "the measured gaze direction"}.get(fl.get("main_signal"), "the main measurement")
        findings.append({"kind": "noise", "size": main, "text": f"{sig} is too noisy: {main:.1f} degrees of jitter within a fixation", "next": "more pixels and less blur on the eye: zoom in or move closer, more light or a shorter shutter (lens.max_exposure_ms 8-16), estimators.iris_fit circle; filters.preset steady hides jitter but not offsets"})
    main_ss = (st.get("signals") or {}).get(st.get("main_signal") or "")
    if main_ss:
        for ax in ("horizontal", "vertical"):
            e = (main_ss.get(ax) or {}).get("explained")
            if e is not None and e < T["weak_signal"]:
                eyelid = " (eyelids cover the top of the iris)" if ax == "vertical" else ""
                findings.append(
                    {
                        "kind": f"weak_{ax}",
                        "size": (1 - e) * 4.0,
                        "text": f"the {ax} iris signal barely follows the dot: where the dot was explains only {e:.0%} of its variation{eyelid}",
                        "next": "estimators.iris_lid_mask_upper_deg 45 and calibration.layout edges for more vertical range" if ax == "vertical" else "more eye detail (zoom) or a different estimator chain; check the Tuning page's iris fit",
                    }
                )
    if bi.get("offset_size_deg") is not None and bi["offset_size_deg"] > T["offset_deg"] and (bi.get("offset_share") or 0) > 0.4:
        ox, oy = bi["offset_deg"]
        dirn = ", ".join(x for x in (("right" if ox > 0 else "left") if abs(ox) > 0.3 else "", ("below" if oy > 0 else "above") if abs(oy) > 0.3 else "") if x)
        findings.append(
            {
                "kind": "offset",
                "size": bi["offset_size_deg"],
                "text": f"a constant offset of {bi['offset_size_deg']:.1f} degrees ({dirn or 'small'} of the dots) on validation that the calibration did not have: something moved between calibrating and validating",
                "next": "Quick refine after calibrating (calibration.refine_points 1-3) or calibration.drift_correction; keep the phone and chair fixed between calibration and use",
            }
        )
    moved = max([v.get("moved_mm") or 0.0 for v in hm.values() if isinstance(v, dict)] + [v.get("shift_from_calibration_mm") or 0.0 for k, v in hm.items() if isinstance(v, dict) and k == "validation"] or [0.0])
    gap = (ach - ce["ceiling_deg"]) if ach is not None and ce.get("ceiling_deg") is not None else None
    if moved > T["head_mm"]:
        cross = d.get("cross_pose_deg")
        size = max(gap or 0.0, (cross or 0.0) - (ce.get("ceiling_deg") or 0.0), moved / 40.0)
        findings.append(
            {
                "kind": "head",
                "size": size,
                "text": f"the head moved {moved:.0f} mm" + (f" and the model loses {gap:.1f} degrees to it on validation" if gap is not None and gap > 0.5 else "") + ": the signal is fine but the model does not generalise across head positions" * bool(gap is not None and gap > 0.5 and (main or 0) < T["noise_deg"]),
                "next": "calibrate from several head positions (the poses block; calibration.pose_rounds 3) with the geometric model and models.eyeball_centre per_eye, or keep the head still (a chin rest or headrest)",
            }
        )
    elif gap is not None and gap > 1.0 and (ce.get("ceiling_deg") or 0) < 0.6 * ach:
        findings.append({"kind": "generalisation", "size": gap, "text": f"the signal could reach {ce['ceiling_deg']:.1f} degrees but calibration reaches only {ach:.1f}: the limit is the calibration, not the signal", "next": "more calibration dots (calibration.grid 4x4), the poses block, and pin the model the sweep ranked first"})
    h, v = bi.get("horizontal_deg"), bi.get("vertical_deg")
    if h is not None and v is not None and v > 1.5 * h and v - h > 0.7:
        findings.append({"kind": "vertical", "size": v - h, "text": f"vertical is the problem: {v:.1f} degrees up/down against {h:.1f} sideways (eyelids, or too little vertical range in the iris image)", "next": "estimators.iris_lid_mask_upper_deg 45, the phone lower so it looks up at the eyes, calibration.layout edges"})
    elif h is not None and v is not None and h > 1.5 * v and h - v > 0.7:
        findings.append({"kind": "horizontal", "size": h - v, "text": f"horizontal is the problem: {h:.1f} degrees sideways against {v:.1f} up/down", "next": "check the eye corners on the Tuning page; models.eye left or right if one eye is worse"})
    dr = bi.get("drift_deg_per_min")
    if dr and bi.get("validation_minutes"):
        rate = math.hypot(*dr)
        if rate > T["drift_deg_per_min"]:
            findings.append({"kind": "drift", "size": rate * bi["validation_minutes"], "text": f"the error drifts by {rate:.1f} degrees per minute during validation", "next": "calibration.drift_correction on; keep the phone still; check whether the head slid down"})
    sc = bi.get("scale") or {}
    for ax, s in sc.items():
        if abs(s - 1) > T["scale"]:
            findings.append({"kind": f"scale_{ax}", "size": abs(s - 1) * 3.0, "text": f"{ax} scale is off: the pointer covers {s:.0%} of the distance the eyes moved", "next": "more dots towards the edges (calibration.layout edges) and calibration.error_map affine"})
    eyes = d.get("eyes") or {}
    la, ra = (eyes.get("left") or {}).get("acc_deg"), (eyes.get("right") or {}).get("acc_deg")
    if la is not None and ra is not None and abs(la - ra) > 1.0 and max(la, ra) > 1.5 * min(la, ra):
        good = "left" if la < ra else "right"
        findings.append({"kind": "eye", "size": abs(la - ra) / 2, "text": f"one eye is much worse: left alone {la:.1f}, right alone {ra:.1f} degrees", "next": f"models.eye {good} (geometric), and look at the other eye on the Tuning page"})
    findings.sort(key=lambda f: -f["size"])
    if not findings:
        acc = bi.get("accuracy_deg", ach)
        return (f"no single dominant limit: {acc:.1f} degrees accuracy, {(bi.get('precision_deg') or 0):.1f} precision, eyes found in {(usable or 0):.0%} of frames" if acc is not None else "nothing stands out, but too little was scored to say more", "record this setup again to see whether the numbers hold; then sweep the next physical change", [])
    top = findings[0]
    return top["text"][0].upper() + top["text"][1:], top["next"][0].upper() + top["next"][1:], findings


# --------------------------------------------------------------------------------------------
# Putting it together
# --------------------------------------------------------------------------------------------


def diagnose_condition(cond: Any, os_: Any, base: Config, vision: dict[str, Any], row: dict[str, Any] | None, fit: dict[str, Any] | None = None) -> dict[str, Any]:
    """Every part of the report for one condition; ``row`` is the held-out result of the setup
    to explain (the sweep's winner, or the defaults)."""
    d: dict[str, Any] = {"id": cond.id, "label": cond.label, "camera_id": cond.camera_id, "zoom": cond.zoom, "vision": vision, "setup": None}
    d["availability"] = availability(cond, os_)
    d["precision_floor"] = precision_floor(cond, os_)
    d["signal_strength"] = signal_strength(cond, os_, d["precision_floor"])
    d["head"] = head_movement(cond, os_)
    try:
        d["ceiling"] = ceiling(cond, os_, base, vision)
    except Exception as exc:  # noqa: BLE001
        d["ceiling"] = {"error": f"{type(exc).__name__}: {exc}"}
    if row is not None and not row.get("error"):
        from .sweep import fit_name

        d["setup"] = fit_name(row.get("fit") or {})
        d["achieved_deg"] = row.get("acc_deg")
        d["cross_pose_deg"] = row.get("cross_pose_deg")
        d["bias"] = bias(cond, row)
        if fit is not None:
            d["eyes"] = eye_comparison(cond, os_, base, vision, fit)
    else:
        d["bias"] = {"error": (row or {}).get("error") or "no setup could be scored"}
    d["verdict"], d["next_step"], d["findings"] = verdict(d)
    return _r(d)


def diagnose_sweep(sw: Any, board: dict[str, Any]) -> dict[str, Any]:
    """The diagnosis of each condition of a finished sweep, explaining its winner."""
    from .sweep import observe, top_by_validation, vision_space

    out: dict[str, Any] = {"conditions": []}
    for cid, cond in sw.conds.items():
        top = top_by_validation(sw, cid, 1)
        row = top[0] if top else None
        vision = (row or {}).get("vision_def") or vision_space(cond, sw.vision_mode)[0]
        try:
            os_ = observe(cond, vision, sw.base, sw.cache_dir, sw.every)
        except LabError as exc:
            out["conditions"].append({"id": cid, "label": cond.label, "verdict": f"could not read the observations: {exc}", "next_step": "check the recording", "findings": []})
            continue
        out["conditions"].append(diagnose_condition(cond, os_, sw.base, vision, row, (row or {}).get("fit")))
    return out


def format_text(diag: dict[str, Any]) -> str:
    L = []
    for d in diag.get("conditions", []):
        L.append(f"{d['label']} [{d.get('camera_id', '?')} {d.get('zoom') or '?'}x]")
        L.append(f"  why: {d['verdict']}")
        L.append(f"  next: {d['next_step']}")
        av = d.get("availability") or {}
        if av.get("frames"):
            L.append(f"  found: face {av.get('face', 0):.0%}, left eye {av.get('left_eye', 0):.0%}, right eye {av.get('right_eye', 0):.0%}, iris {av.get('iris_fit', 0):.0%}, reflection {av.get('reflection', 0):.0%}; {_fmt(av.get('fps'), 1)} fps, {av.get('gaps', 0)} gap(s), longest {_fmt(av.get('longest_gap_s'), 2)} s")
        fl = d.get("precision_floor") or {}
        sig = fl.get("signals") or {}
        if sig:
            L.append("  jitter within a fixation (deg of gaze): " + ", ".join(f"{k} {_fmt(v.get('deg'))}" for k, v in sig.items() if v.get("deg") is not None) + f"  [{_fmt(fl.get('px_per_deg_geometry'))} px/deg predicted]")
        ss = d.get("signal_strength") or {}
        m = (ss.get("signals") or {}).get(ss.get("main_signal") or "")
        if m:
            L.append(f"  {ss['main_signal']} follows the dot: horizontal {_pct((m.get('horizontal') or {}).get('explained'))}, vertical {_pct((m.get('vertical') or {}).get('explained'))} of its variation; sensitivity vs geometry " + ", ".join(f"{k} {_fmt(v)}x" for k, v in (ss.get("sensitivity_vs_geometry") or {}).items()))
        ce = d.get("ceiling") or {}
        if ce.get("ceiling_deg") is not None or d.get("achieved_deg") is not None:
            L.append(f"  ceiling (fit on every dot) {_fmt(ce.get('ceiling_deg'))} vs held-out {_fmt(d.get('achieved_deg'))}" + (f", cross-pose {_fmt(d.get('cross_pose_deg'))}" if d.get("cross_pose_deg") is not None else ""))
        bi = d.get("bias") or {}
        if bi.get("accuracy_deg") is not None:
            L.append(f"  bias: offset {_fmt(bi.get('offset_size_deg'))} ({_pct(bi.get('offset_share'))} of the error), H {_fmt(bi.get('horizontal_deg'))} V {_fmt(bi.get('vertical_deg'))}, scale " + ", ".join(f"{k} {_fmt(v)}" for k, v in (bi.get("scale") or {}).items()))
        hm = d.get("head") or {}
        mv = ", ".join(f"{k} {_fmt(v.get('moved_mm'), 0)} mm" for k, v in hm.items() if isinstance(v, dict) and v.get("moved_mm") is not None)
        if mv:
            L.append(f"  head moved: {mv}")
        ey = d.get("eyes") or {}
        if ey:
            L.append(f"  one eye only: left {_fmt((ey.get('left') or {}).get('acc_deg'))}, right {_fmt((ey.get('right') or {}).get('acc_deg'))}")
        for f in (d.get("findings") or [])[1:3]:
            L.append(f"  also: {f['text']}")
    return "\n".join(L)


def _fmt(v: Any, nd: int = 2) -> str:
    return "-" if v is None or (isinstance(v, float) and not math.isfinite(v)) else f"{v:.{nd}f}"


def _pct(v: Any) -> str:
    return "-" if v is None else f"{v:.0%}"


def main(argv: list[str] | None = None) -> int:
    """``python -m phonegaze diagnose TARGET``"""
    from .lab import build_config, quiet_native_logs
    from .sweep import SweepError, evaluate, observe, resolve, safe_name, sweeps_dir, vision_space

    argv = list(sys.argv[1:] if argv is None else argv)
    if argv and argv[0] == "diagnose":
        argv = argv[1:]
    p = argparse.ArgumentParser(prog="python -m phonegaze diagnose", description="Why is the error what it is: availability, noise, signal strength, ceiling, bias, per condition (see docs/SWEEP.md).")
    p.add_argument("target", help="a collection run id, a run file, a folder of recordings, or one recording")
    p.add_argument("--vision", choices=["auto", "real", "oracle"], default="auto")
    p.add_argument("--config", help="config file (default ~/.phonegaze/config.json)")
    p.add_argument("--out", help="output folder (default <recordings>/sweeps/<name>)")
    p.add_argument("--json", action="store_true")
    p.add_argument("--log-level", default="WARNING")
    args = p.parse_args(argv)
    quiet_native_logs()
    logging.basicConfig(level=getattr(logging, str(args.log_level).upper(), logging.WARNING), format="%(levelname)s %(name)s: %(message)s")
    try:
        cfg, _ = build_config(args.config, None, None)
        inputs = resolve(args.target, cfg)
        out = Path(args.out).expanduser() if args.out else sweeps_dir(inputs.root) / safe_name(inputs.name)
        cache = out.parent / "cache"
        diag: dict[str, Any] = {"name": inputs.name, "conditions": [], "notes": inputs.notes}
        for cond in inputs.conditions:
            vision = vision_space(cond, args.vision)[0]
            print(f"{cond.label}: reading observations ({vision.get('chain')})", file=sys.stderr, flush=True)
            try:
                os_ = observe(cond, vision, cfg, cache, int(cfg.lab.every))
            except SweepError as exc:
                diag["conditions"].append({"id": cond.id, "label": cond.label, "verdict": f"could not read the observations: {exc}", "next_step": "check the recording", "findings": []})
                continue
            fit = {"model": "auto"}
            row = evaluate(cond, os_, cfg, vision, fit)
            diag["conditions"].append(diagnose_condition(cond, os_, cfg, vision, row, fit))
        out.mkdir(parents=True, exist_ok=True)
        (out / "diagnosis.json").write_text(json.dumps(_jsonable(diag), indent=2) + "\n")
        text = format_text(diag)
        (out / "diagnosis.txt").write_text(text + "\n")
    except LabError as exc:
        print(f"diagnose: {exc}", file=sys.stderr)
        return 2
    except KeyboardInterrupt:
        return 130
    except OSError as exc:
        print(f"diagnose: {exc}", file=sys.stderr)
        return 2
    if args.json:
        print(json.dumps(_jsonable(diag), indent=2))
    else:
        print(text)
        print(f"\nWritten: {out / 'diagnosis.json'}\n         {out / 'diagnosis.txt'}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
