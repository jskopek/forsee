"""Find eyes in a frame and measure the iris: MediaPipe where it works, a direct finder otherwise.

Two ways to locate an eye:
  - MediaPipe Face Landmarker. Needs most of a face in view, so it works at 1x and 2x but not
    when a zoomed lens shows only part of the face. Small faces (ultrawide) are retried on crops.
  - A direct finder: circle search for the iris at the size the lens predicts for a plausible
    eye distance, scored by a dark disc with bright sclera on both sides. For zoomed frames.

Then, from a rough centre and radius, the iris edge (limbus) is located along rays and fitted
with an ellipse; the edge's width across rays on the sclera side is the sharpness measure.
"""

from dataclasses import dataclass
from pathlib import Path

import cv2
import numpy as np

from session import IRIS_MM

MODEL = Path(__file__).parent / "models" / "face_landmarker.task"
MODEL_URL = (
    "https://storage.googleapis.com/mediapipe-models/face_landmarker/face_landmarker/float16/"
    "latest/face_landmarker.task"
)

# MediaPipe 478-point mesh: iris centre + 4 rim points, and eye corners. "Right" is the
# participant's right eye, which is on the image's left in an unmirrored back-camera frame.
IRIS = {"right": (468, [469, 470, 471, 472]), "left": (473, [474, 475, 476, 477])}
CORNERS = {"right": (33, 133), "left": (362, 263)}

# Plausible eye-to-camera range for the direct finder's iris size prior.
NEAR_MM, FAR_MM = 350.0, 1000.0


@dataclass
class EyeGuess:
    centre: np.ndarray  # (x, y) pixels
    radius: float  # rough iris radius in pixels
    method: str  # "mediapipe" or "direct"
    side: str = ""  # "right"/"left" from MediaPipe, "" from the direct finder
    score: float = 0.0
    corners: np.ndarray = None  # 2x2 eye corners from MediaPipe


class MediaPipeEyes:
    def __init__(self):
        import mediapipe as mp
        from mediapipe.tasks.python import BaseOptions, vision

        if not MODEL.exists():
            raise SystemExit(f"Missing {MODEL}. Download it with:\n  curl -L -o {MODEL} {MODEL_URL}")
        self.mp = mp
        opts = vision.FaceLandmarkerOptions(
            base_options=BaseOptions(model_asset_path=str(MODEL)),
            running_mode=vision.RunningMode.IMAGE,
            num_faces=1,
            min_face_detection_confidence=0.3,
            min_face_presence_confidence=0.3,
        )
        self.landmarker = vision.FaceLandmarker.create_from_options(opts)
        self.last_crop = None  # crop that last worked, tried first next time

    def _run(self, rgb, x0=0, y0=0):
        h, w = rgb.shape[:2]
        image = self.mp.Image(image_format=self.mp.ImageFormat.SRGB, data=np.ascontiguousarray(rgb))
        res = self.landmarker.detect(image)
        if not res.face_landmarks:
            return None
        pts = np.array([[p.x * w + x0, p.y * h + y0] for p in res.face_landmarks[0]])
        eyes = []
        for side, (c, rim) in IRIS.items():
            r = pts[rim]
            diameter = 0.5 * (np.linalg.norm(r[0] - r[2]) + np.linalg.norm(r[1] - r[3]))
            eyes.append(EyeGuess(pts[c], diameter / 2, "mediapipe", side, 1.0, pts[list(CORNERS[side])]))
        return eyes

    def detect(self, bgr):
        """Eyes from MediaPipe, trying the full frame then crops (for faces small in the frame)."""
        rgb = cv2.cvtColor(bgr, cv2.COLOR_BGR2RGB)
        H, W = rgb.shape[:2]
        crops = [None]
        if self.last_crop is not None:
            crops.insert(0, self.last_crop)
        for frac in (0.5, 0.33):
            cw, ch = int(W * frac), int(H * frac)
            for fy in np.linspace(0, 1, 3):
                for fx in np.linspace(0, 1, 3):
                    crops.append((int(fx * (W - cw)), int(fy * (H - ch)), cw, ch))
        for crop in crops:
            if crop is None:
                eyes = self._run(rgb)
            else:
                x, y, cw, ch = crop
                eyes = self._run(rgb[y : y + ch, x : x + cw], x, y)
            if eyes:
                self.last_crop = crop
                return eyes
        self.last_crop = None
        return []


def radius_range(fx, near_mm=NEAR_MM, far_mm=FAR_MM):
    return fx * IRIS_MM / 2 / far_mm, fx * IRIS_MM / 2 / near_mm


def direct_eyes(bgr, r_min, r_max, near=None, max_eyes=2, max_width=1920):
    """Find irises directly as circles of a plausible size, scored as eye-like.

    `near` = (x, y, radius) searches a window round a known eye with the radius fixed to +-20%.
    """
    H, W = bgr.shape[:2]
    x0 = y0 = 0
    if near is not None:
        nx, ny, nr = near
        half = int(4 * nr)
        x0, y0 = max(0, int(nx) - half), max(0, int(ny) - half)
        bgr = bgr[y0 : min(H, int(ny) + half), x0 : min(W, int(nx) + half)]
        r_min, r_max = 0.8 * nr, 1.2 * nr
    # Work at a scale where the iris is ~14 px in radius, and no wider than max_width.
    k = max(1.0, r_min / 14.0, bgr.shape[1] / max_width)
    small = cv2.resize(bgr, None, fx=1 / k, fy=1 / k, interpolation=cv2.INTER_AREA) if k > 1 else bgr
    gray = cv2.GaussianBlur(cv2.cvtColor(small, cv2.COLOR_BGR2GRAY), (0, 0), 1.5)
    sat = cv2.cvtColor(small, cv2.COLOR_BGR2HSV)[..., 1]
    circles = cv2.HoughCircles(
        gray, cv2.HOUGH_GRADIENT, dp=1, minDist=max(2, r_min / k), param1=60, param2=15,
        minRadius=max(2, int(r_min / k)), maxRadius=int(np.ceil(r_max / k)),
    )
    if circles is None:
        return []
    found = []
    for rank, (cx, cy, r) in enumerate(circles[0][:20]):
        score = iris_score(gray, sat, cx, cy, r)
        if score > 0:
            found.append(EyeGuess(np.array([cx * k + x0, cy * k + y0]), r * k, "direct", "",
                                  score - 0.02 * rank))
    found.sort(key=lambda e: -e.score)
    kept = []
    for e in found:  # drop overlapping circles (pupil inside iris, etc.)
        if all(np.linalg.norm(e.centre - o.centre) > 1.5 * max(e.radius, o.radius) for o in kept):
            kept.append(e)
    return kept[:max_eyes]


def iris_score(gray, sat, cx, cy, r):
    """How eye-like a circle is; 0 if not. Uses three cues that hold for any iris colour:
    the sclera left and right is less saturated than the skin of the lids above and below,
    the disc holds a bright corneal reflection, and the disc is darker than the sclera.
    """
    h, w = gray.shape
    R = int(1.6 * r) + 1
    xa, xb, ya, yb = int(cx) - R, int(cx) + R, int(cy) - R, int(cy) + R
    if xa < 0 or ya < 0 or xb > w or yb > h:
        return 0.0  # iris and its surroundings must be in frame
    g = gray[ya:yb, xa:xb].astype(np.float32)
    s = sat[ya:yb, xa:xb].astype(np.float32)
    yy, xx = np.mgrid[ya:yb, xa:xb]
    d = np.hypot(xx - cx, yy - cy)
    ang = np.abs(np.degrees(np.arctan2(yy - cy, xx - cx)))
    ring = (d > 1.1 * r) & (d < 1.5 * r)
    sides = ring & ((ang < 30) | (ang > 150))
    lids = ring & (ang > 60) & (ang < 120)
    inner = (d < 0.85 * r) & (d > 0.35 * r)
    if sides.sum() < 10 or lids.sum() < 10 or inner.sum() < 20:
        return 0.0
    s_sides, s_lids = np.median(s[sides]), np.median(s[lids])
    sclera = (s_lids - s_sides) / (s_lids + 1)
    g_sides = np.median(g[sides])
    reflection = (np.percentile(g[d < 0.85 * r], 99.5) - g_sides) / 255
    darker = (g_sides - np.median(g[inner])) / 255
    if sclera < 0.1 or reflection < 0.05:
        return 0.0
    return float(sclera + reflection + max(darker, 0))


def _sample(gray, xs, ys):
    return cv2.remap(gray, xs.astype(np.float32), ys.astype(np.float32), cv2.INTER_LINEAR,
                     borderMode=cv2.BORDER_REPLICATE)


def limbus_points(gray, centre, r0, step_deg=3.0):
    """Strongest dark-to-bright step outward along rays from the centre, between 0.6 and 1.45 r0."""
    angles = np.radians(np.arange(0, 360, step_deg))
    rho = np.arange(0.6 * r0, 1.45 * r0, max(0.25, r0 / 200))
    xs = centre[0] + np.outer(np.cos(angles), rho)
    ys = centre[1] + np.outer(np.sin(angles), rho)
    prof = _sample(gray, xs, ys)
    sigma = max(1.0, r0 / 40) / (rho[1] - rho[0])
    prof = cv2.GaussianBlur(prof, (0, 0), sigmaX=sigma, sigmaY=0.01)
    grad = np.gradient(prof, axis=1)
    i = grad.argmax(axis=1)
    strength = grad[np.arange(len(angles)), i]
    pts = np.stack([xs[np.arange(len(angles)), i], ys[np.arange(len(angles)), i]], 1)
    return pts, strength, angles


def _ellipse_residual(pts, ell):
    (cx, cy), (w, h), ang = ell
    a, b = w / 2, h / 2
    t = np.radians(ang)
    dx, dy = pts[:, 0] - cx, pts[:, 1] - cy
    u = dx * np.cos(t) + dy * np.sin(t)
    v = -dx * np.sin(t) + dy * np.cos(t)
    return (np.hypot(u / a, v / b) - 1) * (a + b) / 2


def fit_iris(gray, centre, r0, rng=None, iterations=2, major_range=None):
    """Fit an ellipse to the limbus. Returns dict or None.

    major_range = (lo, hi) limits the ellipse's long axis. The long axis of a tilted circle is
    its true diameter, so with a known iris size it barely changes with gaze direction.
    """
    rng = rng or np.random.default_rng(0)
    centre = np.asarray(centre, float)
    best = None
    for _ in range(iterations):
        pts, strength, angles = limbus_points(gray, centre, r0)
        keep = strength > 0.35 * np.percentile(strength, 90)
        pts, strength, angles = pts[keep], strength[keep], angles[keep]
        if len(pts) < 8:
            return None
        tol = max(1.0, 0.04 * r0)
        best = None
        for _ in range(150):
            sample = pts[rng.choice(len(pts), 5, replace=False)]
            try:
                ell = cv2.fitEllipse(sample.astype(np.float32))
            except cv2.error:
                continue
            (cx, cy), (w, h), _a = ell
            if not (0.55 < min(w, h) / max(w, h + 1e-9) and 1.2 * r0 < (w + h) / 2 < 2.6 * r0):
                continue
            if major_range and not (major_range[0] <= max(w, h) <= major_range[1]):
                continue
            inl = np.abs(_ellipse_residual(pts, ell)) < tol
            if best is None or inl.sum() > best[1].sum():
                best = (ell, inl)
        if best is None or best[1].sum() < 8:
            return None
        ell = cv2.fitEllipse(pts[best[1]].astype(np.float32))
        centre = np.array(ell[0])
        r0 = (ell[1][0] + ell[1][1]) / 4
    inl = np.abs(_ellipse_residual(pts, ell)) < tol
    (cx, cy), (w, h), ang = ell
    return {
        "centre": np.array([cx, cy]),
        "major": max(w, h),
        "minor": min(w, h),
        "angle": ang,
        "ellipse": ell,
        "inliers": int(inl.sum()),
        "rays": len(angles),
        "rms_px": float(np.sqrt(np.mean(_ellipse_residual(pts[inl], ell) ** 2))),
        "points": pts[inl],
        "angles": angles[inl],
    }


def edge_width(gray, fit, max_angle=35):
    """10-90% width of the limbus edge, in pixels, on rays towards the sclera (near horizontal).

    Profiles are sampled unsmoothed across the fitted edge. Each is normalised between the iris
    level just inside and the sclera level just outside, and the distance between the 10% and
    90% crossings either side of the edge is taken. Returns the median over rays, the number of
    usable rays and the median iris-to-sclera contrast.
    """
    c, r = fit["centre"], (fit["major"] + fit["minor"]) / 4
    ang = np.degrees(fit["angles"]) % 180
    lateral = (ang < max_angle) | (ang > 180 - max_angle)
    widths, contrasts = [], []
    step = 0.2
    for p, a in zip(fit["points"][lateral], fit["angles"][lateral]):
        rho_e = np.hypot(*(p - c))
        rho = np.arange(rho_e - 0.4 * r, rho_e + 0.35 * r, step)
        prof = _sample(gray, c[0] + rho[None] * np.cos(a), c[1] + rho[None] * np.sin(a))[0]
        e = np.searchsorted(rho, rho_e)
        lo = np.median(prof[rho < rho_e - 0.2 * r])
        hi = np.median(prof[rho > rho_e + 0.15 * r])
        if hi - lo < 8:
            continue
        n = (prof - lo) / (hi - lo)
        i10 = e
        while i10 > 0 and n[i10] > 0.1:
            i10 -= 1
        i90 = e
        while i90 < len(n) - 1 and n[i90] < 0.9:
            i90 += 1
        if i10 == 0 or i90 == len(n) - 1:
            continue
        widths.append((i90 - i10) * step)
        contrasts.append(hi - lo)
    if not widths:
        return None, 0, None
    return float(np.median(widths)), len(widths), float(np.median(contrasts))


def eye_sharpness(gray, fit, iris_px=100):
    """Laplacian energy over local contrast in a box round the iris, at a common scale.

    The box is resampled so the iris spans `iris_px` pixels (about the 2x camera's native size
    here), so cameras are compared on detail at the same scale on the eye.
    """
    c, major = fit["centre"], fit["major"]
    half_w, half_h = 1.2 * major, 0.6 * major
    x0, x1 = int(c[0] - half_w), int(c[0] + half_w)
    y0, y1 = int(c[1] - half_h), int(c[1] + half_h)
    H, W = gray.shape
    if x0 < 0 or y0 < 0 or x1 > W or y1 > H:
        return None
    box = gray[y0:y1, x0:x1].astype(np.float32)
    s = iris_px / major
    interp = cv2.INTER_AREA if s < 1 else cv2.INTER_CUBIC
    box = cv2.resize(box, None, fx=s, fy=s, interpolation=interp)
    lap = cv2.Laplacian(box, cv2.CV_32F, ksize=3)
    return float(lap.var() / (box.var() + 1e-6))
