"""One typed configuration tree for the whole engine, saved as JSON. Owner: Foundation.

Every setting is a dataclass field with a default and metadata (``desc``, optional
``choices``, ``min``, ``max``, ``unit``), so :func:`settings` can list them all for the UI and
:func:`set_value` can validate changes.

How areas add settings (the only edits other areas make to this file): append fields, with a
default and ``desc`` metadata, at the END of the section class their area owns:

==============  ==========================================================================
Section         Owner
==============  ==========================================================================
server          Core
phone           Core
stream          Core
lens            Core
outputs         Core
hotkeys         Core
recording       Core
estimators      Vision
models          Models
calibration     Models
filters         Models
sim             Simulator
ui              UI
==============  ==========================================================================

Use :func:`setting` to declare a field. Supported value types: ``bool``, ``int``, ``float``,
``str``, and ``list[str]``. Nested dataclasses inside a section are not allowed (keep the tree
two levels deep: ``section.name``). Unknown keys in a loaded file are ignored with a warning,
so old config files keep loading.

Usage::

    cfg = load_config(path)              # missing file -> defaults
    cfg.lens.zoom                        # typed access
    set_value(cfg, "lens.zoom", 2.0)     # validated; raises ConfigError
    save_config(cfg, path)
    settings()                           # [Setting(path, type, default, description, choices...)]
"""

from __future__ import annotations

import json
import logging
import os
import typing
from dataclasses import MISSING, asdict, dataclass, field, fields
from pathlib import Path
from typing import Any

log = logging.getLogger(__name__)

DEFAULT_PATH = Path(os.environ.get("PHONEGAZE_HOME", Path.home() / ".phonegaze")) / "config.json"
"""Where ``python -m phonegaze`` keeps its config unless ``--config`` says otherwise."""


class ConfigError(ValueError):
    pass


def setting(
    default: Any,
    desc: str,
    *,
    choices: list[Any] | None = None,
    min: float | None = None,  # noqa: A002 - mirrors the metadata key
    max: float | None = None,  # noqa: A002
    unit: str | None = None,
    restart: bool = False,
) -> Any:
    """Declare a setting. ``restart=True`` means changes apply only after restarting the engine
    (or reconnecting the phone); the UI says so."""
    meta = {"desc": desc, "choices": choices, "min": min, "max": max, "unit": unit, "restart": restart}
    if isinstance(default, list):
        return field(default_factory=lambda: list(default), metadata=meta)
    return field(default=default, metadata=meta)


# --------------------------------------------------------------------------------------------
# Sections
# --------------------------------------------------------------------------------------------


@dataclass
class ServerConfig:
    host: str = setting("127.0.0.1", "Address the engine's web UI and API listen on.", restart=True)
    port: int = setting(8765, "Port for the web UI, REST API and WebSockets.", min=1, max=65535, restart=True)
    open_browser: bool = setting(True, "Open the UI in the default browser on start.")


@dataclass
class PhoneConfig:
    url: str = setting(
        "",
        "Base URL of the phone app, e.g. http://192.168.1.20:8080. Empty: use the simulator "
        "when started with --sim, otherwise wait for one to be entered in the UI.",
    )
    connect_timeout_s: float = setting(5.0, "Timeout for each phone HTTP request.", min=0.5, max=60, unit="s")
    reconnect_s: float = setting(2.0, "Wait between reconnection attempts.", min=0.1, max=60, unit="s")
    clock_sync_interval_s: float = setting(
        10.0, "How often to re-measure the phone clock offset with /api/time.", min=1, max=600, unit="s"
    )


@dataclass
class StreamConfig:
    max_fps: float = setting(30.0, "Highest frame rate requested from the phone stream.", min=1, max=120, unit="fps")
    wide_width: int = setting(640, "Width of the downscaled whole frame.", min=160, max=1920, unit="px")
    wide_quality: float = setting(0.6, "JPEG quality of the whole frame.", min=0.1, max=1.0)
    wide_every: int = setting(1, "Send the whole frame every Nth frame (ROIs come every frame).", min=1, max=30)
    roi_quality: float = setting(0.9, "JPEG quality of native-resolution eye crops.", min=0.1, max=1.0)
    roi_source: str = setting(
        "mac",
        "Who places the eye crops: the engine ('mac'), ARKit's eye positions ('arkit'), or the "
        "phone's own face landmarks ('vision').",
        choices=["mac", "arkit", "vision"],
    )
    roi_width_mm: float = setting(
        30.0, "Physical width of each eye crop at the eye, converted to pixels with the current distance.", min=10, max=80, unit="mm"
    )
    roi_aspect: float = setting(0.6, "Eye crop height / width.", min=0.3, max=1.0)
    rotation: str = setting(
        "auto",
        "How to turn images upright: from gravity ('auto') or a fixed clockwise rotation.",
        choices=["auto", "0", "90", "180", "270"],
    )


@dataclass
class LensConfig:
    camera_id: str = setting("", "Camera to use (phone camera id). Empty: choose by aiming.")
    zoom: float = setting(2.0, "Zoom factor on the chosen camera.", min=1.0, max=10.0)
    max_width: int = setting(3840, "Largest sensor format width to request.", min=640, max=8064, unit="px")
    fps: float = setting(30.0, "Camera frame rate to request.", min=1, max=120, unit="fps")
    auto_zoom: bool = setting(True, "Switch between 1x and the zoom above when the eyes near the frame edge.")
    edge_margin: float = setting(0.08, "How close to the frame edge (fraction of the frame) triggers zooming out.", min=0, max=0.4)
    aim_on_start: bool = setting(False, "Run the camera and zoom search when the phone connects.")
    lock_focus_after_aim: bool = setting(True, "Lock focus once aiming has found a sharp setting.")


@dataclass
class EstimatorsConfig:
    order: list[str] = setting(
        ["arkit", "landmarks", "iris_edge", "reflection", "quality"],
        "Estimators to run, in order. Each refines the observation the previous ones built.",
        choices=["arkit", "landmarks", "iris_edge", "reflection", "appearance", "quality"],
    )
    landmarks_model: str = setting("face_landmarker.task", "MediaPipe face landmarker model file in the models folder.")
    landmarks_every: int = setting(1, "Run face landmarks every Nth frame and track in between.", min=1, max=10)


@dataclass
class ModelsConfig:
    candidates: list[str] = setting(
        ["geometric", "ridge", "kernel", "reflection", "blend"],
        "Gaze models fitted after every calibration.",
        choices=["geometric", "ridge", "kernel", "reflection", "blend", "residual"],
    )
    pinned: str = setting("", "Always use this model. Empty: use the best leave-one-dot-out score.")
    ridge_alpha: float = setting(1.0, "Ridge regression regularisation.", min=0, max=1000)


@dataclass
class CalibrationConfig:
    grid: str = setting("3x3", "Dot grid for full calibration (columns x rows).", choices=["2x2", "3x3", "4x3", "4x4", "5x4", "5x5"])
    margin: float = setting(0.08, "Distance of the outer dots from the screen edge (fraction of the screen).", min=0, max=0.4)
    settle_ms: int = setting(600, "Time after a dot appears before samples are taken.", min=0, max=3000, unit="ms")
    collect_ms: int = setting(900, "Time samples are taken per dot.", min=100, max=5000, unit="ms")
    moving_dot: bool = setting(False, "Follow the grid with a smoothly moving dot.")
    pose_rounds: int = setting(1, "Repeat the grid this many times, asking for a different head position each time.", min=1, max=5)
    refine_points: int = setting(1, "Dots in a quick refine (1 = offset only, 3-5 = re-solve the screen position).", min=1, max=5)
    validate_points: int = setting(5, "Fresh dots used for validation.", min=3, max=16)
    outlier_mad: float = setting(3.0, "Drop samples further than this many MADs from their dot's median.", min=1, max=10)
    drift_correction: bool = setting(False, "Slowly adapt to known look-points (dwell selections, clicks).")


@dataclass
class FiltersConfig:
    kind: str = setting("one_euro", "Smoothing filter.", choices=["none", "one_euro", "kalman", "fixation"])
    min_cutoff: float = setting(1.0, "One-euro minimum cutoff frequency.", min=0.01, max=10, unit="Hz")
    beta: float = setting(0.01, "One-euro speed coefficient.", min=0, max=1)
    blink_hold_ms: int = setting(150, "Hold the last point this long during a blink before reporting invalid.", min=0, max=1000, unit="ms")
    fixation_deg: float = setting(1.5, "Dispersion threshold for fixations.", min=0.1, max=5, unit="deg")


@dataclass
class OutputsConfig:
    cursor: bool = setting(False, "Move the system cursor (needs Accessibility permission on macOS).")
    dwell_click: bool = setting(False, "Click when gaze rests in one place.")
    dwell_ms: int = setting(800, "Dwell time before a click.", min=200, max=5000, unit="ms")
    dwell_radius_pt: float = setting(40.0, "How still gaze must be for a dwell.", min=5, max=300, unit="pt")
    websocket: bool = setting(True, "Stream gaze samples on ws://host:port/gaze (for Forsee).")
    websocket_rate_hz: float = setting(60.0, "Maximum gaze samples per second on the WebSocket.", min=1, max=240, unit="Hz")


@dataclass
class HotkeysConfig:
    enabled: bool = setting(True, "Listen for global shortcuts (macOS; needs Input Monitoring permission).")
    recalibrate: str = setting("<ctrl>+<alt>+c", "Start a full calibration (pynput hotkey syntax).")
    quick_refine: str = setting("<ctrl>+<alt>+r", "Start a quick refine.")
    validate: str = setting("<ctrl>+<alt>+v", "Start a validation.")
    pause: str = setting("<ctrl>+<alt>+p", "Pause or resume gaze output.")


@dataclass
class RecordingConfig:
    directory: str = setting("~/.phonegaze/recordings", "Where sessions are recorded. Never inside the repository.")
    record_stream: bool = setting(True, "Store the raw phone stream (images included) so it can be replayed.")
    record_observations: bool = setting(True, "Store observations and gaze as JSON lines.")
    max_minutes: float = setting(30.0, "Stop a recording automatically after this long.", min=1, max=600, unit="min")


@dataclass
class SimConfig:
    port: int = setting(8081, "Port the simulated phone listens on.", min=1, max=65535, restart=True)
    seed: int = setting(1, "Random seed for the simulated person and noise.")
    camera: str = setting("wide", "Which simulated camera to start with.", choices=["wide", "ultrawide", "front", "arkit"])
    fps: float = setting(30.0, "Simulated frame rate.", min=1, max=120, unit="fps")


@dataclass
class UIConfig:
    theme: str = setting("auto", "Colour theme of the browser UI.", choices=["auto", "light", "dark"])
    show_debug: bool = setting(True, "Show raw observations and estimator overlays.")


@dataclass
class Config:
    """The whole tree. Sections are fixed; add new sections only through Foundation."""

    server: ServerConfig = field(default_factory=ServerConfig)
    phone: PhoneConfig = field(default_factory=PhoneConfig)
    stream: StreamConfig = field(default_factory=StreamConfig)
    lens: LensConfig = field(default_factory=LensConfig)
    estimators: EstimatorsConfig = field(default_factory=EstimatorsConfig)
    models: ModelsConfig = field(default_factory=ModelsConfig)
    calibration: CalibrationConfig = field(default_factory=CalibrationConfig)
    filters: FiltersConfig = field(default_factory=FiltersConfig)
    outputs: OutputsConfig = field(default_factory=OutputsConfig)
    hotkeys: HotkeysConfig = field(default_factory=HotkeysConfig)
    recording: RecordingConfig = field(default_factory=RecordingConfig)
    sim: SimConfig = field(default_factory=SimConfig)
    ui: UIConfig = field(default_factory=UIConfig)

    def to_dict(self) -> dict[str, Any]:
        return asdict(self)

    @classmethod
    def from_dict(cls, data: dict[str, Any]) -> Config:
        cfg = cls()
        for section, values in (data or {}).items():
            if not hasattr(cfg, section) or not isinstance(values, dict):
                log.warning("ignoring unknown config section %r", section)
                continue
            for name, value in values.items():
                try:
                    set_value(cfg, f"{section}.{name}", value)
                except ConfigError as exc:
                    log.warning("ignoring config value: %s", exc)
        return cfg


# --------------------------------------------------------------------------------------------
# Introspection for the UI
# --------------------------------------------------------------------------------------------


@dataclass(frozen=True)
class Setting:
    """One setting, as the UI renders it. ``type`` is one of ``"bool"``, ``"int"``,
    ``"float"``, ``"str"``, ``"list[str]"``."""

    path: str
    type: str
    default: Any
    description: str
    choices: list[Any] | None = None
    min: float | None = None
    max: float | None = None
    unit: str | None = None
    restart: bool = False

    def to_dict(self) -> dict[str, Any]:
        return asdict(self)


_TYPE_NAMES = {bool: "bool", int: "int", float: "float", str: "str"}


def _type_name(section_cls: type, name: str) -> str:
    hints = typing.get_type_hints(section_cls)
    tp = hints[name]
    if tp in _TYPE_NAMES:
        return _TYPE_NAMES[tp]
    if typing.get_origin(tp) is list and typing.get_args(tp) == (str,):
        return "list[str]"
    raise TypeError(f"unsupported setting type {tp} for {section_cls.__name__}.{name}")


def settings(cfg_cls: type[Config] = Config) -> list[Setting]:
    """Every setting in tree order."""
    out: list[Setting] = []
    for section in fields(cfg_cls):
        section_cls = typing.get_type_hints(cfg_cls)[section.name]
        for f in fields(section_cls):
            meta = f.metadata
            if f.default is not MISSING:
                default = f.default
            elif f.default_factory is not MISSING:  # type: ignore[misc]
                default = f.default_factory()  # type: ignore[misc]
            else:  # pragma: no cover
                raise TypeError(f"{section.name}.{f.name} has no default")
            out.append(
                Setting(
                    path=f"{section.name}.{f.name}",
                    type=_type_name(section_cls, f.name),
                    default=default,
                    description=meta.get("desc", ""),
                    choices=meta.get("choices"),
                    min=meta.get("min"),
                    max=meta.get("max"),
                    unit=meta.get("unit"),
                    restart=bool(meta.get("restart", False)),
                )
            )
    return out


def _setting_for(path: str) -> Setting:
    for s in settings():
        if s.path == path:
            return s
    raise ConfigError(f"unknown setting {path!r}")


def coerce(s: Setting, value: Any) -> Any:
    """Convert and validate ``value`` for setting ``s``. Raises ``ConfigError``."""
    try:
        if s.type == "bool":
            if isinstance(value, str):
                if value.lower() not in ("true", "false", "1", "0", "yes", "no"):
                    raise ValueError(value)
                value = value.lower() in ("true", "1", "yes")
            elif not isinstance(value, (bool, int)):
                raise ValueError(value)
            value = bool(value)
        elif s.type == "int":
            if isinstance(value, bool) or (isinstance(value, float) and not value.is_integer()):
                raise ValueError(value)
            value = int(value)
        elif s.type == "float":
            if isinstance(value, bool):
                raise ValueError(value)
            value = float(value)
        elif s.type == "str":
            if not isinstance(value, (str, int, float)) or isinstance(value, bool):
                raise ValueError(value)
            value = str(value)
        elif s.type == "list[str]":
            if not isinstance(value, list) or not all(isinstance(v, str) for v in value):
                raise ValueError(value)
            value = list(value)
    except (TypeError, ValueError) as exc:
        raise ConfigError(f"{s.path}: {value!r} is not a valid {s.type}") from exc
    if s.choices is not None:
        items = value if isinstance(value, list) else [value]
        bad = [v for v in items if v not in s.choices]
        if bad:
            raise ConfigError(f"{s.path}: {bad} not in {s.choices}")
    if s.min is not None and isinstance(value, (int, float)) and value < s.min:
        raise ConfigError(f"{s.path}: {value} is below {s.min}")
    if s.max is not None and isinstance(value, (int, float)) and value > s.max:
        raise ConfigError(f"{s.path}: {value} is above {s.max}")
    return value


def get_value(cfg: Config, path: str) -> Any:
    section, name = path.split(".", 1)
    return getattr(getattr(cfg, section), name)


def set_value(cfg: Config, path: str, value: Any) -> Any:
    """Validate and set one value by path. Returns the stored (coerced) value."""
    s = _setting_for(path)
    value = coerce(s, value)
    section, name = path.split(".", 1)
    setattr(getattr(cfg, section), name, value)
    return value


def update(cfg: Config, changes: dict[str, Any]) -> dict[str, str]:
    """Apply ``{path: value}`` changes. Valid ones are applied; returns ``{path: error}``."""
    errors: dict[str, str] = {}
    for path, value in changes.items():
        try:
            set_value(cfg, path, value)
        except ConfigError as exc:
            errors[path] = str(exc)
    return errors


def load_config(path: str | os.PathLike[str] | None = None) -> Config:
    """Load from JSON. A missing file gives the defaults; a corrupt one raises ConfigError."""
    p = Path(path) if path is not None else DEFAULT_PATH
    if not p.exists():
        return Config()
    try:
        data = json.loads(p.read_text(encoding="utf-8"))
    except json.JSONDecodeError as exc:
        raise ConfigError(f"{p}: {exc}") from exc
    return Config.from_dict(data)


def save_config(cfg: Config, path: str | os.PathLike[str] | None = None) -> Path:
    """Write the whole tree as indented JSON (atomically). Creates the folder."""
    p = Path(path) if path is not None else DEFAULT_PATH
    p.parent.mkdir(parents=True, exist_ok=True)
    tmp = p.with_suffix(p.suffix + ".tmp")
    tmp.write_text(json.dumps(cfg.to_dict(), indent=2) + "\n", encoding="utf-8")
    os.replace(tmp, p)
    return p

