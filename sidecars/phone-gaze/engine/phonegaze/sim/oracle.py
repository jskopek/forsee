"""Landmarks oracle: an estimator that reads the simulator's ground truth. Owner: Simulator.

MediaPipe's face landmarker DOES find the synthetic face (iris landmarks within a few pixels of
the truth, see tests/test_sim_render.py), so the normal estimator chain works on simulated
frames. This oracle exists so the rest of the loop (ROI placement, models, calibration, filters)
can be tested against perfect or controllably noisy measurements, independent of vision.

It is not registered in ``vision.REGISTRY`` (Vision owns that). Use it directly::

    from phonegaze.sim.oracle import OracleEstimator
    engine.estimators = [OracleEstimator(noise_px=0.3)]

It fills, per eye: ``found``, ``iris_center``, ``iris_radius``, ``iris_ellipse``,
``pupil_center``, ``reflection_center`` / ``reflection_corners`` (when the reflection is
visible), ``inner_corner``, ``outer_corner``, ``openness``, ``blink``, ``eyeball_center``,
``gaze_dir`` (the VISUAL axis; the optical axis is in ``extra["sim_oracle"]``) and
``confidence``; plus ``head_rotation``, ``head_position`` and ``distance``. Pixel values are
converted to the frame's upright rotation even if the engine chose a different one than the
simulator rendered with.
"""

from __future__ import annotations

from typing import Any

import numpy as np

from ..types import DecodedFrame, Observation, rotation_3d, rotation_affine


class OracleEstimator:
    name = "sim_oracle"

    def __init__(self, noise_px: float = 0.0, noise_3d_m: float = 0.0, seed: int = 0, fields: tuple[str, ...] | None = None) -> None:
        self.noise_px = float(noise_px)
        self.noise_3d_m = float(noise_3d_m)
        self.rng = np.random.default_rng(seed)
        self.fields = fields

    def _want(self, name: str) -> bool:
        return self.fields is None or name in self.fields

    def process(self, frame: DecodedFrame, previous: Observation | None) -> Observation | None:
        truth: dict[str, Any] | None = (frame.frame.header or {}).get("sim")
        if not truth or "eyes" not in truth:
            return None
        obs = previous if previous is not None else Observation.empty(frame)
        cam = frame.frame.camera
        rot_t = int(truth.get("rotation", frame.rotation))
        # truth upright pixels -> sensor -> this frame's upright pixels
        A = frame.sensor_to_upright @ np.linalg.inv(rotation_affine(rot_t, cam.width, cam.height))  # type: ignore[arg-type]
        R3 = frame.sensor_to_upright_3d @ rotation_3d(rot_t).T  # type: ignore[arg-type]
        lin = A[:2, :2]

        def px(p: list[float] | None, noisy: bool = True) -> tuple[float, float] | None:
            if p is None:
                return None
            x, y, _ = A @ np.array([p[0], p[1], 1.0])
            if noisy and self.noise_px > 0:
                x, y = x + self.rng.normal(0, self.noise_px), y + self.rng.normal(0, self.noise_px)
            return (float(x), float(y))

        def v3(p: list[float] | None, noise: float = 0.0) -> tuple[float, float, float] | None:
            if p is None:
                return None
            q = R3 @ np.asarray(p, dtype=float)
            if noise > 0:
                q = q + self.rng.normal(0, noise, 3)
            return (float(q[0]), float(q[1]), float(q[2]))

        blink = bool(truth.get("blink", False))
        name = self.name
        for side in ("left", "right"):
            e = truth["eyes"][side]
            pre = f"{side}."
            obs.set(pre + "found", not blink, name)
            obs.set(pre + "blink", blink, name)
            if self._want("openness"):
                obs.set(pre + "openness", e.get("openness"), name)
            if self._want("eyeball_center"):
                obs.set(pre + "eyeball_center", v3(truth.get(f"{side}EyeCenter"), self.noise_3d_m), name)
            if self._want("gaze_dir"):
                g = v3(truth.get(f"{side}GazeDir"))
                obs.set(pre + "gaze_dir", g, name)
            if self._want("corners"):
                obs.set(pre + "inner_corner", px(e.get("innerCorner")), name)
                obs.set(pre + "outer_corner", px(e.get("outerCorner")), name)
            if blink:
                obs.set(pre + "confidence", 0.0, name)
                continue
            if self._want("iris"):
                c = px(e["irisCenter"])
                obs.set(pre + "iris_center", c, name)
                obs.set(pre + "pupil_center", c, name)
                cx, cy, a, b, ang = e["irisEllipse"]
                ex, ey = px([cx, cy], noisy=False)  # type: ignore[misc]
                # Rotate the major-axis angle with the image.
                d = lin @ np.array([np.cos(np.radians(ang)), np.sin(np.radians(ang))])
                ang2 = float((np.degrees(np.arctan2(d[1], d[0])) + 90) % 180 - 90)
                obs.set(pre + "iris_ellipse", (ex, ey, float(a), float(b), ang2), name)
                obs.set(pre + "iris_radius", float(e["irisRadius"]), name)
            if self._want("reflection") and e.get("reflectionVisible"):
                obs.set(pre + "reflection_center", px(e["reflectionCenter"]), name)
                obs.set(pre + "reflection_corners", [px(p) for p in e["reflectionCorners"]], name)
                obs.set(pre + "reflection_score", 1.0, name)
            obs.set(pre + "confidence", 1.0, name)
            getattr(obs, side).extra["sim_oracle"] = {"optical_dir": list(v3(truth.get(f"{side}OpticalDir")) or [])}
        if self._want("head"):
            Rh = np.asarray(truth["headRotation"], dtype=float)
            obs.set("head_rotation", (R3 @ Rh).tolist(), name)
            obs.set("head_position", v3(truth.get("headPosition"), self.noise_3d_m), name)
            obs.set("distance", float(truth.get("distance")) if truth.get("distance") is not None else None, name)
        obs.extra.setdefault("sim_oracle", {})["gaze"] = truth.get("gaze")
        return obs
