"""Named bundles of settings: built-in starting points and the user's own. Owner: Core.

A preset is ``{"name", "description", "mode", "changes": {path: value}}``. ``changes`` holds only
settings that differ from their defaults, so the diff from defaults is the preset itself.

- ``mode = "replace"``: applying makes every *experiment* setting (see :func:`in_presets`) equal
  to the preset, defaults for anything it does not mention. A camera preset is a full starting
  point.
- ``mode = "merge"``: applying sets only the preset's own changes ("steady pointer" on top of
  whatever camera preset is in use).

User presets live in ``presets.json`` next to the config file. They can be exported (one preset
as JSON) and imported again on another Mac. Built-in presets cannot be overwritten or deleted;
a user preset with the same name is refused.

Settings that describe this machine rather than an experiment are never part of a preset: the
server, phone address, recordings, shortcuts, whether the cursor moves or clicks, the colour theme,
diagnostics, the offline lab, settings that need a restart, and ``lens.camera_id`` (phone-specific; presets use ``lens.camera_prefer``).
"""

from __future__ import annotations

import json
import os
import re
from pathlib import Path
from typing import Any

from .config import DEFAULT_PATH, Config, ConfigError, Setting, coerce, get_value, settings

NOT_IN_PRESETS = (
    "server.",
    "phone.",
    "recording.",
    "hotkeys.",
    "outputs.cursor",
    "outputs.dwell_click",
    "outputs.websocket",
    "ui.theme",
    "ui.show_debug",
    "ui.tuning_",
    "diagnostics.",
    "lab.",
    "lens.camera_id",
    "collect.",
    "ui.simple_mode",
)

BUILTIN: list[dict[str, Any]] = [
    {
        "name": "front camera, safe",
        "description": "Front TrueDepth camera with ARKit: Apple's eye and head tracking, no reflection, regression and geometric models, balanced smoothing, calibration from 3 head positions. The most likely to work first.",
        "mode": "replace",
        "changes": {
            "lens.camera_prefer": "arkit",
            "lens.auto_zoom": False,
            "estimators.use_reflection": False,
            "models.candidates": ["geometric", "ridge", "kernel", "blend"],
            "filters.preset": "balanced",
            "calibration.pose_rounds": 3,
        },
    },
    {
        "name": "rear 2x, reflection",
        "description": "Rear wide camera at 2x: sub-pixel iris plus the screen's corneal reflection, with a white border on the pages and coded-flash learning to make the reflection easy to find; reflection and hybrid models; 3 head positions; shutter capped at 16 ms against motion blur.",
        "mode": "replace",
        "changes": {
            "lens.camera_prefer": "back",
            "lens.max_exposure_ms": 16.0,
            "models.candidates": ["geometric", "ridge", "kernel", "reflection", "blend", "hybrid"],
            "calibration.pose_rounds": 3,
            "ui.glint_marker": "border",
        },
    },
    {
        "name": "rear 2x, geometric",
        "description": "Rear wide camera at 2x without the reflection: iris edge with the upper eyelid masked, geometric model with per-eye eyeball centres learned from 3 head positions.",
        "mode": "replace",
        "changes": {
            "lens.camera_prefer": "back",
            "estimators.use_reflection": False,
            "estimators.iris_lid_mask_upper_deg": 45.0,
            "models.candidates": ["geometric", "ridge", "kernel", "blend"],
            "models.eyeball_centre": "per_eye",
            "calibration.pose_rounds": 3,
        },
    },
    {
        "name": "rear 1x, wide head box",
        "description": "Rear wide camera at 1x, never zooming: the head can move further before the eyes leave the frame. Larger eye crops, a larger whole-frame image and more face search attempts. Less eye detail, so the reflection is off.",
        "mode": "replace",
        "changes": {
            "lens.camera_prefer": "back",
            "lens.zoom": 1.0,
            "lens.auto_zoom": False,
            "stream.roi_width_mm": 40.0,
            "stream.wide_width": 960,
            "estimators.face_attempts": 4,
            "estimators.use_reflection": False,
            "models.candidates": ["geometric", "ridge", "kernel", "blend"],
            "calibration.pose_rounds": 3,
        },
    },
    {
        "name": "steady pointer",
        "description": "Heavy smoothing and a fixation lock: a calm pointer for dwell clicks, with more lag. Applies on top of the current settings.",
        "mode": "merge",
        "changes": {"filters.preset": "steady", "filters.fixation_lock": True, "outputs.dwell_radius_pt": 60.0},
    },
    {
        "name": "fast pointer",
        "description": "Little smoothing and 60 frames per second where the phone has them: low lag, more jitter. Applies on top of the current settings.",
        "mode": "merge",
        "changes": {"filters.preset": "responsive", "lens.fps": 60.0, "stream.max_fps": 60.0},
    },
    {
        "name": "fallback (always a pointer)",
        "description": "The fewest stages (ARKit and face landmarks only), no calibration needed: the fallback pointer follows the measured eye direction around a self-centring middle, heavily smoothed. Rough, but something to look at while tuning the rest.",
        "mode": "replace",
        "changes": {
            "estimators.order": ["arkit", "landmarks"],
            "outputs.fallback_pointer": "always",
            "filters.preset": "steady",
        },
    },
]


class PresetError(ValueError):
    pass


def in_presets(s: Setting) -> bool:
    return not s.restart and not any(s.path.startswith(p) for p in NOT_IN_PRESETS)


def preset_settings() -> list[Setting]:
    return [s for s in settings() if in_presets(s)]


def store_path(config_path: str | os.PathLike[str] | None) -> Path:
    base = Path(config_path).parent if config_path else DEFAULT_PATH.parent
    return base / "presets.json"


def _clean_name(name: Any) -> str:
    text = re.sub(r"\s+", " ", str(name or "")).strip()
    if not text or len(text) > 80:
        raise PresetError("a preset needs a name of 1-80 characters")
    return text


def validate(preset: dict[str, Any]) -> dict[str, Any]:
    """Check and normalise a preset (from a file or an import). Raises :class:`PresetError`."""
    if not isinstance(preset, dict):
        raise PresetError("a preset is a JSON object")
    changes = preset.get("changes")
    if not isinstance(changes, dict):
        raise PresetError('a preset needs "changes": {setting path: value}')
    by_path = {s.path: s for s in preset_settings()}
    clean: dict[str, Any] = {}
    errors = []
    for path, value in changes.items():
        s = by_path.get(path)
        if s is None:
            errors.append(f"{path}: not a setting a preset can hold")
            continue
        try:
            clean[path] = coerce(s, value)
        except ConfigError as exc:
            errors.append(str(exc))
    if errors:
        raise PresetError("; ".join(errors))
    mode = preset.get("mode", "replace")
    if mode not in ("replace", "merge"):
        raise PresetError("mode must be 'replace' or 'merge'")
    return {"name": _clean_name(preset.get("name")), "description": str(preset.get("description") or ""), "mode": mode, "changes": clean}


class PresetStore:
    """Built-in presets plus the user's, kept in ``path``."""

    def __init__(self, path: str | os.PathLike[str]) -> None:
        self.path = Path(path)

    def _load_user(self) -> list[dict[str, Any]]:
        if not self.path.exists():
            return []
        try:
            data = json.loads(self.path.read_text(encoding="utf-8"))
        except (OSError, ValueError):
            return []
        out = []
        for p in data.get("presets", []) if isinstance(data, dict) else []:
            try:
                out.append({**validate(p), "saved": p.get("saved")})
            except PresetError:
                continue
        return out

    def _save_user(self, presets: list[dict[str, Any]]) -> None:
        self.path.parent.mkdir(parents=True, exist_ok=True)
        tmp = self.path.with_suffix(".json.tmp")
        tmp.write_text(json.dumps({"version": 1, "presets": presets}, indent=2) + "\n", encoding="utf-8")
        os.replace(tmp, self.path)

    def all(self) -> list[dict[str, Any]]:
        return [{**p, "builtin": True} for p in BUILTIN] + [{**p, "builtin": False} for p in self._load_user()]

    def get(self, name: str) -> dict[str, Any]:
        for p in self.all():
            if p["name"] == name:
                return p
        raise PresetError(f"no preset named {name!r}")

    def save(self, preset: dict[str, Any], *, overwrite: bool = True) -> dict[str, Any]:
        p = validate(preset)
        if any(b["name"] == p["name"] for b in BUILTIN):
            raise PresetError(f"{p['name']!r} is a built-in preset; choose another name")
        user = self._load_user()
        if not overwrite and any(u["name"] == p["name"] for u in user):
            raise PresetError(f"a preset named {p['name']!r} already exists")
        import datetime as _dt

        p["saved"] = _dt.datetime.now().isoformat(timespec="seconds")
        user = [u for u in user if u["name"] != p["name"]] + [p]
        self._save_user(user)
        return {**p, "builtin": False}

    def delete(self, name: str) -> bool:
        if any(b["name"] == name for b in BUILTIN):
            raise PresetError("built-in presets cannot be deleted")
        user = self._load_user()
        kept = [u for u in user if u["name"] != name]
        if len(kept) == len(user):
            return False
        self._save_user(kept)
        return True


def current_changes(cfg: Config) -> dict[str, Any]:
    """Every experiment setting that differs from its default (what "save as preset" stores)."""
    return {s.path: get_value(cfg, s.path) for s in preset_settings() if get_value(cfg, s.path) != s.default}


def changes_to_apply(preset: dict[str, Any], cfg: Config) -> dict[str, Any]:
    """The ``{path: value}`` changes that make ``cfg`` match ``preset``."""
    out: dict[str, Any] = {}
    if preset.get("mode") == "merge":
        for path, value in preset["changes"].items():
            if get_value(cfg, path) != value:
                out[path] = value
        return out
    for s in preset_settings():
        want = preset["changes"].get(s.path, s.default)
        if get_value(cfg, s.path) != want:
            out[s.path] = want
    return out


def diff(preset: dict[str, Any]) -> list[dict[str, Any]]:
    """The preset's changes beside the defaults, for the UI."""
    defaults = {s.path: s.default for s in settings()}
    return [{"path": k, "value": v, "default": defaults.get(k)} for k, v in sorted(preset["changes"].items())]


def matches(preset: dict[str, Any], cfg: Config) -> bool:
    return not changes_to_apply(preset, cfg)
