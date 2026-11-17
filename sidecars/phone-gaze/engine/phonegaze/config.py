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
lab             Lab (offline scoring: lab.py, tune.py)
second_camera   second camera (experimental, ``phonegaze/second_camera``)
collect         Core (guided collection run, ``collect.py``)
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
    roi_smoothing: float = setting(0.5, "Eye crops: how much each crop's placement keeps of its previous size (0 = follows every frame, 0.9 = very steady).", min=0, max=0.95)
    roi_move_fraction: float = setting(0.1, "Eye crops: new crop rectangles are sent to the phone only when an eye moves by more than this fraction of the crop size.", min=0.02, max=0.5)
    depth: bool = setting(False, "Ask the phone to stream its depth map when a depth sensor runs (TrueDepth or LiDAR), for estimators.distance_source 'depth'. Optional on the phone; ignored where unsupported.")


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
    zoom_stable_s: float = setting(1.0, "Auto zoom: the eyes must sit comfortably inside the frame this long before zooming back in (hysteresis).", min=0.2, max=10, unit="s")
    zoom_cooldown_s: float = setting(2.0, "Auto zoom: no zoom change within this long of the previous one.", min=0.5, max=30, unit="s")
    zoom_lost_s: float = setting(1.5, "Auto zoom: zoom out to 1x when the eyes have been lost this long.", min=0.2, max=10, unit="s")
    exposure_bias: float = setting(0.0, "Exposure compensation sent to the phone (EV; positive brightens). Dark irises or a backlit face often want +0.3 to +1. Rear and front cameras only (not ARKit).", min=-3, max=3, unit="EV")
    max_exposure_ms: float = setting(0.0, "Cap on the shutter time automatic exposure may choose: shorter means less motion blur but more noise. 0 = no cap (phone default). Try 8-16 ms.", min=0, max=100, unit="ms")
    focus_locked: str = setting("default", "Focus lock sent to the phone: 'default' (leave it to the phone and to aiming), 'locked' or 'continuous'.", choices=["default", "locked", "continuous"])
    focus_on_eye: bool = setting(False, "Tap-to-focus on an eye: every few seconds while unlocked, ask the phone to focus (and meter) on the left eye's position.")
    focus_on_eye_s: float = setting(5.0, "Tap-to-focus on an eye: seconds between focus requests.", min=1, max=60, unit="s")
    exposure_locked: bool = setting(False, "Lock the exposure where it is now (sent to the phone).")
    white_balance_locked: bool = setting(False, "Lock the white balance where it is now (sent to the phone).")
    camera_prefer: str = setting("auto", "Which camera to use when lens.camera_id is empty (and to switch to when this changes while connected): 'auto' (the engine's ranking), 'arkit' (front TrueDepth with ARKit face tracking), 'front' (front camera images), 'back' (rear wide camera). Presets set this rather than a phone-specific camera id.", choices=["auto", "arkit", "front", "back"])
    face_driven_autofocus: str = setting("default", "The phone's face-driven autofocus and exposure: 'default' (leave as is), 'on' or 'off'. Off stops it refocusing on the nose or cheeks.", choices=["default", "on", "off"])


@dataclass
class EstimatorsConfig:
    order: list[str] = setting(
        ["arkit", "landmarks", "iris_edge", "reflection", "quality"],
        "Estimators to run, in order. Each refines the observation the previous ones built.",
        choices=["arkit", "landmarks", "iris_edge", "reflection", "appearance", "quality"],
    )
    landmarks_model: str = setting("face_landmarker.task", "MediaPipe face landmarker model file in the models folder.")
    landmarks_every: int = setting(1, "Run face landmarks every Nth frame and track in between.", min=1, max=10)
    # Tuning switches below are read by the estimators on every frame, so they apply live.
    use_arkit: bool = setting(True, "Run the ARKit estimator (if it is in 'order'). Off: ignore Apple's eye and head transforms even in ARKit mode.")
    use_landmarks: bool = setting(True, "Run the MediaPipe face landmarks estimator (if it is in 'order'). Off: eyes are found by the iris finder on the eye crops alone.")
    use_iris_edge: bool = setting(True, "Run the sub-pixel iris edge fit (if it is in 'order'). Off: iris centres stay as landmarks or ARKit gave them.")
    use_reflection: bool = setting(True, "Run the screen reflection estimator (if it is in 'order').")
    use_quality: bool = setting(True, "Run the image quality estimator (if it is in 'order').")
    face_confidence: float = setting(0.3, "Face landmarks: minimum face detection and presence confidence (MediaPipe). Lower finds faces in poor light or at odd angles but risks false faces.", min=0.05, max=0.95)
    face_attempts: int = setting(3, "Face landmarks: how many places are tried per frame when the face is lost (around the last face, the whole frame, the padded frame, one tile of a grid). More finds small or clipped faces sooner but costs time.", min=1, max=6)
    face_tiles: bool = setting(True, "Face landmarks: when the face is lost, also search one tile of a 3x3 grid per frame (helps small faces far from the camera).")
    face_min_crop_px: int = setting(320, "Face landmarks: a small face is cut out and enlarged to at least this many pixels before detection.", min=128, max=1024, unit="px")
    head_smoothing_s: float = setting(0.0, "Face landmarks: time constant for smoothing the head pose (rotation and position) between frames. 0 = off. Steadier head-compensated gaze, slower to follow real head moves.", min=0, max=2, unit="s")
    iris_fit: str = setting("ellipse", "Iris edge: shape fitted to the limbus. 'ellipse' (RANSAC ellipse, follows the iris turning away) or 'circle' (fewer unknowns; steadier when lids hide much of the iris, slightly biased at large gaze angles).", choices=["ellipse", "circle"])
    iris_edge_keep: float = setting(0.35, "Iris edge: a ray's limbus edge is used only if its strength is at least this fraction of the 90th percentile of all rays. Higher drops weak edges (lids, lashes) but leaves fewer points.", min=0.05, max=0.9)
    iris_subpixel: bool = setting(True, "Iris edge: refine each edge point to sub-pixel precision with a parabola through the gradient peak. Off: whole-sample edge positions (for comparison).")
    iris_lid_mask_upper_deg: float = setting(0.0, "Iris edge: ignore limbus rays within this many degrees either side of straight up (the upper lid usually covers the top of the iris). 0 = off; 40-60 is typical.", min=0, max=80, unit="deg")
    iris_lid_mask_lower_deg: float = setting(0.0, "Iris edge: ignore limbus rays within this many degrees either side of straight down (the lower lid). 0 = off.", min=0, max=80, unit="deg")
    iris_ransac: int = setting(80, "Iris edge: RANSAC iterations per fit. More is more robust to outliers and slower.", min=10, max=400)
    iris_inlier_px: float = setting(0.04, "Iris edge: a limbus point counts as on the fitted shape within this fraction of the iris radius (at least 1 px).", min=0.01, max=0.2)
    iris_min_confidence: float = setting(0.05, "Iris edge: fits with a confidence below this are thrown away (confidence: share of rays that agree, and how tightly).", min=0, max=0.9)
    iris_radius_gate: float = setting(1.6, "Iris edge: a fit is rejected if its radius differs from the rough guess by more than this factor (and its centre by more than 0.6 radii).", min=1.1, max=3.0)
    iris_track_frames: int = setting(6, "Iris edge: after a successful fit, the next fits start from it for up to this many frames when no other estimator gives a rough position.", min=0, max=60)
    iris_diameter_mm: float = setting(11.7, "Assumed visible iris diameter, used to turn iris size into distance. Adults: 11.0-12.5 mm (10.2-13.0 extreme). If distances look consistently off, measure yours or adjust this.", min=9.5, max=13.5, unit="mm")
    distance_source: str = setting(
        "auto",
        "Where the viewing distance comes from (it scales eyeball positions and the reflection size). 'auto': ARKit when tracking, else the iris size refined by the iris fit, else the eye-corner span; "
        "'depth': the phone's depth map at the eyes when one is streamed (stream.depth), else auto; 'iris': iris size only; 'head': eye-corner span and head model only (ignores the iris); 'fixed': fixed_distance_m.",
        choices=["auto", "depth", "iris", "head", "fixed"],
    )
    fixed_distance_m: float = setting(0.6, "Distance used when distance_source is 'fixed'.", min=0.15, max=2.0, unit="m")
    distance_smoothing_s: float = setting(0.0, "Time constant for smoothing the viewing distance between frames (applied by the quality estimator, after every distance cue). The per-frame distance from iris size is noisy on the rear camera, and its noise moves the eyeball centres and head position; 2-10 s holds it near its recent average, 30 s nearly fixes it. 0 = off. ARKit distances are left alone.", min=0, max=60, unit="s")
    reflection_k_mad: float = setting(5.0, "Reflection: a pixel is a highlight candidate if its top-hat value is this many robust standard deviations (MAD) above the iris median. Lower finds dim reflections and more false ones.", min=1, max=20)
    reflection_min_contrast: float = setting(10.0, "Reflection: minimum brightness above the iris background (0-255 levels) for a highlight candidate.", min=1, max=80)
    reflection_min_confidence: float = setting(0.3, "Reflection: a detection with a lower score is dropped (never unsure: better nothing than the wrong highlight).", min=0, max=0.95)
    reflection_ambiguity: float = setting(0.6, "Reflection: with no flash prior or recent track, a frame is rejected when the second-best highlight scores at least this fraction of the best. Higher accepts more ambiguous frames.", min=0.1, max=1.0)
    reflection_max_offset: float = setting(0.6, "Reflection: a highlight further than this from the iris centre (in iris radii) is ignored (the limbus distorts it).", min=0.2, max=1.2)
    reflection_area_min: float = setting(0.25, "Reflection: smallest highlight area accepted, as a fraction of the area predicted for this screen at this distance.", min=0.02, max=1.0)
    reflection_area_max: float = setting(3.0, "Reflection: largest highlight area accepted, as a multiple of the predicted area. Raise for a big external display or a bright window behind you.", min=1.0, max=20.0)
    reflection_min_iris_px: float = setting(12.0, "Reflection: skip eyes whose iris radius in the image used is below this (too small to see the reflection).", min=4, max=60, unit="px")
    reflection_coded_flash: bool = setting(True, "Reflection: learn where the screen reflection sits from coded screen flashes (calibration's 'Flash the screen', glint blink bursts) and use it to pick the right highlight. Off: static detection only.")
    reflection_flash_min_corr: float = setting(0.6, "Reflection: a coded flash is trusted only if the best pixel's correlation with the code reaches this.", min=0.2, max=0.95)
    reflection_max_lag_ms: float = setting(400.0, "Reflection: longest display-to-engine delay searched when decoding a coded flash.", min=50, max=1500, unit="ms")


@dataclass
class ModelsConfig:
    candidates: list[str] = setting(
        ["geometric", "ridge", "kernel", "reflection", "blend"],
        "Gaze models fitted after every calibration.",
        choices=["geometric", "ridge", "kernel", "reflection", "blend", "residual", "hybrid"],
    )
    pinned: str = setting("", "Always use this model. Empty: use the best leave-one-dot-out score.")
    ridge_alpha: float = setting(1.0, "Ridge regression regularisation.", min=0, max=1000)
    auto_alpha: bool = setting(True, "Choose the ridge regularisation by leave-one-dot-out (ignores ridge_alpha).")
    kappa_prior_sd_deg: float = setting(2.5, "Geometric model: how far each eye's kappa may move from 5 deg nasal, 1.5 up, when several head positions were calibrated.", min=0.1, max=10, unit="deg")
    smooth_centre_s: float = setting(0.3, "Geometric model: time constant for smoothing eyeball-centre jitter (0 = off).", min=0, max=2, unit="s")
    eyeball_centre: str = setting(
        "estimator",
        "Geometric model: where each eyeball's rotation centre comes from. 'estimator' = as measured each frame (from the eye corners or ARKit); "
        "'per_eye' = measured, plus a fixed per-eye 3D correction in the head's own frame, learned when the head moved during calibration (head sweep or several head positions); "
        "'head' = a fixed per-eye point in the head's frame, placed by the head pose alone, so the eye-corner landmarks no longer matter; "
        "'auto' = 'head' when the head moved during calibration (head sweep or several head positions), else 'estimator'. The corrections are held near their prior unless the head moved.",
        choices=["estimator", "per_eye", "head", "auto"],
    )
    eyeball_centre_sd_mm: float = setting(2.0, "Geometric model: how far (SD) the per-eye eyeball-centre correction may move from where the estimator put it. Smaller trusts the estimator more.", min=0.2, max=10, unit="mm")
    eye: str = setting(
        "both",
        "Which eye the geometric model (and the blends built on it) uses: both (confidence-weighted), left, right, or 'auto' = the eye with the lower held-out error when it is clearly better (by eye_auto_margin). The report shows per-eye scores either way.",
        choices=["both", "left", "right", "auto"],
    )
    eye_auto_margin: float = setting(0.15, "Eye 'auto': a single eye is chosen only if its held-out error is at least this fraction lower than both eyes together.", min=0, max=0.8)
    eyelid_feature: bool = setting(False, "Ridge, kernel and reflection models: also use each eye's lid opening (lid gap / eye-corner span) as a feature. The upper lid follows the eye up and down, so it carries vertical gaze when the lid hides the top of the iris. Off: as before.")
    hybrid_ref_lo: float = setting(0.3, "Hybrid model (reflection + geometric): reflection score at or below which the reflection gets no weight.", min=0, max=1)
    hybrid_ref_hi: float = setting(0.7, "Hybrid model: reflection score at or above which the reflection gets its full weight.", min=0, max=1)
    hybrid_tau_s: float = setting(0.25, "Hybrid model: time constant over which the reflection weight follows detection, so the pointer does not jump when the reflection comes and goes.", min=0, max=3, unit="s")


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
    drift_correction: bool = setting(False, "Drift correction from selections: shift the gaze output by a small offset learned from the keys you select in Forsee by dwell (each one is a place you looked). Off: the offset is still learned and scored (Experiments page, 'with / without' numbers) but not applied.")
    drift_rate: float = setting(0.5, "Drift correction: how fast it adapts, as the drift speed it expects. Higher follows drift faster but lets each selection move it more.", min=0.05, max=5, unit="deg/min")
    drift_clicks: bool = setting(False, "Drift correction: also learn from mouse clicks on targets (weaker evidence than a dwell selection).")
    layout: str = setting("grid", "Where the full-calibration dots go: 'grid' (the grid above), 'grid_plus' (the grid plus a dot between each group of four, more dots in the middle), 'edges' (the grid plus extra dots along the edges, where errors are usually worst).", choices=["grid", "grid_plus", "edges"])
    dot_order: str = setting("serpentine", "Order of the dots: row by row ('serpentine') or shuffled ('random', the eyes cannot anticipate the next dot).", choices=["serpentine", "random"])
    discard_ms: int = setting(150, "Samples in this long after a dot starts collecting are thrown away (the eyes are still landing), on top of the settle time.", min=0, max=1500, unit="ms")
    stability_deg: float = setting(3.0, "A dot is rejected if its samples scatter more than this (gaze not steady).", min=0.5, max=15, unit="deg")
    min_samples: int = setting(4, "A dot needs at least this many good samples.", min=2, max=60)
    sample_weighting: str = setting("per_dot", "How dots count in the fit: every dot equally ('per_dot'), steadier dots more ('precision', each dot weighted by 1 / its scatter squared, capped), or every sample equally ('per_sample', dots with more samples count more).", choices=["per_dot", "precision", "per_sample"])
    head_sweep: int = setting(0, "Head sweep: after the grid, look at a dot while slowly turning and moving your head for about sweep_s seconds, for this many dots (0 = off). Teaches the geometric model where your eyeballs sit in your head (models.eyeball_centre 'per_eye' or 'head' uses it).", min=0, max=3)
    sweep_s: float = setting(10.0, "Head sweep: seconds per dot.", min=3, max=30, unit="s")
    sweep_window_ms: int = setting(300, "Head sweep: samples are grouped into windows this long; each window is one fitting row at its own head pose.", min=100, max=2000, unit="ms")
    sweep_weight: float = setting(3.0, "Head sweep: total weight of one sweep dot in the fit, in grid dots (spread over its windows).", min=0, max=20)
    pursuit_merge: str = setting("off", "Moving dot: merge its samples into the grid fit ('auto' = only if that lowers the held-out error of the grid dots; 'on' = always; 'off' = never, the moving dot is only reported, as before). Try 'auto' with calibration.moving_dot on.", choices=["auto", "on", "off"])
    pursuit_weight: float = setting(0.25, "Moving dot: weight of each 250 ms piece of the path relative to a grid dot, when merged.", min=0, max=2)
    pursuit_lag_ms: float = setting(-1.0, "Moving dot: how far the eyes trail the dot. -1 = estimate it from the data (0-400 ms); otherwise this fixed value.", min=-1, max=600, unit="ms")
    pursuit_saccade_deg_s: float = setting(60.0, "Moving dot: samples where gaze moves faster than this are catch-up saccades and are dropped.", min=10, max=500, unit="deg/s")
    pursuit_max_error_deg: float = setting(5.0, "Moving dot: samples further than this from the lagged dot (by the grid fit) are dropped.", min=1, max=20, unit="deg")
    quality_gate: bool = setting(False, "After the grid, show again (once) the dots that were rejected, scattered or far off, and keep the better attempt. Off by default (calibration runs as before); worth turning on.")
    gate_residual_deg: float = setting(2.5, "Quality gate: a dot whose held-out error (quick fit) is above this, and above twice the median dot, is shown again.", min=0.5, max=10, unit="deg")
    gate_scatter_deg: float = setting(1.5, "Quality gate: a dot whose samples scatter more than this is shown again.", min=0.2, max=10, unit="deg")
    gate_max_dots: int = setting(4, "Quality gate: at most this many dots are shown again.", min=0, max=16)
    error_map: str = setting("off", "Error map: a smooth correction over the screen learned from validation dots (and touch-ups). 'off'; 'affine' (shift, scale and shear); 'quadratic'; 'tps' (thin-plate spline, bends locally). Kept only if leave-one-dot-out says it helps.", choices=["off", "affine", "quadratic", "tps"])
    error_map_smoothing: float = setting(1.0, "Error map: regularisation. Higher is smoother and closer to no correction.", min=0.01, max=100)
    error_map_min_gain: float = setting(0.05, "Error map: kept only if it lowers the leave-one-dot-out error by at least this fraction.", min=0, max=0.5)
    touchup_dots: int = setting(4, "Touch-up after validation: how many of the worst dots to show again.", min=1, max=9)


@dataclass
class FiltersConfig:
    kind: str = setting("one_euro", "Smoothing filter.", choices=["none", "one_euro", "kalman", "fixation"])
    min_cutoff: float = setting(1.0, "One-euro minimum cutoff frequency.", min=0.01, max=10, unit="Hz")
    beta: float = setting(0.01, "One-euro speed coefficient.", min=0, max=1)
    blink_hold_ms: int = setting(150, "Hold the last point this long during a blink before reporting invalid.", min=0, max=1000, unit="ms")
    fixation_deg: float = setting(1.5, "Dispersion threshold for fixations.", min=0.1, max=5, unit="deg")
    saccade_deg: float = setting(2.5, "A jump this large (confirmed by the next sample) is a saccade: the smoother resets and the output snaps.", min=0.5, max=10, unit="deg")
    fixation_tau_ms: int = setting(250, "Time constant of the fixation centre ('fixation' filter).", min=20, max=2000, unit="ms")
    points_per_degree: float = setting(45.0, "Screen points per degree of gaze when the screen size or distance is unknown.", min=5, max=200, unit="pt")
    preset: str = setting("custom", "Filter preset. 'custom' uses the settings below as they are; 'responsive' (little smoothing, low lag), 'balanced', 'steady' (heavy smoothing, more lag) override kind, min_cutoff, beta and saccade_deg.", choices=["custom", "responsive", "balanced", "steady"])
    fixation_lock: bool = setting(False, "Hold the pointer completely still while you fixate (inside fixation_deg), releasing it on a saccade or when gaze drifts out. Steadier dwell clicks; the pointer moves in steps.")
    fixation_lock_ms: int = setting(120, "Fixation lock: how long gaze must stay inside fixation_deg before the pointer locks.", min=0, max=1000, unit="ms")


@dataclass
class OutputsConfig:
    cursor: bool = setting(False, "Move the system cursor (needs Accessibility permission on macOS).")
    dwell_click: bool = setting(False, "Click when gaze rests in one place.")
    dwell_ms: int = setting(800, "Dwell time before a click.", min=200, max=5000, unit="ms")
    dwell_radius_pt: float = setting(40.0, "How still gaze must be for a dwell.", min=5, max=300, unit="pt")
    websocket: bool = setting(True, "Stream gaze samples on ws://host:port/gaze (for Forsee).")
    websocket_rate_hz: float = setting(60.0, "Maximum gaze samples per second on the WebSocket.", min=1, max=240, unit="Hz")
    fallback_pointer: str = setting(
        "off",
        "Fallback pointer (fallback.py): a pointer from the fewest assumptions, so there is always something to see while tuning. It turns the eyes' measured direction (ARKit or landmarks plus iris) into a screen point around a slowly self-centring middle, with heavy smoothing; no calibration needed. "
        "'off'; 'uncalibrated' (only while no calibrated model is in use); 'always' (replaces the calibrated models). Rough by design: expect several degrees of error.",
        choices=["off", "uncalibrated", "always"],
    )
    fallback_gain: float = setting(1.0, "Fallback pointer: how far the pointer moves per degree of eye rotation, relative to the geometric expectation (1 = a degree of gaze moves it a degree on the screen).", min=0.2, max=5)
    fallback_centre_s: float = setting(20.0, "Fallback pointer: time constant over which the screen centre follows your average gaze direction (it assumes you look around the middle on average). 0 = fixed at the first second.", min=0, max=300, unit="s")
    fallback_smoothing_s: float = setting(0.4, "Fallback pointer: time constant of its own smoothing (on top of the filter).", min=0, max=3, unit="s")
    fallback_flip_x: bool = setting(False, "Fallback pointer: mirror left and right (if the pointer moves the wrong way sideways, e.g. with a mirrored front camera).")
    fallback_flip_y: bool = setting(False, "Fallback pointer: mirror up and down.")


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
    orientation: int = setting(180, "Degrees the engine must turn the simulated sensor image clockwise to make it upright (gravity is set to match).", choices=[0, 90, 180, 270])
    script: str = setting("still", "Simulated head and eye motion.", choices=["still", "drift", "sway", "move", "look_around"])
    human_look: bool = setting(True, "The simulated person reacts to /sim/gaze with a human delay and saccade (off: the eyes jump instantly).")
    render_workers: int = setting(-1, "Processes that render simulated frames (-1: automatic, 0: render in a thread).", min=-1, max=16)
    noise: float = setting(2.0, "Simulated sensor noise (standard deviation, 0-255 levels).", min=0, max=50)


@dataclass
class UIConfig:
    theme: str = setting("auto", "Colour theme of the browser UI.", choices=["auto", "light", "dark"])
    show_debug: bool = setting(True, "Show raw observations and estimator overlays.")
    glint_marker: str = setting("off", "Glint assist: draw bright markers on every engine page (calibration included) so the screen's corneal reflection is bigger and easier to find: 'off', 'border' (a white frame round the window) or 'corners' (white squares in the four corners).", choices=["off", "border", "corners"])
    glint_marker_px: int = setting(24, "Glint assist: border width or corner square size.", min=4, max=200, unit="px")
    glint_blink: bool = setting(False, "Glint assist: every glint_blink_every_s, blink the markers (or the whole window when glint_marker is 'off') for about 2 s with a code the engine knows, so the reflection estimator re-learns where the reflection sits. Skipped while a calibration flash runs.")
    glint_blink_every_s: float = setting(30.0, "Glint assist: seconds between blink bursts.", min=5, max=600, unit="s")
    glint_pattern: str = setting("10110010@125", "Glint assist: the blink code, characters 0/1, one per step, then @ and the step in ms.")
    glint_brightness_prompt: bool = setting(True, "Glint assist: remind you on the Tuning page to turn the screen brightness up (the browser cannot do it); a brighter screen gives a brighter reflection.")
    tuning_crop_px: int = setting(420, "Tuning page: width each eye crop is shown at.", min=160, max=1200, unit="px")
    tuning_rate_hz: float = setting(4.0, "Tuning page: how often the eye images refresh.", min=0.5, max=15, unit="Hz")
    simple_mode: bool = setting(True, "Dashboard: show the five main actions (Collect data, Run sweep, Apply best preset, Calibrate, Validate) with everything else folded under Advanced. Off: the full dashboard, as before.")


@dataclass
class DiagnosticsConfig:
    """Owner: Diagnostics (``diagnostics.py``, ``doctor.py``). Logging, the health strip, the
    doctor checklist and the diagnostics bundle."""

    log_file: bool = setting(True, "Write the engine's log to a rotating file in ~/.phonegaze/logs (one line for every state change and every failure).", restart=True)
    log_level: str = setting("INFO", "Lowest level written to the log file. DEBUG is very chatty.", choices=["DEBUG", "INFO", "WARNING"], restart=True)
    log_max_mb: float = setting(5.0, "Size of each log file before it rotates.", min=0.1, max=100, unit="MB", restart=True)
    log_backups: int = setting(3, "Rotated log files kept besides the current one.", min=0, max=20, restart=True)
    log_state_changes: bool = setting(True, "Log a line whenever something changes state: phone, camera, face found or lost, calibration, model, cursor, shortcuts, pause, recording.")
    health_window_s: float = setting(5.0, "Health strip: the last this many seconds of frames are counted for each stage's success rate.", min=1, max=60, unit="s")
    health_broadcast: bool = setting(True, "Send the health strip to the browser UI once a second (WebSocket message 'health').")
    doctor_seconds: float = setting(5.0, "How long the doctor watches live frames before judging each stage.", min=1, max=30, unit="s")
    bundle_seconds: float = setting(10.0, "Seconds of recent observations (numbers only, no images) kept for a diagnostics bundle.", min=1, max=120, unit="s")
    bundle_images: bool = setting(False, "Tick 'include images' by default when making a diagnostics bundle. Images show your face; the bundle stays on this Mac.")


@dataclass
class LabConfig:
    """Owner: Lab (``lab.py``, ``tune.py``). The offline lab: ``python -m phonegaze lab``, ``tune``
    and ``ab`` score recorded sessions. These settings change only offline scoring, never the
    live engine."""

    frame_mode: str = setting("live", "Lab: how recorded video reaches the estimators. 'live' cuts it the way the phone stream would (downscaled whole frame at stream.wide_width plus native-resolution eye crops of stream.roi_width_mm), so scores describe the live engine; 'full' gives them the whole native frame (slower, no frame cache).", choices=["live", "full"])
    every: int = setting(2, "Lab: use every Nth video frame (1 = all; 2 halves the work).", min=1, max=30)
    settle_s: float = setting(0.7, "Lab: skip this much of each recorded dot while the eyes are still travelling.", min=0, max=3, unit="s")
    pursuit_skip_s: float = setting(1.0, "Lab: skip the first part of the moving dot, while the eyes catch it.", min=0, max=10, unit="s")
    pursuit_lag_ms: float = setting(100.0, "Lab: the eyes trail a moving dot by about this much; scores compare gaze with where the dot was this long before.", min=0, max=500, unit="ms")
    rotation: str = setting("detect", "Lab: how to turn recorded video upright. 'detect' tries all four rotations on the first frames and keeps the one where a face is found (and reports whether gravity agrees); 'auto' trusts gravity; or a fixed clockwise rotation.", choices=["detect", "auto", "0", "90", "180", "270"])
    combos: list[str] = setting(["default", "landmarks", "landmarks+iris_edge"], "Lab: estimator combinations to compare. 'default' is estimators.order; others are estimator names joined with '+'.")
    eye: str = setting("both", "Lab: which eye the models may use ('left' or 'right' blanks the other eye, the person's own left and right).", choices=["both", "left", "right"])
    distance_fallback: bool = setting(True, "Lab: when no estimator measured the viewing distance, use the eye-to-phone distance typed into the eye-capture form, so errors can still be given in degrees.")
    cache_roi_mm: float = setting(50.0, "Lab: width of the eye crops kept in the frame cache. Must be at least stream.roi_width_mm; crop-size experiments up to this width reuse the cache instead of decoding the video again.", min=10, max=120, unit="mm")
    save_eye_images: bool = setting(False, "Lab: also save one annotated eye crop per dot (iris fit drawn on it) next to the report. They show the eyes; they stay in the lab output folder on this computer.")
    output_dir: str = setting("~/.phonegaze/lab", "Lab: where reports, caches and presets made by tune go. Never inside the repository.")
    folds: int = setting(5, "Lab tune and A/B: number of outer hold-out folds of dots. Settings are chosen on the other folds and scored on each held-out fold.", min=2, max=20)
    metric: str = setting("loo", "Lab tune: what 'best' means. 'loo' = leave-one-dot-out error of each dot's mean (accuracy); 'loo_sample' = per-frame error after the filter (accuracy and noise); 'pursuit' = train on the grid, score the moving dot after the filter.", choices=["loo", "loo_sample", "pursuit"])


# --- second camera (experimental; owner: phonegaze/second_camera, docs/SECOND_CAMERA.md) -------
@dataclass
class SecondCameraConfig:
    enabled: bool = setting(False, "Second camera (experimental): use the Mac's built-in camera as a position anchor next to the phone. Off: nothing below has any effect and the webcam is never opened.")
    source: str = setting("auto", "Where webcam frames come from: the Mac's camera ('opencv'), the simulator's second camera ('sim'), a video file or image folder ('file'), or 'auto' (the simulator's when the phone is simulated, else the Mac's).", choices=["auto", "opencv", "sim", "file"])
    camera_index: int = setting(0, "Webcam index for OpenCV (0 is usually the built-in FaceTime camera).", min=0, max=9)
    file_path: str = setting("", "Video file or image folder for source 'file' (synthetic test footage only; never commit real faces).")
    width: int = setting(1280, "Webcam frame width to request.", min=320, max=3840, unit="px")
    height: int = setting(720, "Webcam frame height to request.", min=240, max=2160, unit="px")
    fps: float = setting(15.0, "Webcam frame rate to request (the face landmarks run at this rate on their own thread).", min=1, max=60, unit="fps")
    hfov_deg: float = setting(68.0, "Assumed horizontal field of view of the webcam (its intrinsics are unknown). The self-check compares webcam and phone distances; a consistent ratio means this is off.", min=30, max=120, unit="deg")
    offset_mm: float = setting(8.0, "Webcam lens centre above the top edge of the visible screen area, in the screen's plane.", min=-20, max=60, unit="mm")
    tilt_deg: float = setting(0.0, "Webcam optical axis tilt from the screen normal (positive: looks further down).", min=-20, max=20, unit="deg")
    solve_method: str = setting("poses", "Phone-pose solve: compose the two head poses per frame ('poses'), align eye positions over time without head rotations ('points'), or points once the head has moved enough and poses until then ('hybrid').", choices=["poses", "points", "hybrid"])
    window_s: float = setting(20.0, "Phone-pose solve: seconds of paired frames averaged (robustly) into one pose.", min=2, max=300, unit="s")
    min_pairs: int = setting(20, "Phone-pose solve: paired frames needed before the pose is reported as anchored.", min=3, max=1000)
    max_skew_ms: float = setting(80.0, "Phone-pose solve: largest time gap to a webcam frame on each side for interpolating it to the phone frame's time.", min=10, max=500, unit="ms")
    move_rotation_dps: float = setting(6.0, "Phone moved: rotation rate (from the phone's gyro) above which the phone counts as moving.", min=0.5, max=90, unit="deg/s")
    move_gravity_deg: float = setting(1.5, "Phone moved: change of the phone's gravity direction since the pose was anchored that counts as a move.", min=0.2, max=20, unit="deg")
    move_vision: bool = setting(True, "Phone moved: also re-anchor when recent paired frames consistently disagree with the anchored pose (catches moves the gyro missed).")
    screen_pose: str = setting("off", "Geometric model 'geometric_2cam': take the screen pose from the phone-pose solve ('fixed': calibration learns only the person, so fewer dots do), use it as a prior for the calibration's own solve ('prior'), or do not add the model ('off').", choices=["off", "fixed", "prior"])
    track_phone: bool = setting(False, "After calibration, apply changes of the solved phone pose to every observation, so the calibration survives the phone being moved (all models).")
    distance_source: str = setting("phone", "Eye distance and eyeball positions fed to the models: the phone's own estimate, or triangulated from both cameras.", choices=["phone", "triangulated"])
    head_pose_source: str = setting("phone", "Head rotation and position fed to the models: the phone's, the webcam's (moved into phone coordinates), or a fused average.", choices=["phone", "webcam", "fused"])
    wide_head_box: bool = setting(False, "When the phone loses the eyes, steer its eye crops (and zoom out) to where the webcam says the eyes are, and keep a coarse webcam gaze flowing marked low confidence.")
    webcam_model: bool = setting(False, "Also fit 'webcam': webcam-only gaze with the screen pose known from the display geometry, a baseline to measure the phone against on the same calibration.")
    head_ray_correction: bool = setting(True, "Phone-pose solve and head pose source: turn MediaPipe's head rotation (relative to the line of sight to the face) into camera coordinates. Off: use it as the landmarks estimator reports it.")


@dataclass
class CollectConfig:
    """Guided collection run (``collect.py``, Collect page): record one fixed protocol per physical setup for the offline sweep."""

    protocol: str = setting("medium", "Collection run: protocol length per condition: 'short' (about 1 minute), 'medium' (about 2) or 'long' (about 3). The same for every condition of a run.", choices=["short", "medium", "long"])
    pursuit: bool = setting(True, "Collection run: end each condition with a short moving dot.")
    settle_s: float = setting(1.5, "Collection run: focus and exposure must have stopped adjusting this long (on the requested camera and zoom) before a condition may start.", min=0, max=30, unit="s")
    poor_eyes_pct: float = setting(80.0, "Collection run: a condition is flagged 'poor data' (and a redo offered) when both eyes were found in fewer than this percentage of its frames.", min=0, max=100, unit="%")
    short_shutter_ms: float = setting(8.0, "Collection run: the shutter cap of the 'short shutter' conditions in the ready-made sets.", min=1, max=50, unit="ms")
    setup_estimate_s: float = setting(30.0, "Collection run: time allowed per condition for switching camera and settling, in the run's time estimate.", min=0, max=600, unit="s")


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
    diagnostics: DiagnosticsConfig = field(default_factory=DiagnosticsConfig)
    lab: LabConfig = field(default_factory=LabConfig)
    second_camera: SecondCameraConfig = field(default_factory=SecondCameraConfig)  # experimental, see SecondCameraConfig
    collect: CollectConfig = field(default_factory=CollectConfig)  # guided collection run (collect.py)

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

