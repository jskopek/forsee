"""Parameter sweeps and A/B tests on recorded sessions, with honest hold-out. Owner: Lab.

``python -m phonegaze tune SESSION`` tries settings (estimator settings, crop size, model
regularisation, which estimators, cleaning, filters, which eye...) on recorded data and reports
which are best by HELD-OUT error. ``python -m phonegaze ab SESSION --a X --b Y`` scores two presets
on the same data and says whether the difference is larger than the noise.

How "held out" is kept honest (nested hold-out):

- The grid dots are split into ``lab.folds`` folds (the same split for every trial). For each
  fold, every trial is fitted on the OTHER folds; its gaze model is chosen there (as live
  calibration would) by leave-one-dot-out inside those folds; then it predicts the held-out fold.
- The winner of each fold is chosen on the other folds only, and scored on the held-out fold.
  The mean of those is the **nested estimate**: what you can expect from "tune, then use the
  winner", without the optimism of picking the best of many noisy scores. The report shows it next
  to the winner's own score; a large gap means the sweep is fitting noise.
- Differences are paired per dot (both settings predict the same held-out dots). A bootstrap over
  dots gives a 95 % interval and a sign-flip test a p-value; a difference whose interval includes
  zero is "not larger than the noise".

Trials: ``--sweep path=v1,v2`` (all combinations of every --sweep), ``--group NAME`` (one setting
at a time, from :data:`GROUPS`) and ``--auto PREFIX`` (one setting at a time, values made from each
numeric, boolean or choice setting under PREFIX: half, default, double...). The base trial (no
changes) is always included. ``--save NAME`` writes the winner as a preset the Lab page and the
Experiments page can load.
"""

from __future__ import annotations

import argparse
import itertools
import json
import logging
import math
import random
import sys
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

import numpy as np

from .config import Config, settings
from .lab import (
    LabError,
    Source,
    add_common_args,
    apply_changes,
    apply_filter,
    build_config,
    collect,
    load_preset,
    loo_by_model,
    open_source,
    output_root,
    parse_value,
    prepared_samples,
    quiet_native_logs,
    save_preset,
)
from .types import _jsonable

log = logging.getLogger(__name__)

GROUPS: dict[str, dict[str, list[Any]]] = {
    "regularisation": {"models.auto_alpha": [False], "models.ridge_alpha": [0.1, 1.0, 10.0, 100.0], "models.kappa_prior_sd_deg": [1.0, 2.5, 5.0]},
    "crop": {"stream.roi_width_mm": [20.0, 25.0, 30.0, 40.0, 50.0], "stream.roi_aspect": [0.45, 0.6, 0.8]},
    "estimators": {"estimators.order": [["landmarks"], ["landmarks", "iris_edge"], ["landmarks", "iris_edge", "quality"], ["arkit", "landmarks", "iris_edge", "reflection", "quality"]]},
    "cleaning": {"calibration.outlier_mad": [2.0, 3.0, 5.0], "lab.settle_s": [0.4, 0.7, 1.0]},
    "filters": {"filters.kind": ["none", "one_euro", "kalman", "fixation"], "filters.min_cutoff": [0.3, 1.0, 3.0], "filters.beta": [0.0, 0.01, 0.1]},
    "eye": {"lab.eye": ["both", "left", "right"]},
    "models": {"models.candidates": [["geometric"], ["ridge"], ["kernel"], ["reflection"], ["geometric", "ridge", "kernel", "reflection", "blend"]]},
}
"""Named one-at-a-time sweeps. Settings that do not exist in this build are skipped. Add any
setting another area adds (estimator thresholds, iris fit options, feature sets) with --sweep or
--auto; nothing here needs to know about it in advance."""


@dataclass
class Trial:
    name: str
    changes: dict[str, Any]
    cfg: Config | None = None
    dots: dict[str, float] = field(default_factory=dict)  # "seg/dot" -> held-out error
    fold_scores: list[float] = field(default_factory=list)
    inner: list[float | None] = field(default_factory=list)  # best inner score per fold
    chosen_models: list[str | None] = field(default_factory=list)
    error: str | None = None

    @property
    def score(self) -> float | None:
        v = [e for e in self.dots.values() if e is not None and math.isfinite(e)]
        return float(np.mean(v)) if v else None


# --------------------------------------------------------------------------------------------
# Trials
# --------------------------------------------------------------------------------------------


_KNOWN: dict[str, Any] | None = None


def _known() -> dict[str, Any]:
    global _KNOWN
    if _KNOWN is None:
        _KNOWN = {s.path: s for s in settings()}
    return _KNOWN


def auto_values(s: Any) -> list[Any]:
    """Values to try for one setting: both booleans, every choice, or default x {0.5, 2}
    (clipped to the setting's range) for numbers."""
    if s.type == "bool":
        return [not s.default]
    if s.choices and s.type != "list[str]":
        return [c for c in s.choices if c != s.default]
    if s.type in ("int", "float") and isinstance(s.default, (int, float)):
        d = float(s.default)
        cands = [d * 0.5, d * 2.0] if d else [0.1, 1.0]
        out = []
        for v in cands:
            if s.min is not None:
                v = max(float(s.min), v)
            if s.max is not None:
                v = min(float(s.max), v)
            v = int(round(v)) if s.type == "int" else round(v, 6)
            if v != s.default and v not in out:
                out.append(v)
        return out
    return []


def make_trials(sweeps: list[str], groups: list[str], autos: list[str], max_trials: int, seed: int = 0) -> list[Trial]:
    known = _known()
    trials = [Trial("base", {})]
    grid_axes: list[tuple[str, list[Any]]] = []
    for sw in sweeps:
        if "=" not in sw:
            raise LabError(f"--sweep expects path=v1,v2,..., got {sw!r}")
        path, vals = sw.split("=", 1)
        path = path.strip()
        if path not in known:
            raise LabError(f"unknown setting {path!r} in --sweep")
        text = vals.strip()
        values = parse_value(text) if text.startswith("[[") else [parse_value(v.strip()) for v in _split_top(text)]
        grid_axes.append((path, values if isinstance(values, list) else [values]))
    if grid_axes:
        combos = list(itertools.product(*[v for _, v in grid_axes]))
        for combo in combos:
            ch = {p: v for (p, _), v in zip(grid_axes, combo)}
            trials.append(Trial(_name(ch), ch))
    one_at_a_time: list[tuple[str, Any]] = []
    for g in groups:
        if g not in GROUPS:
            raise LabError(f"unknown group {g!r}; groups: {', '.join(GROUPS)}")
        for path, values in GROUPS[g].items():
            if path in known:
                one_at_a_time += [(path, v) for v in values]
    for prefix in autos:
        hits = [s for p, s in known.items() if p.startswith(prefix) and not s.restart]
        if not hits:
            raise LabError(f"no settings start with {prefix!r}")
        for s in hits:
            one_at_a_time += [(s.path, v) for v in auto_values(s)]
    for path, v in one_at_a_time:
        ch = {path: v}
        if path == "models.ridge_alpha":
            ch["models.auto_alpha"] = False
        if json.dumps(_jsonable(v)) == json.dumps(_jsonable(known[path].default)) and len(ch) == 1:
            continue
        trials.append(Trial(_name(ch), ch))
    seen: set[str] = set()
    unique = []
    for t in trials:
        key = json.dumps(_jsonable(t.changes), sort_keys=True)
        if key not in seen:
            seen.add(key)
            unique.append(t)
    if len(unique) > max_trials:
        rng = random.Random(seed)
        rest = unique[1:]
        rng.shuffle(rest)
        unique = [unique[0]] + rest[: max_trials - 1]
    return unique


def _split_top(text: str) -> list[str]:
    """Split on commas outside brackets ('[a,b],[c]' -> two values)."""
    out, depth, cur = [], 0, ""
    for ch in text:
        if ch in "[{":
            depth += 1
        elif ch in "]}":
            depth -= 1
        if ch == "," and depth == 0:
            out.append(cur)
            cur = ""
        else:
            cur += ch
    if cur.strip():
        out.append(cur)
    return out


def _name(changes: dict[str, Any]) -> str:
    return ", ".join(f"{k}={json.dumps(_jsonable(v))}" for k, v in changes.items()) or "base"


# --------------------------------------------------------------------------------------------
# Nested hold-out
# --------------------------------------------------------------------------------------------


def _err(d: dict[str, Any]) -> float | None:
    v = d.get("error_deg")
    if v is None:
        v = d.get("error_pt")
    return None if v is None else float(v)


def make_folds(ids: list[Any], k: int, seed: int = 0) -> list[set[Any]]:
    ids = sorted(ids, key=str)
    rng = random.Random(seed)
    rng.shuffle(ids)
    k = max(2, min(k, len(ids)))
    return [set(ids[i::k]) for i in range(k)]


def fold_scores(prep: dict[str, Any], screen: Any, cfg: Config, metric: str, folds: list[set[int]], pursuit_folds: list[set[int]] | None) -> list[dict[str, Any]]:
    """For each fold: ``{"inner": {model: score}, "outer": {model: {dot: error}}}``. Models are
    fitted on the other folds; ``inner`` is their leave-one-dot-out score there (filtered per
    frame for ``loo_sample``; the moving dot's other bins for ``pursuit``)."""
    from . import calibration as calib
    from .models import build_models
    from .models.base import error_stats

    grid = prep["grid"]
    pursuit = prep["pursuit"]
    out = []
    for k, test_dots in enumerate(folds):
        train = [s for s in grid if s.dot_id not in test_dots]
        test = [s for s in grid if s.dot_id in test_dots]
        entry: dict[str, Any] = {"inner": {}, "outer": {}}
        out.append(entry)
        if len({s.dot_id for s in train}) < 4 or not test and metric != "pursuit":
            continue
        try:
            result = calib.fit_all(train, screen, build_models(cfg.models))
        except Exception as exc:  # noqa: BLE001
            log.info("fold %d: fitting failed: %s", k, exc)
            continue
        loo = loo_by_model(result, train, screen) if metric == "loo_sample" else {}
        for rep in result.reports:
            if not rep.ok:
                continue
            name = rep.model
            model = result.models[name]
            if (rep.params or {}).get("loo_coverage", 1.0) < calib.MIN_LOO_COVERAGE:
                continue
            try:
                if metric == "loo":
                    inner = rep.loo_error_deg if rep.loo_error_deg is not None else rep.loo_error_pt
                    pred = model.predict_samples(test)
                    st = error_stats(test, pred, screen, None)
                    outer = {d["dot_id"]: _err(d) for d in st["per_dot"]}
                elif metric == "loo_sample":
                    if name not in loo:
                        continue
                    fi = apply_filter(loo[name], train, cfg, screen)
                    si = error_stats(train, fi, screen, None)
                    inner = si["error_deg"] if si["error_deg"] is not None else si["error_pt"]
                    pred = apply_filter(model.predict_samples(test), test, cfg, screen)
                    outer = _per_dot_sample_error(test, pred, screen)
                else:
                    if not pursuit or pursuit_folds is None:
                        raise LabError("the 'pursuit' metric needs a recording with the moving dot")
                    pred = apply_filter(model.predict_samples(pursuit), pursuit, cfg, screen, reset_per_dot=False)
                    st = error_stats(pursuit, pred, screen, None)
                    bins = {d["dot_id"]: _err(d) for d in st["per_dot"]}
                    tb = pursuit_folds[k]
                    vals = [v for b, v in bins.items() if b not in tb and v is not None]
                    inner = float(np.mean(vals)) if vals else None
                    outer = {b: v for b, v in bins.items() if b in tb}
            except LabError:
                raise
            except Exception as exc:  # noqa: BLE001
                log.info("fold %d model %s: %s", k, name, exc)
                continue
            if inner is not None:
                entry["inner"][name] = float(inner)
                entry["outer"][name] = outer
    return out


def _per_dot_sample_error(samples: list[Any], pred: np.ndarray, screen: Any) -> dict[int, float | None]:
    from .models.base import error_stats

    out: dict[int, float | None] = {}
    by: dict[int, list[int]] = {}
    for i, s in enumerate(samples):
        by.setdefault(int(s.dot_id), []).append(i)
    for d, idx in by.items():
        st = error_stats([samples[i] for i in idx], pred[idx], screen, None)
        out[d] = st["error_deg"] if st["error_deg"] is not None else st["error_pt"]
    return out


@dataclass
class Prepared:
    seg: str
    prep: dict[str, Any]
    folds: list[set[int]]
    pursuit_folds: list[set[int]] | None


def evaluate_trial(trial: Trial, source: Source, base: Config, metric: str, folds_k: int, segment: str | None, combo: str, use_cache: bool, seed: int, progress: Any = None) -> Trial:
    """Score one trial on every camera (or ``segment``): per fold, the model chosen on the other
    folds predicts the held-out dots."""
    try:
        cfg = apply_changes(base, trial.changes)
    except LabError as exc:
        trial.error = str(exc)
        return trial
    trial.cfg = cfg
    segs = [s for s in source.segments if (segment is None or s.name == segment) and s.dots]
    if not segs:
        raise LabError("no camera with dots to tune on" + (f" (asked for {segment!r})" if segment else ""))
    k_folds = None
    for seg in segs:
        try:
            cols, _ = collect(source, seg, cfg, [combo], use_cache=use_cache)
        except LabError as exc:
            trial.error = f"{seg.name}: {exc}"
            return trial
        prep = prepared_samples(cols[0], seg, cfg)
        dots = sorted({s.dot_id for s in prep["grid"]})
        if len(dots) < 5:
            trial.error = f"{seg.name}: only {len(dots)} usable dots (need 5 to hold some out)"
            continue
        folds = make_folds(dots, folds_k, seed)
        bins = sorted({s.dot_id for s in prep["pursuit"]})
        pfolds = make_folds(bins, len(folds), seed) if len(bins) >= len(folds) else None
        res = fold_scores(prep, source.screen, cfg, metric, folds, pfolds)
        k_folds = len(folds)
        for k, f in enumerate(res):
            if not f["inner"]:
                trial.chosen_models.append(None)
                trial.inner.append(None)
                continue
            best = min(f["inner"], key=lambda m: f["inner"][m])
            trial.chosen_models.append(best)
            trial.inner.append(f["inner"][best])
            outer = f["outer"][best]
            vals = [v for v in outer.values() if v is not None]
            if vals:
                trial.fold_scores.append(float(np.mean(vals)))
            for d, v in outer.items():
                if v is not None:
                    trial.dots[f"{seg.name}/{d}"] = float(v)
            # Keep every model's per-fold numbers for the nested choice across trials.
            trial.__dict__.setdefault("per_fold", []).append({"seg": seg.name, "k": k, "inner": f["inner"], "outer": {m: {f"{seg.name}/{d}": v for d, v in o.items()} for m, o in f["outer"].items()}})
    if k_folds is None and trial.error is None:
        trial.error = "nothing could be scored"
    if progress:
        progress(f"  {trial.name}: {_f(trial.score)}" + (f"  ({trial.error})" if trial.error else ""))
    return trial


def nested_estimate(trials: list[Trial]) -> dict[str, Any]:
    """Choose the winner of each fold on the other folds' inner scores (over every trial and
    model), score it on the held-out fold. Returns the nested estimate and how stable the choice
    was."""
    folds: dict[tuple[str, int], list[tuple[float, Trial, str, dict[str, float]]]] = {}
    for t in trials:
        for pf in t.__dict__.get("per_fold", []):
            for m, inner in pf["inner"].items():
                folds.setdefault((pf["seg"], pf["k"]), []).append((inner, t, m, pf["outer"].get(m, {})))
    picks = []
    dots: dict[str, float] = {}
    for key, cands in sorted(folds.items()):
        inner, t, m, outer = min(cands, key=lambda c: c[0])
        picks.append({"segment": key[0], "fold": key[1], "trial": t.name, "model": m, "inner": inner})
        for d, v in outer.items():
            if v is not None:
                dots[d] = float(v)
    vals = list(dots.values())
    names = [p["trial"] for p in picks]
    top = max(set(names), key=names.count) if names else None
    return {
        "estimate": float(np.mean(vals)) if vals else None,
        "picks": picks,
        "most_picked": top,
        "picked_share": names.count(top) / len(names) if names else 0.0,
        "dots": dots,
    }


def paired(a: dict[str, float], b: dict[str, float], n_boot: int = 4000, seed: int = 0) -> dict[str, Any]:
    """``b - a`` over the dots both scored: mean, bootstrap 95 % interval, sign-flip p-value.
    Negative means b has the smaller error."""
    keys = sorted(set(a) & set(b))
    if len(keys) < 3:
        return {"n": len(keys), "mean": None, "ci": None, "p": None, "verdict": "too few common dots to compare"}
    d = np.array([b[k] - a[k] for k in keys], float)
    rng = np.random.default_rng(seed)
    idx = rng.integers(0, len(d), size=(n_boot, len(d)))
    boots = d[idx].mean(axis=1)
    lo, hi = np.percentile(boots, [2.5, 97.5])
    signs = rng.choice([-1.0, 1.0], size=(n_boot, len(d)))
    null = np.abs((signs * d).mean(axis=1))
    p = float((np.sum(null >= abs(d.mean())) + 1) / (n_boot + 1))
    mean = float(d.mean())
    if lo > 0:
        verdict = f"A is better by {mean:.2f} (95% interval {lo:.2f} to {hi:.2f}): larger than the noise"
    elif hi < 0:
        verdict = f"B is better by {-mean:.2f} (95% interval {-hi:.2f} to {-lo:.2f}): larger than the noise"
    else:
        verdict = f"no difference larger than the noise (B - A = {mean:+.2f}, 95% interval {lo:+.2f} to {hi:+.2f})"
    return {"n": len(keys), "mean": mean, "ci": [float(lo), float(hi)], "p": p, "sd": float(d.std(ddof=1)), "verdict": verdict}


def _f(v: Any, nd: int = 2) -> str:
    return "-" if v is None else f"{v:.{nd}f}"


# --------------------------------------------------------------------------------------------
# Tune
# --------------------------------------------------------------------------------------------


def run_tune(source: Source, base: Config, trials: list[Trial], *, metric: str, folds: int, segment: str | None, combo: str, use_cache: bool = True, seed: int = 0, progress: Any = None) -> dict[str, Any]:
    for t in trials:
        evaluate_trial(t, source, base, metric, folds, segment, combo, use_cache, seed, progress)
    ok = [t for t in trials if t.score is not None]
    if not ok:
        errs = "; ".join(sorted({t.error for t in trials if t.error})) or "no trial produced a score"
        raise LabError(f"nothing could be scored: {errs}")
    ok.sort(key=lambda t: (round(t.score or 0.0, 9), t.name != "base"))  # ties go to the current settings
    base_t = next((t for t in trials if t.name == "base"), None)
    winner = ok[0]
    nested = nested_estimate(ok)
    rows = []
    for t in ok:
        vs = paired(base_t.dots, t.dots) if base_t is not None and t is not base_t and base_t.dots else None
        fs = t.fold_scores
        rows.append({
            "trial": t.name,
            "changes": t.changes,
            "score": t.score,
            "fold_sd": float(np.std(fs, ddof=1)) if len(fs) > 1 else None,
            "n_dots": len(t.dots),
            "models": sorted({m for m in t.chosen_models if m}),
            "vs_base": vs,
        })
    failed = [{"trial": t.name, "error": t.error} for t in trials if t.score is None]
    beats = None
    if base_t is not None and winner is not base_t and base_t.dots:
        beats = paired(base_t.dots, winner.dots)
    unit = "deg" if source.screen.width_mm else "pt"
    return _jsonable({
        "session": str(source.path),
        "metric": metric,
        "unit": unit,
        "folds": folds,
        "segment": segment,
        "combo": combo,
        "trials": rows,
        "failed": failed,
        "winner": {"trial": winner.name, "changes": winner.changes, "score": winner.score},
        "base": {"score": base_t.score if base_t else None},
        "winner_vs_base": beats,
        "nested": {k: v for k, v in nested.items() if k != "dots"},
        "advice": _advice(winner, base_t, beats, nested),
    })


def _advice(winner: Trial, base: Trial | None, beats: dict[str, Any] | None, nested: dict[str, Any]) -> str:
    if base is None or winner is base:
        return "The current settings scored best; nothing to change."
    parts = []
    if beats and beats.get("ci") and beats["ci"][1] < 0:
        parts.append(f"'{winner.name}' beats the current settings by more than the noise.")
    else:
        parts.append(f"'{winner.name}' scored best, but not by more than the noise: keep the current settings unless other sessions agree.")
    est = nested.get("estimate")
    if est is not None and winner.score is not None and est > winner.score * 1.25:
        parts.append(f"The nested estimate ({est:.2f}) is well above the winner's own score ({winner.score:.2f}): with this many trials the sweep is partly fitting noise. Use fewer trials or more dots.")
    if nested.get("picked_share", 1.0) < 0.5:
        parts.append("Different folds picked different winners: the choice is not stable.")
    return " ".join(parts)


def format_tune(res: dict[str, Any]) -> str:
    u = res["unit"]
    lines = [f"Tune {res['session']}  (metric {res['metric']}, {res['folds']} folds, estimators {res['combo']})", ""]
    lines.append(f"{'held-out ' + u:>12}  {'fold sd':>8}  {'vs base (95% interval)':>28}  trial")
    for r in res["trials"]:
        vs = r.get("vs_base")
        vtxt = "" if not vs or vs.get("mean") is None else f"{vs['mean']:+.2f} ({vs['ci'][0]:+.2f} to {vs['ci'][1]:+.2f})"
        lines.append(f"{_f(r['score']):>12}  {_f(r['fold_sd']):>8}  {vtxt:>28}  {r['trial']}  [{', '.join(r['models'])}]")
    for f in res.get("failed", []):
        lines.append(f"{'failed':>12}  {'':>8}  {'':>28}  {f['trial']}: {f['error']}")
    n = res["nested"]
    lines += ["", f"Winner: {res['winner']['trial']} ({_f(res['winner']['score'])} {u}; current settings {_f(res['base']['score'])} {u})."]
    lines.append(f"Nested estimate of 'tune, then use the winner': {_f(n.get('estimate'))} {u}; the most-picked trial ({n.get('most_picked')}) won {n.get('picked_share', 0):.0%} of folds.")
    if res.get("winner_vs_base"):
        lines.append(f"Winner vs current settings: {res['winner_vs_base']['verdict']}.")
    lines.append(res["advice"])
    return "\n".join(lines)


def tune_main(argv: list[str] | None = None) -> int:
    argv = list(sys.argv[1:] if argv is None else argv)
    if argv and argv[0] == "tune":
        argv = argv[1:]
    p = argparse.ArgumentParser(prog="python -m phonegaze tune", description="Sweep settings on a recorded session; report the best by held-out error.")
    add_common_args(p)
    p.add_argument("--sweep", action="append", default=[], metavar="PATH=V1,V2", help="try these values (all combinations of every --sweep); lists as [a,b],[c]")
    p.add_argument("--group", action="append", default=[], help="a named one-at-a-time sweep: " + ", ".join(GROUPS))
    p.add_argument("--auto", action="append", default=[], metavar="PREFIX", help="one-at-a-time sweep of every setting under PREFIX, e.g. estimators. or models.")
    p.add_argument("--metric", choices=["loo", "loo_sample", "pursuit"], help="what 'best' means (default lab.metric)")
    p.add_argument("--folds", type=int, help="outer folds (default lab.folds)")
    p.add_argument("--combo", default="default", help="estimator combination (default: estimators.order)")
    p.add_argument("--max-trials", type=int, default=40, help="cap; extra trials are sampled at random (base always kept)")
    p.add_argument("--seed", type=int, default=0)
    p.add_argument("--save", metavar="NAME", help="write the winner's changes as a preset with this name")
    p.add_argument("--json", action="store_true")
    args = p.parse_args(argv)
    quiet_native_logs()
    logging.basicConfig(level=getattr(logging, str(args.log_level).upper(), logging.WARNING), format="%(levelname)s %(name)s: %(message)s")
    try:
        base, base_changes = build_config(args.config, args.preset, args.set)
        if not (args.sweep or args.group or args.auto):
            raise LabError("say what to try: --sweep PATH=V1,V2, --group NAME (" + ", ".join(GROUPS) + ") or --auto PREFIX")
        trials = make_trials(args.sweep, args.group, args.auto, args.max_trials, args.seed)
        source = open_source(args.session)
        metric = args.metric or base.lab.metric
        folds = args.folds or base.lab.folds
        progress = None if args.json else (lambda s: print(s, file=sys.stderr, flush=True))
        if progress:
            progress(f"{len(trials)} trials, metric {metric}, {folds} folds")
        res = run_tune(source, base, trials, metric=metric, folds=folds, segment=args.segment, combo=args.combo, use_cache=not args.no_cache, seed=args.seed, progress=progress)
        res["base_changes"] = base_changes
        out = output_root(base) / "tune"
        out.mkdir(parents=True, exist_ok=True)
        stamp = Path(str(source.path)).name
        (out / f"{stamp}-{metric}.json").write_text(json.dumps(res, indent=2))
        if args.save:
            # --preset and --set changes are part of what was tuned; where output goes is not.
            changes = {k: v for k, v in {**base_changes, **res["winner"]["changes"]}.items() if k != "lab.output_dir"}
            path = save_preset(base, args.save, changes, source="tune", session=str(source.path), metric=metric, score=res["winner"]["score"], nested_estimate=res["nested"].get("estimate"), vs_base=res.get("winner_vs_base"), unit=res["unit"])
            res["saved"] = str(path)
    except LabError as exc:
        print(f"tune: {exc}", file=sys.stderr)
        return 2
    except KeyboardInterrupt:
        return 130
    if args.json:
        print(json.dumps(res, indent=2))
    else:
        print(format_tune(res))
        if res.get("saved"):
            print(f"\nSaved preset: {res['saved']}")
    return 0


# --------------------------------------------------------------------------------------------
# A/B
# --------------------------------------------------------------------------------------------


def _side(spec: str, base: Config) -> tuple[str, dict[str, Any]]:
    if spec in ("base", "current", "default"):
        return spec, {}
    if "=" in spec and not spec.endswith(".json"):
        ch = {}
        for part in spec.split(";"):
            k, v = part.split("=", 1)
            ch[k.strip()] = parse_value(v.strip())
        return spec, ch
    data = load_preset(spec, base)
    return str(data.get("name", spec)), dict(data["changes"])


def run_ab(source: Source, base: Config, a: str, b: str, *, metric: str, folds: int, segment: str | None, combo: str, use_cache: bool = True, seed: int = 0, progress: Any = None) -> dict[str, Any]:
    na, ca = _side(a, base)
    nb, cb = _side(b, base)
    ta = evaluate_trial(Trial(f"A: {na}", ca), source, base, metric, folds, segment, combo, use_cache, seed, progress)
    tb = evaluate_trial(Trial(f"B: {nb}", cb), source, base, metric, folds, segment, combo, use_cache, seed, progress)
    for t in (ta, tb):
        if t.score is None:
            raise LabError(f"{t.name} could not be scored: {t.error}")
    cmp = paired(ta.dots, tb.dots, seed=seed)
    unit = "deg" if source.screen.width_mm else "pt"

    def side(t: Trial, changes: dict[str, Any]) -> dict[str, Any]:
        fs = t.fold_scores
        return {"name": t.name, "changes": changes, "score": t.score, "fold_sd": float(np.std(fs, ddof=1)) if len(fs) > 1 else None, "models": sorted({m for m in t.chosen_models if m}), "n_dots": len(t.dots)}

    return _jsonable({"session": str(source.path), "metric": metric, "unit": unit, "folds": folds, "a": side(ta, ca), "b": side(tb, cb), "comparison": cmp})


def format_ab(res: dict[str, Any]) -> str:
    u = res["unit"]
    c = res["comparison"]
    lines = [f"A/B on {res['session']} (metric {res['metric']}, held out, {res['folds']} folds, {c['n']} dots paired)"]
    for k in ("a", "b"):
        s = res[k]
        lines.append(f"  {s['name']}: {_f(s['score'])} {u} (fold sd {_f(s['fold_sd'])}), models chosen {', '.join(s['models'])}")
    lines.append(f"Result: {c['verdict']}" + (f"; p = {c['p']:.3f}" if c.get("p") is not None else ""))
    return "\n".join(lines)


def ab_main(argv: list[str] | None = None) -> int:
    argv = list(sys.argv[1:] if argv is None else argv)
    if argv and argv[0] == "ab":
        argv = argv[1:]
    p = argparse.ArgumentParser(prog="python -m phonegaze ab", description="Score two presets on the same session; say whether the difference is larger than the noise.")
    add_common_args(p)
    p.add_argument("--a", required=True, help="preset name or .json, 'base' for the current settings, or 'path=value;path=value'")
    p.add_argument("--b", required=True, help="as --a")
    p.add_argument("--metric", choices=["loo", "loo_sample", "pursuit"])
    p.add_argument("--folds", type=int)
    p.add_argument("--combo", default="default")
    p.add_argument("--seed", type=int, default=0)
    p.add_argument("--json", action="store_true")
    args = p.parse_args(argv)
    quiet_native_logs()
    logging.basicConfig(level=getattr(logging, str(args.log_level).upper(), logging.WARNING), format="%(levelname)s %(name)s: %(message)s")
    try:
        base, _ = build_config(args.config, args.preset, args.set)
        source = open_source(args.session)
        res = run_ab(source, base, args.a, args.b, metric=args.metric or base.lab.metric, folds=args.folds or base.lab.folds, segment=args.segment, combo=args.combo, use_cache=not args.no_cache, seed=args.seed)
    except LabError as exc:
        print(f"ab: {exc}", file=sys.stderr)
        return 2
    except KeyboardInterrupt:
        return 130
    print(json.dumps(res, indent=2) if args.json else format_ab(res))
    return 0


if __name__ == "__main__":
    sys.exit(tune_main())
