"""Before / after numbers for the switchable calibration and model options. Owner: Models.

Uses the geometric test simulator (``models_sim.py``), whose generating model deliberately
differs from what the models assume (eye radius, kappa as a rotation, biased head pose, ...).
On top of that, :data:`LANDMARK_NOISE` makes the eyeball centres behave like landmark-derived
ones: a constant per-eye error and an error that grows as the face turns (about 1 mm per 15
degrees here), which is what degrades the geometric model when the head turns.

Not a test module; ``tests/models_options_test.py`` asserts on it, and
``python tests/models_options.py`` prints the tables (degrees of true visual angle, mean over
validation samples at three head poses).
"""

from __future__ import annotations

import sys
from dataclasses import replace
from pathlib import Path

import numpy as np

sys.path.insert(0, str(Path(__file__).resolve().parent))

from models_sim import HOME, Noise, Sim, evaluate  # noqa: E402

from phonegaze import calibration as calib  # noqa: E402
from phonegaze.config import CalibrationConfig  # noqa: E402
from phonegaze.models import REGISTRY  # noqa: E402
from phonegaze.models.geometric import GeometricModel  # noqa: E402

LANDMARK_NOISE = Noise(centre_err_mm=((0.8, -0.5, 1.2), (-0.6, 0.4, -1.0)), centre_turn_mm_per_10deg=0.7)
"""Landmark-like eyeball centres (see the module docstring)."""

POSES = {"still": HOME, "moved": HOME.moved(dx=0.03, dz=0.04, yaw=8.0, pitch=6.0), "turned": HOME.moved(dx=-0.02, yaw=-15.0, pitch=-4.0)}


def _val(sim: Sim, n: int = 12, seed: int = 7) -> dict:
    return {k: sim.validation_samples(n, pose, seed=seed + i) for i, (k, pose) in enumerate(POSES.items())}


def _score(model, sim: Sim, val: dict) -> dict:
    return {k: evaluate(model, sim, v)["deg"] for k, v in val.items()}


def collect(sim: Sim, sweeps: int = 0, poses: int = 1, cfg: CalibrationConfig | None = None, pursuit: bool = False, sweep_seconds: float = 10.0, grid_spec: str = "3x3") -> tuple[list, list]:
    """A grid run (``poses`` head positions) with ``sweeps`` head-sweep dots; optionally a
    moving-dot run first. Returns ``(grid-run samples, moving-dot samples)``."""
    cfg = cfg or CalibrationConfig()
    cfg = replace(cfg, head_sweep=sweeps)
    dots = calib.grid_targets(sim.screen, grid_spec, 0.08)
    run = calib.make_run(cfg, "g", "grid", dots, sim.screen)
    extra = [HOME.moved(dx=-0.04, yaw=-7.0), HOME.moved(dx=0.03, dz=0.05, pitch=5.0)]
    pursuit_samples: list = []
    if pursuit:
        prun = calib.make_run(cfg, "p", "pursuit", calib.pursuit_targets(sim.screen), sim.screen)
        sim.pursuit(prun, HOME)
        pursuit_samples = prun.samples
    for k, pose in enumerate([HOME] + extra[: poses - 1]):
        sim.collect(dots, pose, run=run, pose_group=k)
    for t in calib.sweep_targets(sim.screen, sweeps):
        sim.sweep(t, HOME, run, seconds=sweep_seconds)
    return run.samples, pursuit_samples


def geo_factory(**opts):
    return lambda: [GeometricModel(**opts)]


def option_rows(seed: int = 1, noise: Noise | None = None) -> dict[str, dict[str, float]]:
    """Degrees per (option, head pose) for the head-movement options."""
    noise = noise or LANDMARK_NOISE
    rows: dict[str, dict[str, float]] = {}

    def run(label: str, sweeps: int, poses: int, **opts) -> None:
        sim = Sim(noise=noise, seed=seed)
        samples, _ = collect(sim, sweeps=sweeps, poses=poses)
        res = calib.fit_all(samples, sim.screen, [GeometricModel(**opts)])
        rows[label] = _score(res.models["geometric"], sim, _val(sim))

    run("grid, centre=estimator (default)", 0, 1)
    run("grid + 1 sweep, centre=estimator", 1, 1)
    run("grid + 1 sweep, centre=per_eye", 1, 1, centre="per_eye")
    run("grid + 1 sweep, centre=head", 1, 1, centre="head")
    run("grid + 3 sweeps, centre=per_eye", 3, 1, centre="per_eye")
    run("grid + 3 sweeps, centre=head", 3, 1, centre="head")
    run("grid x3 poses, centre=estimator", 0, 3)
    run("grid x3 poses, centre=per_eye", 0, 3, centre="per_eye")
    return rows


def eye_rows(seed: int = 1) -> dict[str, dict[str, float]]:
    """Eye choice when the left eye tracks badly (a gaze-dependent, non-linear iris error of up to
    20 px, as from an eyelid covering part of the iris). Plain simulator noise otherwise."""
    noise = Noise(eye_warp_px=(0.0, 20.0))
    rows = {}
    for eye in ("both", "auto", "left", "right"):
        sim = Sim(noise=noise, seed=seed)
        samples, _ = collect(sim)
        res = calib.fit_all(samples, sim.screen, [GeometricModel(eye=eye)])
        m = res.models["geometric"]
        rows[f"eye={eye}"] = _score(m, sim, _val(sim))
        if eye == "auto":
            rows.setdefault("_auto_chose", []).append(m.eye_use)  # type: ignore[union-attr, arg-type]
    return rows


def pursuit_rows(seed: int = 1) -> dict[str, dict[str, float]]:
    """The moving dot merged (or not) with a 3x3 grid. ``fit_with_options``."""
    rows = {}
    info = {}
    for merge in ("off", "auto", "on"):
        sim = Sim(noise=LANDMARK_NOISE, seed=seed)
        cfg = CalibrationConfig(pursuit_merge=merge)
        samples, ps = collect(sim, pursuit=True, cfg=cfg)
        res = calib.fit_with_options(samples, sim.screen, geo_factory(), cfg, pursuit=ps)
        rows[f"pursuit_merge={merge}"] = _score(res.models["geometric"], sim, _val(sim))
        info[merge] = res.info.get("pursuit")
    # the old way: the moving dot alone (what the moving-dot fit gave)
    sim = Sim(noise=LANDMARK_NOISE, seed=seed)
    _, ps = collect(sim, pursuit=True)
    res = calib.fit_all(ps, sim.screen, [GeometricModel()])
    rows["moving dot alone (old, not used)"] = _score(res.models["geometric"], sim, _val(sim))
    rows["_info"] = info  # type: ignore[assignment]
    return rows


def error_map_rows(seed: int = 1, kinds: tuple[str, ...] = ("off", "affine", "quadratic", "tps"), n_val: int = 9, grid_spec: str = "3x3") -> dict[str, dict[str, float]]:
    """Error map learned from ``n_val`` validation dots at the home pose, scored on other dots."""
    rows = {}
    for kind in kinds:
        sim = Sim(noise=LANDMARK_NOISE, seed=seed)
        samples, _ = collect(sim, grid_spec=grid_spec)
        res = calib.fit_all(samples, sim.screen, [GeometricModel()])
        m = res.models["geometric"]
        learn = sim.validation_samples(n_val, HOME, seed=101)
        info = calib.fit_validation_error_map(m, learn, sim.screen, CalibrationConfig(error_map=kind))
        r = _score(m, sim, _val(sim))
        rows[f"{grid_spec} grid, error_map={kind}"] = r
        if kind != "off":
            rows.setdefault("_kept", []).append(f"{kind}:{'kept' if info.get('kept') else 'dropped'}")  # type: ignore[union-attr, arg-type]
    return rows


def error_map_coarse_rows(seed: int = 1) -> dict[str, dict[str, float]]:
    """As :func:`error_map_rows` after a coarse 2x2 grid (systematic error left to correct)."""
    return error_map_rows(seed=seed, grid_spec="2x2", n_val=12)


def weighting_rows(seed: int = 1) -> dict[str, dict[str, float]]:
    rows = {}
    for mode in ("per_dot", "precision", "per_sample"):
        sim = Sim(noise=replace(LANDMARK_NOISE, p_outlier=0.06), seed=seed)
        samples, _ = collect(sim)
        res = calib.fit_with_options(samples, sim.screen, geo_factory(), CalibrationConfig(sample_weighting=mode))
        rows[f"sample_weighting={mode}"] = _score(res.models["geometric"], sim, _val(sim))
    return rows


def hybrid_rows(seed: int = 1, p_no_glint: float = 0.3) -> dict[str, dict[str, float]]:
    rows = {}
    sim = Sim(noise=replace(LANDMARK_NOISE, p_no_glint=p_no_glint), seed=seed)
    samples, _ = collect(sim)
    res = calib.fit_all(samples, sim.screen, [REGISTRY[n]() for n in ("geometric", "reflection", "blend", "hybrid")])
    val = _val(sim)
    for n, m in res.models.items():
        rows[n] = _score(m, sim, val)
    rows["_chosen"] = res.chosen  # type: ignore[assignment]
    return rows


def format_rows(rows: dict, title: str) -> str:
    lines = [f"### {title}", "", "| option | " + " | ".join(POSES) + " |", "| --- |" + " --- |" * len(POSES)]
    for k, v in rows.items():
        if k.startswith("_"):
            continue
        lines.append(f"| {k} | " + " | ".join(f"{v[p]:.2f}" for p in POSES) + " |")
    extra = {k: v for k, v in rows.items() if k.startswith("_")}
    if extra:
        lines.append("")
        lines.append(f"{extra}")
    return "\n".join(lines)


if __name__ == "__main__":
    import time

    which = sys.argv[1:] or ["centre", "eye", "pursuit", "map", "map2", "weight", "hybrid"]
    seeds = [1, 2, 3]
    fns = {"centre": (option_rows, "Eyeball centre and head sweep"), "eye": (eye_rows, "Eye choice (left eye tracks badly)"), "pursuit": (pursuit_rows, "Moving dot"), "map": (error_map_rows, "Error map (9 validation dots)"), "map2": (error_map_coarse_rows, "Error map after a 2x2 grid (12 validation dots)"), "weight": (weighting_rows, "Sample weighting (6% outlier frames)"), "hybrid": (hybrid_rows, "Reflection / geometric blends")}
    for key in which:
        fn, title = fns[key]
        t0 = time.time()
        acc: dict = {}
        for sd in seeds:
            r = fn(seed=sd)
            for k, v in r.items():
                if k.startswith("_"):
                    acc.setdefault(k, []).append(v)
                    continue
                acc.setdefault(k, {p: [] for p in POSES})
                for p in POSES:
                    acc[k][p].append(v[p])
        mean = {k: ({p: float(np.mean(x)) for p, x in v.items()} if not k.startswith("_") else v) for k, v in acc.items()}
        print(format_rows(mean, f"{title} (mean of seeds {seeds}, {time.time() - t0:.0f} s)"))
        print()
