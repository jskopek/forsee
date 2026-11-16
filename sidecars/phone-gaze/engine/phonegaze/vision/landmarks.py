"""Face landmarks estimator: MediaPipe Face Landmarker on the downscaled whole frame. Owner: Vision.

Fills: ``face_rect``; per eye ``found``, ``inner_corner``, ``outer_corner``, ``openness``,
``blink``, a rough ``iris_center``/``iris_radius`` (the 478-point mesh's iris points),
``eyeball_center`` and ``gaze_dir`` (simple eye model, :mod:`.geometry`), ``confidence``; and
``head_rotation`` (rotation of MediaPipe's facial transformation matrix, converted to the engine
head frame), ``head_position`` and ``distance`` (from the outer eye-corner span and the iris size
with the frame's intrinsics; MediaPipe's own translation assumes a different virtual camera and is
not used). ``extra["landmarks"]`` holds eye rectangles for crop placement, head angles, the
distance cues and the eye blend shapes.

Finding small or clipped faces: the face detector inside the landmarker works best on faces that
fill a good part of the image, so it first tries an enlarged crop round the last face (upscaled
when small, padded where it leaves the frame), then the whole frame, then the whole frame padded
(faces cut by the edge), then one tile of a 3x3 grid per frame, up to ``max_attempts`` tries.

Seen only one real face (``skimage.data.astronaut``, offline) and never the owner's footage.
"""

from __future__ import annotations

import logging
import math
from typing import Any

import cv2
import numpy as np

from ..types import DecodedFrame, Observation
from .geometry import (
    FLIP_YZ,
    INTER_EYE_M,
    OUTER_CANTHI_M,
    combine,
    depth_from_iris,
    depth_from_span,
    distance_from_depth,
    eyeball_center_from_corners,
    fill_eye_model,
    head_angles_deg,
    orthonormalize,
)

log = logging.getLogger(__name__)

# MediaPipe 478-point mesh indices. "right" is the person's right eye (image left, unmirrored).
IRIS = {"right": (468, (469, 470, 471, 472)), "left": (473, (474, 475, 476, 477))}
CORNERS = {"right": (133, 33), "left": (362, 263)}  # (inner, outer)
LIDS = {"right": (159, 145), "left": (386, 374)}  # (upper, lower)

BLINK_OPENNESS = 0.12
"""Openness below which an eye counts as closed from landmarks alone."""


class LandmarkEstimator:
    """[``landmarks``] MediaPipe face landmarks on the ``wide`` image."""

    name = "landmarks"

    def __init__(self, config: Any = None, max_attempts: int = 3, min_crop_px: int = 320) -> None:
        self.config = config
        self.model_name = getattr(config, "landmarks_model", "face_landmarker.task")
        self.every = max(1, int(getattr(config, "landmarks_every", 1) or 1))
        self.max_attempts = max_attempts
        self.min_crop_px = min_crop_px
        self._landmarker = None
        self._failed = False
        self._last_rect: tuple[float, float, float, float] | None = None  # wide pixels
        self._tile = 0
        self._count = 0

    def reset(self) -> None:
        self._last_rect = None
        self._tile = 0
        self._count = 0

    # -----------------------------------------------------------------------------------------

    def _get_landmarker(self):
        if self._landmarker is not None or self._failed:
            return self._landmarker
        try:
            import mediapipe as mp
            from mediapipe.tasks.python import BaseOptions, vision

            from ..download import ensure_model, model_path

            path = model_path(self.model_name)
            if not path.exists():
                path = ensure_model(self.model_name, quiet=True)
            opts = vision.FaceLandmarkerOptions(
                base_options=BaseOptions(model_asset_path=str(path)),
                running_mode=vision.RunningMode.IMAGE,
                num_faces=1,
                min_face_detection_confidence=0.3,
                min_face_presence_confidence=0.3,
                output_face_blendshapes=True,
                output_facial_transformation_matrixes=True,
            )
            self._mp = mp
            self._landmarker = vision.FaceLandmarker.create_from_options(opts)
        except Exception as exc:  # noqa: BLE001 - fail soft: no landmarks, the rest still runs
            log.warning("face landmarker unavailable: %s", exc)
            self._failed = True
        return self._landmarker

    def _detect(self, rgb: np.ndarray):
        image = self._mp.Image(image_format=self._mp.ImageFormat.SRGB, data=np.ascontiguousarray(rgb))
        res = self._landmarker.detect(image)
        if not res.face_landmarks:
            return None
        return res

    def _candidates(self, w: int, h: int) -> list[tuple[str, tuple[float, float, float, float], float]]:
        """``(label, (x, y, cw, ch) in wide pixels (may extend outside), scale)``."""
        out = []
        if self._last_rect is not None:
            x, y, rw, rh = self._last_rect
            side = 2.0 * max(rw, rh)
            cx, cy = x + rw / 2, y + rh / 2
            scale = max(1.0, self.min_crop_px / side)
            out.append(("track", (cx - side / 2, cy - side / 2, side, side), scale))
        out.append(("full", (0.0, 0.0, float(w), float(h)), 1.0))
        pad = 0.3 * max(w, h)
        out.append(("padded", (-pad, -pad, w + 2 * pad, h + 2 * pad), 1.0))
        tiles = []
        for frac in (0.5, 0.33):
            cw, ch = w * frac, h * frac
            for fy in np.linspace(0, 1, 3):
                for fx in np.linspace(0, 1, 3):
                    tiles.append((fx * (w - cw), fy * (h - ch), cw, ch))
        t = tiles[self._tile % len(tiles)]
        self._tile += 1
        out.append(("tile", t, max(1.0, self.min_crop_px / max(t[2], t[3]))))
        return out

    @staticmethod
    def _cut(rgb: np.ndarray, rect: tuple[float, float, float, float], scale: float) -> np.ndarray:
        """Crop ``rect`` (may leave the image; outside is filled black), then scale."""
        h, w = rgb.shape[:2]
        x0, y0 = int(math.floor(rect[0])), int(math.floor(rect[1]))
        x1, y1 = int(math.ceil(rect[0] + rect[2])), int(math.ceil(rect[1] + rect[3]))
        ix0, iy0, ix1, iy1 = max(0, x0), max(0, y0), min(w, x1), min(h, y1)
        if ix1 <= ix0 or iy1 <= iy0:
            return np.zeros((1, 1, 3), np.uint8)
        crop = rgb[iy0:iy1, ix0:ix1]
        if (ix0, iy0, ix1, iy1) != (x0, y0, x1, y1):
            crop = cv2.copyMakeBorder(crop, iy0 - y0, y1 - iy1, ix0 - x0, x1 - ix1, cv2.BORDER_CONSTANT, value=(0, 0, 0))
        if scale != 1.0:
            crop = cv2.resize(crop, None, fx=scale, fy=scale, interpolation=cv2.INTER_LINEAR)
        return crop

    # -----------------------------------------------------------------------------------------

    def process(self, frame: DecodedFrame, previous: Observation | None) -> Observation | None:
        wide = frame.wide
        if wide is None:
            return None
        self._count += 1
        if self.every > 1 and self._count % self.every != 1 and self._last_rect is not None:
            return None  # iris_edge tracks between landmark frames
        if self._get_landmarker() is None:
            return None
        rgb = cv2.cvtColor(wide.pixels, cv2.COLOR_BGR2RGB)
        h, w = rgb.shape[:2]
        res = None
        used = None
        for label, rect, scale in self._candidates(w, h)[: self.max_attempts + (1 if self._last_rect else 0)]:
            crop = self._cut(rgb, rect, scale)
            if crop.shape[0] < 32 or crop.shape[1] < 32:
                continue
            res = self._detect(crop)
            if res is not None:
                used = (label, rect, scale, crop.shape[1], crop.shape[0])
                break
        if res is None:
            self._last_rect = None
            return None

        label, rect, scale, cw, ch = used
        lm = res.face_landmarks[0]
        pts_wide = np.array([[p.x * cw / scale + rect[0], p.y * ch / scale + rect[1]] for p in lm])
        x0, y0 = pts_wide.min(axis=0)
        x1, y1 = pts_wide.max(axis=0)
        self._last_rect = (float(x0), float(y0), float(x1 - x0), float(y1 - y0))
        tf = wide.to_full
        pts = (tf[:2, :2] @ pts_wide.T).T + tf[:2, 2]
        k = 1.0 / wide.scale  # full pixels per wide pixel

        obs = previous if previous is not None else Observation.empty(frame)
        n = self.name
        fx0, fy0 = pts.min(axis=0)
        fx1, fy1 = pts.max(axis=0)
        obs.set("face_rect", (float(fx0), float(fy0), float(fx1 - fx0), float(fy1 - fy0)), n)

        head_r = None
        if res.facial_transformation_matrixes:
            m = np.asarray(res.facial_transformation_matrixes[0], float)
            head_r = orthonormalize(FLIP_YZ @ m[:3, :3] @ FLIP_YZ)

        shapes = {}
        if res.face_blendshapes:
            shapes = {b.category_name: float(b.score) for b in res.face_blendshapes[0] if b.category_name.startswith("eye")}
        blink_both = 0.5 * (shapes.get("eyeBlinkLeft", 0.0) + shapes.get("eyeBlinkRight", 0.0))

        eye_rects = {}
        iris_r_wide = {}
        for side in ("left", "right"):
            ci, rim = IRIS[side]
            inner, outer = pts[CORNERS[side][0]], pts[CORNERS[side][1]]
            up, lo = pts[LIDS[side][0]], pts[LIDS[side][1]]
            span = float(np.linalg.norm(outer - inner))
            r = pts[list(rim)]
            r_full = 0.25 * (np.linalg.norm(r[0] - r[2]) + np.linalg.norm(r[1] - r[3]))
            iris_r_wide[side] = r_full / k
            openness = float(np.linalg.norm(up - lo) / span) if span > 0 else None
            obs.set(f"{side}.found", True, n)
            obs.set(f"{side}.inner_corner", (float(inner[0]), float(inner[1])), n)
            obs.set(f"{side}.outer_corner", (float(outer[0]), float(outer[1])), n)
            if openness is not None:
                obs.set(f"{side}.openness", openness, n)
                blink = openness < BLINK_OPENNESS or (blink_both > 0.6 and openness < 0.2)
                obs.set(f"{side}.blink", bool(blink), n)
            obs.set(f"{side}.iris_center", (float(pts[ci][0]), float(pts[ci][1])), n)
            obs.set(f"{side}.iris_radius", float(r_full), n)
            eye = obs.eye(side)
            if eye.confidence is None:
                obs.set(f"{side}.confidence", 0.5, n)
            mid = (inner + outer) / 2
            rw = 2.2 * span
            eye_rects[side] = [float(mid[0] - rw / 2), float(mid[1] - 0.3 * rw), float(rw), float(0.6 * rw)]

        intr = frame.intrinsics
        cues: dict[str, float | None] = {}
        if intr is not None:
            m4 = pts[[CORNERS["left"][0], CORNERS["left"][1], CORNERS["right"][0], CORNERS["right"][1]]].mean(axis=0)
            mid_px = (float(m4[0]), float(m4[1]))
            span_px = float(np.linalg.norm(pts[CORNERS["left"][1]] - pts[CORNERS["right"][1]]))
            fore = float(math.hypot(head_r[0, 0], head_r[1, 0])) if head_r is not None else 1.0
            d_span = depth_from_span(span_px, OUTER_CANTHI_M, intr.fx, fore)
            d_iris = combine([(depth_from_iris(obs.eye(s).iris_radius or 0, intr.fx), 1.0) for s in ("left", "right")])
            cues["canthi"] = None if d_span is None else distance_from_depth(intr, mid_px, d_span)
            cues["iris"] = None if d_iris is None else distance_from_depth(intr, mid_px, d_iris)
            w_iris = min(2.0, (np.mean(list(iris_r_wide.values())) / 10.0) ** 2)
            dist = combine([(cues["canthi"], 1.0), (cues["iris"], w_iris)])
            arkit_pose = obs.provenance.get("distance") == "arkit"
            if dist is not None and 0.1 < dist < 3.0 and not arkit_pose:
                obs.set("distance", float(dist), n)
                if head_r is not None:
                    obs.set("head_rotation", [[float(v) for v in row] for row in head_r], n)
                rx, ry = intr.ray(*mid_px)
                z_mid = dist / math.sqrt(1 + rx * rx + ry * ry)
                centers = []
                for side, sign in (("left", 1.0), ("right", -1.0)):
                    eye = obs.eye(side)
                    z = z_mid
                    if head_r is not None:
                        z += float((head_r @ np.array([sign * INTER_EYE_M / 2, 0, 0]))[2])
                    c = eyeball_center_from_corners(intr, eye.inner_corner, eye.outer_corner, z, head_r)
                    centers.append(c)
                    obs.set(f"{side}.eyeball_center", tuple(float(v) for v in c), n)
                obs.set("head_position", tuple(float(v) for v in (centers[0] + centers[1]) / 2), n)
                fill_eye_model(obs, n)

        obs.extra[n] = {
            "eye_rects": eye_rects,
            "attempt": label,
            "head_angles_deg": head_angles_deg(head_r) if head_r is not None else None,
            "distance_cues": cues,
            "blend_shapes": shapes,
            "iris_radius_wide_px": iris_r_wide,
        }
        return obs
