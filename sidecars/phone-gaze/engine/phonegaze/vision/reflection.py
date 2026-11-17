"""Screen reflection estimator: the display's reflection on the cornea. Owner: Vision.

Follows the recommendation in ``docs/research/02-corneal-reflection-of-screens.md``.

**Static detection (every frame).** In the eye image (the native-resolution crop when there is
one), round the iris found by earlier estimators: white top-hat (image minus its opening with a
disc of about 0.25 iris radii), threshold at median + k * MAD of the top-hat inside the iris, and
keep connected blobs that lie within 0.6 iris radii of the iris centre (beyond that the limbus
distorts them), whose area is 0.25-3x the area predicted for a screen of ``screen_mm`` at the
estimated distance (cornea as a convex mirror, f = 3.9 mm), and that do not touch the crop edge.
The centre is the top-hat-weighted centroid (sub-pixel). Corners are reported when the blob is at
least ``corner_min_px`` wide: a minimum-area rectangle at half the blob's peak, ordered by the
screen corner they reflect (the reflection is mirror-like: the screen's top-left appears at the
image's top-right when the camera faces the person upright).

**Never unsure.** Eyes that are blinking or nearly shut are skipped. A frame is rejected when two
candidates score within ``ambiguity`` of each other and nothing (flash prior, last position) tells
them apart, or when the final confidence is below ``min_confidence``.

**Coded flash.** ``set_pattern(pattern, on, t)`` is called by Core when the UI starts or stops a
flash pattern (UI WebSocket ``ui.pattern``). While it runs, iris-centred, iris-scaled patches are
buffered and every pixel's brightness is correlated with the known on/off code over lags of
0-400 ms (the display-to-engine delay is unknown). The best lag is the latency; the blob of high
correlation is the reflection. Its offset from the iris centre (in iris radii) and size become a
per-eye prior that static detection uses from then on to pick the right blob among ambient
highlights. Pattern string format (decided here): characters ``0``/``1``, one per step, repeating
from the moment ``on`` was sent, optionally followed by ``@<step ms>`` (default 125 ms), e.g.
``"10110010@125"``. A string without any ``0``/``1`` uses :data:`DEFAULT_PATTERN`.

Fills per eye: ``reflection_center``, ``reflection_score``, ``reflection_corners`` (when
resolved), and ``extra["reflection"]`` (``vector``: (reflection - iris centre) / iris radius, the
scale-free feature for the reflection model; area; predicted area; signal-to-noise; mode).
Tested only on synthetic eye images.
"""

from __future__ import annotations

import math
import re
from collections import deque
from typing import Any

import cv2
import numpy as np

from ..types import DecodedFrame, Observation
from .geometry import depth_from_iris
from .iris_edge import _image_for
from .settings import opt

DEFAULT_PATTERN = "10110010"
DEFAULT_STEP_S = 0.125
CORNEA_FOCAL_MM = 3.9
IRIS_RADIUS_MM = 5.85


def parse_pattern(pattern: Any) -> tuple[list[int], float]:
    """``"10110010@125"`` -> ``([1, 0, 1, 1, 0, 0, 1, 0], 0.125)``."""
    text = str(pattern or "")
    step = DEFAULT_STEP_S
    m = re.search(r"@\s*([0-9.]+)", text)
    if m:
        try:
            step = max(0.01, float(m.group(1)) / 1000.0)
        except ValueError:
            pass
        text = text[: m.start()]
    bits = [int(c) for c in text if c in "01"]
    if not bits or len(set(bits)) < 2:
        bits = [int(c) for c in DEFAULT_PATTERN]
    return bits, step


def predicted_reflection_px(iris_radius_px: float, distance_m: float, screen_mm: tuple[float, float]) -> tuple[float, float]:
    """Width and height in pixels of the screen's corneal reflection (convex mirror model)."""
    d_mm = distance_m * 1000.0
    px_per_mm = iris_radius_px / IRIS_RADIUS_MM
    k = CORNEA_FOCAL_MM / (d_mm + CORNEA_FOCAL_MM)
    return screen_mm[0] * k * px_per_mm, screen_mm[1] * k * px_per_mm


class _EyeCode:
    """Buffered iris-normalised patches for one eye during a coded flash."""

    def __init__(self, grid: int) -> None:
        self.grid = grid
        self.t: deque[float] = deque(maxlen=150)
        self.patches: deque[np.ndarray] = deque(maxlen=150)


class ReflectionEstimator:
    """[``reflection``] The screen's corneal reflection per eye."""

    name = "reflection"

    def __init__(
        self,
        config: Any = None,
        screen_mm: tuple[float, float] = (302.0, 196.0),
        min_iris_px: float = 12.0,
        k_mad: float = 5.0,
        min_contrast: float = 10.0,
        min_confidence: float = 0.3,
        ambiguity: float = 0.6,
        corner_min_px: float = 10.0,
        max_lag_s: float = 0.4,
        grid: int = 41,
    ) -> None:
        self.config = config
        self.screen_mm = screen_mm
        self.min_iris_px = min_iris_px
        self.k_mad = k_mad
        self.min_contrast = min_contrast
        self.min_confidence = min_confidence
        self.ambiguity = ambiguity
        self.corner_min_px = corner_min_px
        self.max_lag_s = max_lag_s
        self.grid = grid
        self.priors: dict[str, dict[str, float]] = {}
        self.latency_s: float | None = None
        self._code: tuple[list[int], float, float] | None = None  # bits, step, t0
        self._buf: dict[str, _EyeCode] = {}
        self._last_solve = -math.inf
        self._last: dict[str, tuple[float, tuple[float, float]]] = {}

    def reset(self) -> None:
        self._code = None
        self._buf.clear()
        self._last.clear()
        self.priors.clear()
        self.latency_s = None

    def set_screen(self, width_mm: float | None, height_mm: float | None) -> None:
        """Optional: the real screen size (Core may call this when it knows ``ScreenInfo``)."""
        if width_mm and height_mm:
            self.screen_mm = (float(width_mm), float(height_mm))

    # ----------------------------------------------------------------------------- coded flash

    def set_pattern(self, pattern: Any, on: bool, t: float) -> None:
        if on:
            bits, step = parse_pattern(pattern)
            self._code = (bits, step, float(t))
            self._buf = {s: _EyeCode(self.grid) for s in ("left", "right")}
            self._last_solve = -math.inf
        else:
            if self._code is not None:
                self._solve()
            self._code = None
            self._buf = {}

    def code_at(self, t: float) -> float | None:
        """The pattern's value (0/1) shown at engine time ``t``, or ``None`` before it began."""
        if self._code is None:
            return None
        bits, step, t0 = self._code
        if t < t0:
            return None
        return float(bits[int((t - t0) / step) % len(bits)])

    def _normalised_patch(self, gray: np.ndarray, c_img: np.ndarray, r_img: float) -> np.ndarray:
        g = self.grid
        s = 2.2 * r_img / (g - 1)
        m = np.array([[s, 0, c_img[0] - s * (g - 1) / 2], [0, s, c_img[1] - s * (g - 1) / 2]], dtype=np.float64)
        return cv2.warpAffine(
            gray.astype(np.float32), m, (g, g), flags=cv2.INTER_LINEAR | cv2.WARP_INVERSE_MAP, borderMode=cv2.BORDER_REPLICATE
        )

    def _solve(self) -> None:
        """Correlate buffered patches with the code; store priors and latency."""
        if self._code is None:
            return
        lags_found = []
        g = self.grid
        unit = 2.2 / (g - 1)  # iris radii per patch pixel
        for side, buf in self._buf.items():
            if len(buf.t) < 10:
                continue
            t = np.array(buf.t)
            X = np.stack([p.ravel() for p in buf.patches]).astype(np.float64)
            yy, xx = np.mgrid[0:g, 0:g]
            inside = np.hypot((xx - (g - 1) / 2) * unit, (yy - (g - 1) / 2) * unit) < 0.85

            def at_lag(lag: float, t=t, X=X, inside=inside):
                codes = [self.code_at(tt - lag) for tt in t]
                valid = np.array([c is not None for c in codes])
                if valid.sum() < 10:
                    return None
                c = np.array([c for c in codes if c is not None])
                if c.std() < 1e-6:
                    return None
                Xv = X[valid]
                Xc = Xv - Xv.mean(0)
                cc = c - c.mean()
                sx = np.sqrt((Xc**2).sum(0))
                corr = (Xc.T @ cc) / (np.maximum(sx, 1e-6) * np.linalg.norm(cc))
                corr[sx < 1e-3 * np.sqrt(len(cc))] = 0.0
                cmap = cv2.blur(corr.reshape(g, g).astype(np.float32), (3, 3))
                return (float(cmap[inside].max()), float(lag), corr.reshape(g, g), c, Xv)

            # Coarse search over lags at 1/30 s, then refine at 1/120 s round the best.
            best = None
            max_lag = float(opt(self.config, "reflection_max_lag_ms", self.max_lag_s * 1000.0)) / 1000.0
            for lag in np.arange(0.0, max_lag + 1e-9, 1.0 / 30.0):
                res = at_lag(float(lag))
                if res is not None and (best is None or res[0] > best[0]):
                    best = res
            if best is not None:
                centre_lag = best[1]
                for lag in centre_lag + np.arange(-3, 4) / 120.0:
                    if 0.0 <= lag <= max_lag and abs(lag - centre_lag) > 1e-9:
                        res = at_lag(float(lag))
                        if res is not None and res[0] > best[0]:
                            best = res
            if best is None or best[0] < float(opt(self.config, "reflection_flash_min_corr", 0.6)):
                continue
            score, lag, corr, c, Xv = best
            yy, xx = np.mgrid[0:g, 0:g]
            inside = np.hypot((xx - (g - 1) / 2) * unit, (yy - (g - 1) / 2) * unit) < 0.85
            masked = np.where(inside, corr, -1)
            py, px = np.unravel_index(int(np.argmax(masked)), masked.shape)
            peak = corr[py, px]
            mask = (corr > max(0.5 * peak, 0.4)).astype(np.uint8)
            _, labels = cv2.connectedComponents(mask)
            blob = labels == labels[py, px]
            w = np.where(blob, corr, 0.0)
            cy_, cx_ = (w * yy).sum() / w.sum(), (w * xx).sum() / w.sum()
            amp = float(np.polyfit(c, Xv[:, py * g + px], 1)[0])
            self.priors[side] = {
                "dx": float((cx_ - (g - 1) / 2) * unit),
                "dy": float((cy_ - (g - 1) / 2) * unit),
                "area_r2": float(blob.sum() * unit * unit),
                "corr": float(peak),
                "latency_s": lag,
                "amplitude": amp,
            }
            lags_found.append(lag)
        if lags_found:
            self.latency_s = float(np.median(lags_found))

    def _buffer(self, frame: DecodedFrame, obs: Observation) -> None:
        t = frame.frame.t_received if frame.frame.t_received is not None else frame.frame.t
        for side in ("left", "right"):
            eye = obs.eye(side)
            if eye.iris_center is None or not eye.iris_radius or eye.blink:
                continue
            im = _image_for(frame, side, eye.iris_center)
            if im is None:
                continue
            r_img = eye.iris_radius * im.scale
            if r_img < float(opt(self.config, "reflection_min_iris_px", self.min_iris_px)):
                continue
            c_img = np.array(im.point_from_full(eye.iris_center)) - 0.5
            buf = self._buf.setdefault(side, _EyeCode(self.grid))
            buf.t.append(float(t))
            buf.patches.append(self._normalised_patch(im.gray, c_img, r_img))
        if self._code is not None:
            bits, step, t0 = self._code
            if t - t0 >= len(bits) * step + 0.4 and t - self._last_solve >= 0.5:
                self._last_solve = t
                self._solve()

    # -------------------------------------------------------------------------- static detection

    def _detect(self, frame: DecodedFrame, obs: Observation, side: str, t_now: float) -> dict[str, Any] | None:
        eye = obs.eye(side)
        if eye.iris_center is None or not eye.iris_radius:
            return None
        if eye.blink or (eye.openness is not None and eye.openness < 0.15):
            return None
        im = _image_for(frame, side, eye.iris_center)
        if im is None:
            return None
        cfg = self.config
        k_mad = float(opt(cfg, "reflection_k_mad", self.k_mad))
        min_contrast = float(opt(cfg, "reflection_min_contrast", self.min_contrast))
        min_conf = float(opt(cfg, "reflection_min_confidence", self.min_confidence))
        ambiguity = float(opt(cfg, "reflection_ambiguity", self.ambiguity))
        max_off = float(opt(cfg, "reflection_max_offset", 0.6))
        area_lo = float(opt(cfg, "reflection_area_min", 0.25))
        area_hi = float(opt(cfg, "reflection_area_max", 3.0))
        s = im.scale
        r = eye.iris_radius * s
        if r < float(opt(cfg, "reflection_min_iris_px", self.min_iris_px)):
            return None
        c = np.array(im.point_from_full(eye.iris_center)) - 0.5  # index coordinates
        gray_full = im.gray
        H, W = gray_full.shape
        half = int(math.ceil(1.15 * r))
        x0, y0 = int(round(c[0])) - half, int(round(c[1])) - half
        x1, y1 = x0 + 2 * half + 1, y0 + 2 * half + 1
        if x0 < 0 or y0 < 0 or x1 > W or y1 > H:
            return None
        patch = gray_full[y0:y1, x0:x1].astype(np.float32)
        d_m = obs.distance
        if d_m is None and frame.intrinsics is not None:
            d_m = depth_from_iris(eye.iris_radius, frame.intrinsics.fx, float(opt(cfg, "iris_diameter_mm", 11.7)))
        d_m = d_m or 0.6
        pw, ph = predicted_reflection_px(r, d_m, self.screen_mm)
        pred_area = max(3.0, 0.9 * pw * ph)
        # Opening disc: about 0.25 iris radii (research note), but always wider than the
        # predicted reflection so the top-hat keeps it whole when the person sits close.
        kr = max(2, int(round(min(0.6 * r, max(0.25 * r, 0.65 * max(pw, ph))))))
        kernel = cv2.getStructuringElement(cv2.MORPH_RECT, (2 * kr + 1, 2 * kr + 1))  # separable: fast
        top = cv2.morphologyEx(patch, cv2.MORPH_TOPHAT, kernel)
        yy, xx = np.mgrid[0 : patch.shape[0], 0 : patch.shape[1]]
        cxp, cyp = c[0] - x0, c[1] - y0
        dist = np.hypot(xx - cxp, yy - cyp)
        inside = dist < 0.95 * r
        vals = top[inside]
        med = float(np.median(vals))
        mad = float(np.median(np.abs(vals - med))) * 1.4826
        thr = max(med + k_mad * mad, med + min_contrast)
        binary = ((top > thr) & (dist < 1.05 * r)).astype(np.uint8)
        nlab, labels, stats, _ = cv2.connectedComponentsWithStats(binary, connectivity=8)
        if nlab <= 1:
            return None

        noise = max(mad, 1.0)
        iris_level = float(np.percentile(patch[inside], 75))

        prior = self.priors.get(side) if opt(cfg, "reflection_coded_flash", True) else None
        last = self._last.get(side)
        if last is not None and t_now - last[0] > 0.5:
            last = None

        cands = []
        for i in range(1, nlab):
            x, y, w, h, area = stats[i]
            if x == 0 or y == 0 or x + w >= patch.shape[1] or y + h >= patch.shape[0]:
                continue
            if area < max(2.0, area_lo * pred_area) or area > area_hi * pred_area:
                continue
            blob = labels == i
            b8 = blob.astype(np.uint8)
            region = cv2.dilate(b8, np.ones((5, 5), np.uint8)).astype(bool)
            ring = cv2.dilate(b8, np.ones((9, 9), np.uint8)).astype(bool) & ~region
            # The reflection is an opaque plateau over a background that can change under it
            # (pupil edge), so weight by coverage between the brightest surrounding level and
            # the plateau rather than by contrast.
            hi = float(np.percentile(patch[blob], 90))
            if hi - iris_level < 2 * min_contrast or area < 0.4 * w * h:
                continue  # not brighter than the iris, or ring-shaped (the iris round the pupil)
            lo = float(np.percentile(patch[ring], 90)) if ring.any() else hi - float(top[blob].max())
            if hi - lo >= 5:
                wts = np.where(region, np.clip((patch - lo) / (hi - lo), 0, 1), 0.0)
            else:
                wts = np.where(region, np.maximum(top - med, 0), 0.0)
            ws = float(wts.sum())
            if ws <= 0:
                continue
            bx, by = float((wts * xx).sum() / ws), float((wts * yy).sum() / ws)
            off = ((bx - cxp) / r, (by - cyp) / r)
            dn = math.hypot(*off)
            if dn > max_off:
                continue
            peak = float(top[blob].max())
            snr = (float(top[blob].mean()) - med) / noise
            size_score = math.exp(-(math.log(area / pred_area) ** 2) / (2 * 0.7**2))
            snr_score = 1.0 - math.exp(-snr / 6.0)
            prior_score = 1.0
            if prior is not None:
                e2 = (off[0] - prior["dx"]) ** 2 + (off[1] - prior["dy"]) ** 2
                prior_score = math.exp(-e2 / (2 * 0.25**2))
            elif last is not None:
                e2 = (off[0] - last[1][0]) ** 2 + (off[1] - last[1][1]) ** 2
                prior_score = 0.3 + 0.7 * math.exp(-e2 / (2 * 0.15**2))
            sat = float((patch[blob] >= 250).mean())
            cands.append(
                {
                    "score": size_score * snr_score * prior_score * (0.6 if sat > 0.3 else 1.0),
                    "center_img": (bx + x0 + 0.5, by + y0 + 0.5),
                    "offset": off,
                    "area": float(area),
                    "peak": peak,
                    "snr": snr,
                    "bbox": (int(x), int(y), int(w), int(h)),
                    "label": i,
                    "saturated": sat,
                    "prior_score": prior_score,
                }
            )
        if not cands:
            return None
        cands.sort(key=lambda d: -d["score"])
        best = cands[0]
        margin = 1.0
        if len(cands) > 1:
            ratio = cands[1]["score"] / max(best["score"], 1e-9)
            if ratio >= ambiguity and prior is None and last is None:
                return None
            margin = 1.0 - 0.5 * ratio
        if prior is not None and best["prior_score"] < 0.3:
            return None
        conf = float(best["score"] * margin)
        if conf < min_conf:
            return None

        corners = None
        x, y, w, h = best["bbox"]
        if w >= self.corner_min_px * s and h >= 0.6 * self.corner_min_px * s:
            half_mask = ((labels == best["label"]) | (top > 0.5 * best["peak"])) & (dist < 1.05 * r)
            lab2 = cv2.connectedComponents(half_mask.astype(np.uint8))[1]
            core = lab2 == lab2[int(round(best["center_img"][1] - y0 - 0.5)), int(round(best["center_img"][0] - x0 - 0.5))]
            pts = np.column_stack(np.nonzero(core)[::-1]).astype(np.float32)
            if len(pts) >= 5:
                box = cv2.boxPoints(cv2.minAreaRect(pts))
                corners = _order_screen_corners(box, (x0, y0), im.to_full)
        return {
            "center": im.point_to_full(best["center_img"]),
            "confidence": conf,
            "offset": best["offset"],
            "area_full": best["area"] / (s * s),
            "pred_area_full": pred_area / (s * s),
            "snr": best["snr"],
            "saturated": best["saturated"],
            "candidates": len(cands),
            "corners": corners,
            "mode": "prior" if prior is not None else ("tracked" if last is not None else "static"),
        }

    # -------------------------------------------------------------------------------- process

    def process(self, frame: DecodedFrame, previous: Observation | None) -> Observation | None:
        obs = previous if previous is not None else Observation.empty(frame)
        t_now = frame.frame.t_received if frame.frame.t_received is not None else frame.frame.t
        if self._code is not None:
            self._buffer(frame, obs)
        n = self.name
        any_found = False
        for side in ("left", "right"):
            r = self._detect(frame, obs, side, t_now)
            if r is None:
                continue
            any_found = True
            self._last[side] = (t_now, r["offset"])
            eye = obs.eye(side)
            obs.set(f"{side}.reflection_center", (float(r["center"][0]), float(r["center"][1])), n)
            obs.set(f"{side}.reflection_score", r["confidence"], n)
            if r["corners"] is not None:
                obs.set(f"{side}.reflection_corners", r["corners"], n)
            eye.extra[n] = {
                "vector": [float(v) for v in r["offset"]],
                "area_px": r["area_full"],
                "predicted_area_px": r["pred_area_full"],
                "snr": r["snr"],
                "saturated": r["saturated"],
                "candidates": r["candidates"],
                "mode": r["mode"],
            }
        if self.priors or self.latency_s is not None or self._code is not None:
            obs.extra[n] = {
                "latency_s": self.latency_s,
                "priors": {k: dict(v) for k, v in self.priors.items()},
                "flashing": self._code is not None,
            }
            any_found = True
        return obs if any_found else None


def _order_screen_corners(box: np.ndarray, origin: tuple[int, int], to_full: np.ndarray) -> list[tuple[float, float]]:
    """Four rectangle corners (patch index coords) -> full-frame pixels ordered by the SCREEN
    corner they reflect: top-left, top-right, bottom-right, bottom-left. The screen's left
    appears on the image's right in the reflection."""
    pts = np.asarray(box, float) + np.array(origin, float) + 0.5
    c = pts.mean(0)
    ang = np.arctan2(pts[:, 1] - c[1], pts[:, 0] - c[0])
    pts = pts[np.argsort(ang)]  # clockwise on screen starting near -pi (left side)
    # Identify image top-left as the point with the smallest x + y, then go clockwise.
    start = int(np.argmin(pts[:, 0] + pts[:, 1]))
    img_tl, img_tr, img_br, img_bl = (pts[(start + k) % 4] for k in range(4))
    ordered = [img_tr, img_tl, img_bl, img_br]
    out = []
    for p in ordered:
        q = to_full @ np.array([p[0], p[1], 1.0])
        out.append((float(q[0]), float(q[1])))
    return out
