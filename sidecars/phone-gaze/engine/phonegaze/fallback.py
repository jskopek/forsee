"""Fallback pointer: a pointer from the fewest assumptions. Owner: Core.

``outputs.fallback_pointer`` turns this on (``"uncalibrated"``: only while no calibrated model is
in use; ``"always"``: instead of the models). It needs no calibration, so there is always a
pointer to look at while the rest is being tuned. It is rough by design.

How it works, per frame:

1. A gaze angle (yaw, pitch in degrees) from what the estimators measured, best first: the mean
   ``gaze_dir`` of the eyes (ARKit, or landmarks with the iris; the optical axis, kappa ignored);
   else the iris centre's position between the eye corners, scaled to degrees with a textbook
   eyeball (about 50 degrees across the eye opening), plus the head's yaw and pitch.
2. A slowly moving "centre" angle: an exponential average of that angle with time constant
   ``fallback_centre_s`` (0 = the average of the first second, then fixed). It assumes that, on
   average, the person looks around the middle of the screen.
3. The difference times ``fallback_gain`` times screen points per degree (from the screen's
   physical size and the measured distance; ``filters.points_per_degree`` when unknown) is added
   to the screen centre, then smoothed with time constant ``fallback_smoothing_s``.

Camera x points to the person's left for a camera facing them; the screen's x to their right, so
yaw is negated. ``fallback_flip_x`` / ``fallback_flip_y`` fix a mirrored image.
"""

from __future__ import annotations

import math
from typing import Any

import numpy as np

from .types import GazePoint, Observation, ScreenInfo

EYE_SPAN_DEG = 50.0
"""Rough eye rotation that moves the iris from one eye corner to the other."""


def gaze_angles(obs: Observation) -> tuple[float, float, str] | None:
    """``(yaw, pitch, source)`` in degrees, positive = person's right / up, or ``None``."""
    dirs = []
    for side in ("left", "right"):
        eye = obs.eye(side)
        if eye.blink:
            continue
        g = eye.gaze_dir
        if g is not None and len(g) == 3 and all(v is not None for v in g):
            v = np.asarray(g, float)
            n = np.linalg.norm(v)
            if n > 0:
                dirs.append(v / n)
    if dirs:
        v = np.mean(dirs, axis=0)
        # Camera coordinates: x right in the image (the person's left), y down, z away from the
        # phone towards the person; gaze points back towards the camera (z < 0).
        yaw = math.degrees(math.atan2(-v[0], -v[2]))
        pitch = math.degrees(math.atan2(-v[1], -v[2]))
        return yaw, pitch, "gaze_dir"
    offs = []
    for side in ("left", "right"):
        eye = obs.eye(side)
        if eye.blink or eye.iris_center is None or eye.inner_corner is None or eye.outer_corner is None:
            continue
        a, b = np.asarray(eye.inner_corner, float), np.asarray(eye.outer_corner, float)
        span = np.linalg.norm(b - a)
        if span <= 0:
            continue
        mid = (a + b) / 2
        d = (np.asarray(eye.iris_center, float) - mid) / span
        offs.append(d)
    if not offs:
        return None
    d = np.mean(offs, axis=0)
    yaw = -float(d[0]) * EYE_SPAN_DEG
    pitch = -float(d[1]) * EYE_SPAN_DEG
    hr = obs.head_rotation
    if hr is not None:
        face = -np.asarray(hr, float)[:, 2]  # the face points along the head frame's -z
        yaw += math.degrees(math.atan2(-face[0], -face[2]))
        pitch += math.degrees(math.atan2(-face[1], -face[2]))
    return yaw, pitch, "iris_in_eye"


class FallbackPointer:
    """See the module docstring. ``update`` returns a ``GazePoint`` or ``None``."""

    name = "fallback"

    def __init__(self) -> None:
        self.reset()

    def reset(self) -> None:
        self._centre: np.ndarray | None = None
        self._first: list[np.ndarray] = []
        self._t0: float | None = None
        self._t_last: float | None = None
        self._point: np.ndarray | None = None
        self.source = ""

    def update(self, obs: Observation | None, screen: ScreenInfo | None, now: float, cfg: Any, ppd_default: float = 45.0) -> GazePoint | None:
        if obs is None or screen is None:
            return None
        ang = gaze_angles(obs)
        if ang is None:
            return None
        yaw, pitch, self.source = ang
        a = np.array([yaw, pitch], float)
        dt = 0.0 if self._t_last is None else max(0.0, min(1.0, now - self._t_last))
        self._t_last = now
        tau_c = float(getattr(cfg, "fallback_centre_s", 20.0))
        if self._centre is None:
            if self._t0 is None:
                self._t0 = now
            self._first.append(a)
            if now - self._t0 < 1.0 and len(self._first) < 30:
                c = np.mean(self._first, axis=0)
            else:
                self._centre = np.mean(self._first, axis=0)
                c = self._centre
        else:
            if tau_c > 0 and dt > 0:
                k = 1.0 - math.exp(-dt / tau_c)
                self._centre = (1 - k) * self._centre + k * a
            c = self._centre
        ppd = ppd_default
        dist = obs.distance
        if dist and screen.width_mm and screen.width and screen.width_mm > 0:
            mm_per_pt = screen.width_mm / screen.width
            ppd = dist * 1000.0 * math.tan(math.radians(1.0)) / mm_per_pt
        gain = float(getattr(cfg, "fallback_gain", 1.0))
        d = (a - c) * gain * ppd
        if getattr(cfg, "fallback_flip_x", False):
            d[0] = -d[0]
        if getattr(cfg, "fallback_flip_y", False):
            d[1] = -d[1]
        p = np.array([screen.width / 2 + d[0], screen.height / 2 - d[1]])  # pitch up = screen y down
        p = np.clip(p, [-0.05 * screen.width, -0.05 * screen.height], [1.05 * screen.width, 1.05 * screen.height])
        tau_s = float(getattr(cfg, "fallback_smoothing_s", 0.4))
        if self._point is None or tau_s <= 0 or dt <= 0:
            self._point = p
        else:
            k = 1.0 - math.exp(-dt / tau_s)
            self._point = (1 - k) * self._point + k * p
        conf = 0.3 if self.source == "gaze_dir" else 0.15
        return GazePoint(x=float(self._point[0]), y=float(self._point[1]), t=obs.t, confidence=conf, valid=True, model="fallback", extra={"fallback_source": self.source, "angle_deg": [yaw, pitch]})
