"""Ray-cast renderer for the synthetic face. Owner: Simulator.

Every pixel is a ray through a pinhole camera; surfaces are analytic (ellipsoids for the head and
nose, spheres for eyeball, lids and cornea, a plane disc for the iris). That makes the parts that
vision is measured against EXACT:

- the limbus (iris edge) is the true 3D circle, so its image is the exact projected ellipse;
- the corneal reflection of the screen (and of a ceiling lamp) is traced off the corneal sphere
  onto the screen rectangle, so its position, size and shape are exact for a spherical cornea;
- the eyelids cover exactly what :func:`lid_opening` says.

Everything else (skin, brows, lips, hair, iris texture, shading) is cosmetic.

Any rectangle of the upright full frame can be rendered at any output size, so a 4K frame never
has to exist: the downscaled ``wide`` part and each native-resolution ROI are rendered directly.
"""

from __future__ import annotations

import math
from dataclasses import dataclass, field
from typing import Any

import numpy as np

from ..types import Intrinsics
from .person import CORNEA_RADIUS_M, EYEBALL_RADIUS_M, IRIS_PLANE_M, LID_RADIUS_M, LIMBUS_RADIUS_M, EyeState, PersonParams

# BGR palettes, 0-255.
SKIN = np.array([128, 158, 208], np.float32)
HAIR = np.array([28, 36, 48], np.float32)
BROW = np.array([40, 50, 66], np.float32)
LIPS = np.array([92, 92, 168], np.float32)
LASH = np.array([30, 32, 40], np.float32)
SCLERA = np.array([212, 218, 228], np.float32)
PUPIL = np.array([14, 14, 16], np.float32)
IRIS_COLORS = {
    "brown": np.array([38, 70, 118], np.float32),
    "blue": np.array([150, 122, 84], np.float32),
    "green": np.array([84, 124, 98], np.float32),
    "dark": np.array([26, 36, 56], np.float32),
}

FACE_CENTER = np.array([0.0, 0.028, 0.068])  # head frame
FACE_RADII = np.array([0.077, 0.108, 0.094])
NOSE_CENTER = np.array([0.0, 0.026, -0.016])
NOSE_RADII = np.array([0.011, 0.026, 0.024])


@dataclass
class RenderState:
    """Everything the renderer needs for one instant, in WORLD coordinates (immutable snapshot)."""

    head_R: np.ndarray
    head_t: np.ndarray
    eyes: dict[str, EyeState]
    person: PersonParams
    blink: float
    screen_corners: np.ndarray  # 4x3: TL, TR, BR, BL (as the user sees the screen)
    screen_level: float  # 0..1 brightness of the screen as reflected right now
    cam_R: np.ndarray  # camera (upright) -> world
    cam_t: np.ndarray
    glint_gain: float = 1.0
    lamp_dir: np.ndarray | None = None  # unit direction from the face towards a ceiling lamp (world)
    lamp_radius_deg: float = 3.0
    lamp_gain: float = 0.8
    light_dir: np.ndarray = field(default_factory=lambda: np.array([0.15, -0.75, -0.65]))
    seed: int = 0


def lid_opening(az_t: np.ndarray, el: np.ndarray, person: PersonParams, gaze_elev_deg: float, blink: float) -> tuple[np.ndarray, np.ndarray, np.ndarray]:
    """Eyelid model in eye-centred head angles (degrees). ``az_t`` is positive towards the
    temple, ``el`` positive upwards. Returns (inside_opening, upper_lid_el, lower_lid_el)."""
    nasal, temporal = person.corner_deg
    A = np.where(az_t < 0, nasal, temporal)
    f = np.clip(1.0 - (az_t / A) ** 2, 0.0, 1.0)
    up = (person.upper_lid_deg + person.lid_follow * gaze_elev_deg) * f**0.6
    lo = (-person.lower_lid_deg + person.lower_lid_follow * gaze_elev_deg) * f**0.8
    up = up * (1 - blink) + (lo - 2.0) * blink
    inside = (f > 0) & (el < up) & (el > lo)
    return inside, up, lo


def _sphere_hit(o: np.ndarray, d: np.ndarray, c: np.ndarray, r: float) -> np.ndarray:
    """Distance to the first hit of rays ``o + t d`` (o: 3, d: Nx3 unit) on a sphere; inf if none."""
    oc = o - c
    b = d @ oc
    cc = float(oc @ oc) - r * r
    disc = b * b - cc
    t = np.full(d.shape[0], np.inf)
    ok = disc >= 0
    sq = np.sqrt(disc[ok])
    t0 = -b[ok] - sq
    t1 = -b[ok] + sq
    tt = np.where(t0 > 1e-9, t0, np.where(t1 > 1e-9, t1, np.inf))
    t[ok] = tt
    return t


def _ellipsoid_hit(o: np.ndarray, d: np.ndarray, c: np.ndarray, radii: np.ndarray) -> np.ndarray:
    o2 = (o - c) / radii
    d2 = d / radii
    a = np.einsum("ij,ij->i", d2, d2)
    b = d2 @ o2
    cc = float(o2 @ o2) - 1.0
    disc = b * b - a * cc
    t = np.full(d.shape[0], np.inf)
    ok = disc >= 0
    t0 = (-b[ok] - np.sqrt(disc[ok])) / a[ok]
    t[ok] = np.where(t0 > 1e-9, t0, np.inf)
    return t


def _smoothstep(a: float, b: float, x: np.ndarray) -> np.ndarray:
    y = np.clip((x - a) / (b - a), 0, 1)
    return y * y * (3 - 2 * y)


# Region labels (low 3 bits) and glint flags, so edges can be found and supersampled.
BG, SKIN_L, LASH_L, SCLERA_L, IRIS_L, PUPIL_L, DARK_L = 0, 1, 2, 3, 4, 5, 6
SCREEN_GLINT, LAMP_GLINT = 8, 16
FEATURE_SHIFT = 5  # skin feature id (hair, brow, lips...) stored in the upper bits


def shade_rays(st: RenderState, origin: np.ndarray, dirs: np.ndarray, want_masks: bool = False) -> tuple[np.ndarray, dict[str, np.ndarray]]:
    """Colour (Nx3 float32 BGR, 0-255 before exposure) of world rays ``origin + t dirs``.

    With ``want_masks`` also returns 0/1 float masks (N,) for ``iris`` (iris or pupil visible),
    ``pupil``, ``screen_glint``, ``lamp_glint``, ``open`` (inside a lid opening)."""
    col, labels = shade_rays_labels(st, origin, dirs)
    masks = masks_from_labels(labels) if want_masks else {}
    return col, masks


def masks_from_labels(labels: np.ndarray) -> dict[str, np.ndarray]:
    base = labels & 7
    return {
        "iris": ((base == IRIS_L) | (base == PUPIL_L)).astype(np.float32),
        "pupil": (base == PUPIL_L).astype(np.float32),
        "screen_glint": ((labels & SCREEN_GLINT) > 0).astype(np.float32),
        "lamp_glint": ((labels & LAMP_GLINT) > 0).astype(np.float32),
        "open": ((base == SCLERA_L) | (base == IRIS_L) | (base == PUPIL_L) | (base == DARK_L)).astype(np.float32),
    }


def head_bounds(st: RenderState) -> tuple[np.ndarray, float]:
    """A world sphere containing the whole head (face, nose, eyes)."""
    return st.head_t + st.head_R @ FACE_CENTER, float(FACE_RADII.max() + 0.01)


UNTOUCHED = -1


def shade_rays_labels(st: RenderState, origin: np.ndarray, dirs: np.ndarray, eye_only: bool = False) -> tuple[np.ndarray, np.ndarray]:
    """Colour and region label of each world ray (see the label constants above).

    ``eye_only`` shades only rays that see an eye opening or a lid margin and labels every
    other ray ``UNTOUCHED`` (its colour is then meaningless): for re-shading the eyes on top of
    a coarse face."""
    n = dirs.shape[0]
    Rh, th = st.head_R, st.head_t
    o = Rh.T @ (origin - th)
    d = dirs @ Rh  # rows: Rh^T d
    light = Rh.T @ (st.light_dir / np.linalg.norm(st.light_dir))

    # Background: a dim wall with a vertical gradient.
    col = np.empty((n, 3), np.float32)
    col[:] = np.array([92, 98, 104], np.float32)
    col *= (0.9 + 0.12 * dirs[:, 1:2]).astype(np.float32)
    labels = np.full(n, UNTOUCHED if eye_only else BG, np.int32)

    # Only rays that can meet the head do any more work.
    hc, hr = head_bounds(st)
    near = np.nonzero(np.isfinite(_sphere_hit(origin, dirs, hc, hr)))[0]
    if len(near) == 0:
        return col, labels
    d = d[near]

    if eye_only:
        t_skin = np.full(len(near), np.inf)
    else:
        t_skin = _shade_skin(o, d, near, light, col, labels)
    _shade_eyes(st, o, d, near, light, t_skin, col, labels)
    return col, labels


def _shade_skin(o: np.ndarray, d: np.ndarray, near: np.ndarray, light: np.ndarray, col: np.ndarray, labels: np.ndarray) -> np.ndarray:
    # Head and nose.
    tf = _ellipsoid_hit(o, d, FACE_CENTER, FACE_RADII)
    tn = _ellipsoid_hit(o, d, NOSE_CENTER, NOSE_RADII)
    use_nose = tn < tf
    t_skin = np.minimum(tf, tn)
    hit = np.isfinite(t_skin)
    if np.any(hit):
        idx = np.nonzero(hit)[0]
        p = o + d[idx] * t_skin[idx, None]
        nose = use_nose[idx]
        c = np.where(nose[:, None], NOSE_CENTER, FACE_CENTER)
        r = np.where(nose[:, None], NOSE_RADII, FACE_RADII)
        nrm = (p - c) / (r * r)
        nrm /= np.linalg.norm(nrm, axis=1, keepdims=True)
        lam = np.clip(nrm @ light, 0, 1)
        base = np.repeat(SKIN[None, :], len(idx), axis=0)
        feat = np.zeros(len(idx), np.int32)
        x, y = p[:, 0], p[:, 1]
        hair = ((y < -0.052 - 0.35 * x * x / 0.077) | ((p[:, 2] > 0.075) & (y < 0.03))) & ~nose
        base[hair] = HAIR
        feat[hair] = 1
        band = np.abs(y) < 0.03
        for sx in (1.0, -1.0):
            dx = x - sx * 0.033
            near_eye = band & (np.abs(dx) < 0.03)
            if not np.any(near_eye):
                continue
            k = np.nonzero(near_eye)[0]
            dxk, yk = dx[k], y[k]
            yc = -0.0225 + 7.0 * dxk * dxk
            w = np.clip(1 - (dxk / 0.021) ** 2, 0, 1)
            brow = (np.abs(dxk) < 0.021) & (np.abs(yk - yc) < 0.0034 * np.sqrt(w)) & ~nose[k]
            base[k[brow]] = BROW
            feat[k[brow]] = 2
            dd = (dxk * dxk + (yk - 0.002) ** 2) / (0.017**2)
            base[k] *= (1 - 0.18 * np.exp(-dd))[:, None]
        mouth = np.nonzero((np.abs(x) < 0.025) & (np.abs(y - 0.07) < 0.008))[0]
        if len(mouth):
            xm, ym = x[mouth], y[mouth]
            lips = ((xm / 0.024) ** 2 + ((ym - 0.07) / 0.0075) ** 2 < 1) & ~nose[mouth]
            base[mouth[lips]] = LIPS
            feat[mouth[lips]] = 3
            line = lips & (np.abs(ym - 0.07) < 0.0011)
            base[mouth[line]] = LASH
            feat[mouth[line]] = 4
        nn = np.nonzero(nose & (np.abs(y - 0.049) < 0.003))[0]
        if len(nn):
            nost = (np.abs(np.abs(x[nn]) - 0.0065) / 0.004) ** 2 + ((y[nn] - 0.049) / 0.0022) ** 2 < 1
            base[nn[nost]] *= 0.35
            feat[nn[nost]] = 5
        feat[nose & (feat == 0)] = 6
        col[near[idx]] = base * (0.32 + 0.68 * lam)[:, None]
        labels[near[idx]] = SKIN_L | (feat << FEATURE_SHIFT)
    return t_skin


def _shade_eyes(st: RenderState, o: np.ndarray, d: np.ndarray, near: np.ndarray, light: np.ndarray, t_skin: np.ndarray, col: np.ndarray, labels: np.ndarray) -> None:
    Rh, th = st.head_R, st.head_t
    # Eyes: wherever a ray meets the lid sphere it sees into the socket.
    for side, eye in st.eyes.items():
        C = Rh.T @ (eye.center - th)
        tl = _sphere_hit(o, d, C, LID_RADIUS_M)
        sel = np.isfinite(tl) & (tl <= t_skin + 0.03)
        if not np.any(sel):
            continue
        idx = np.nonzero(sel)[0]
        dd_ = d[idx]
        pl = o + dd_ * tl[idx, None]
        v = pl - C
        sx = 1.0 if side == "left" else -1.0
        az_t = np.degrees(np.arctan2(sx * v[:, 0], -v[:, 2]))
        el = np.degrees(np.arcsin(np.clip(-v[:, 1] / LID_RADIUS_M, -1, 1)))
        inside, up, lo = lid_opening(az_t, el, st.person, eye.gaze_elev_deg, st.blink)
        # Lashes and lid margin just outside the opening.
        margin = ~inside & (el >= up) & (el < up + 1.6 + 1.5 * st.blink) & (np.abs(az_t) < 60)
        col[near[idx[margin]]] = LASH
        labels[near[idx[margin]]] = LASH_L
        lower_margin = ~inside & (el <= lo) & (el > lo - 0.8) & (np.abs(az_t) < 55)
        lower_margin &= labels[near[idx]] != UNTOUCHED
        col[near[idx[lower_margin]]] *= 0.75
        labels[near[idx[lower_margin]]] = LASH_L | (1 << FEATURE_SHIFT)
        if not np.any(inside):
            continue
        ii = idx[inside]
        di = d[ii]
        ecol = np.empty((len(ii), 3), np.float32)
        elab = np.full(len(ii), SCLERA_L, np.int32)
        opt = Rh.T @ eye.optical
        L = Rh.T @ (eye.limbus_center - th)
        u_ax = Rh.T @ eye.iris_u
        v_ax = Rh.T @ eye.iris_v
        # Iris disc.
        denom = di @ opt
        with np.errstate(divide="ignore", invalid="ignore"):
            ti = ((L - o) @ opt) / denom
        pi = o + di * ti[:, None]
        rel = pi - L
        ru, rv = rel @ u_ax, rel @ v_ax
        rho = np.hypot(ru, rv)
        on_iris = (ti > 0) & (denom < 0) & (rho <= LIMBUS_RADIUS_M)
        # Sclera.
        te = _sphere_hit(o, di, C, EYEBALL_RADIUS_M)
        pe = o + di * np.where(np.isfinite(te), te, 0)[:, None]
        ne = (pe - C) / EYEBALL_RADIUS_M
        lam = np.clip(ne @ light, 0, 1)
        shadow = 1 - 0.45 * np.exp(-np.clip(up[inside] - el[inside], 0, None) / 5.0)
        corner = 1 - 0.25 * np.clip((np.abs(az_t[inside]) - 30) / 30, 0, 1)
        ecol[:] = SCLERA[None, :] * ((0.55 + 0.45 * lam) * shadow * corner)[:, None]
        miss = ~np.isfinite(te)
        ecol[miss] = LASH
        elab[miss] = DARK_L
        # Iris texture.
        if np.any(on_iris):
            k = on_iris
            pr = eye.pupil_radius
            rn = np.clip((rho[k] - pr) / (LIMBUS_RADIUS_M - pr), 0, 1)
            th_ = np.arctan2(rv[k], ru[k])
            seed = 0.37 * st.seed + (0.0 if side == "left" else 1.3)
            stria = 0.84 + 0.16 * np.sin(th_ * 41 + 2.3 * np.sin(th_ * 7 + seed)) * (0.5 + 0.5 * np.sin(rn * 19 + seed))
            collar = 1 + 0.25 * _smoothstep(0.18, 0.28, rn) * (1 - _smoothstep(0.32, 0.42, rn))
            ring = 1 - 0.55 * _smoothstep(0.8, 1.0, rn)
            base = IRIS_COLORS.get(st.person.iris_color, IRIS_COLORS["brown"])
            ic = base[None, :] * (stria * collar * ring)[:, None]
            pupil = rho[k] <= pr
            ic[pupil] = PUPIL
            ic *= shadow[k][:, None] * 0.9 + 0.1
            ecol[k] = ic
            elab[k] = np.where(pupil, PUPIL_L, IRIS_L)
        # Cornea: specular reflections of the screen and a lamp.
        Cc = Rh.T @ (eye.cornea_center - th)
        tc = _sphere_hit(o, di, Cc, CORNEA_RADIUS_M)
        okc = np.isfinite(tc)
        if np.any(okc):
            pc = o + di[okc] * tc[okc, None]
            cap = ((pc - C) @ opt) >= IRIS_PLANE_M - 1e-9
            jj = np.nonzero(okc)[0][cap]
            pc = pc[cap]
            nc = (pc - Cc) / CORNEA_RADIUS_M
            dj = di[jj]
            refl = dj - 2 * (np.einsum("ij,ij->i", dj, nc))[:, None] * nc
            if st.screen_level > 0 and st.glint_gain > 0:
                S = (st.screen_corners - th) @ Rh  # head frame, 4x3
                ex = S[1] - S[0]
                ey = S[3] - S[0]
                w, h = np.linalg.norm(ex), np.linalg.norm(ey)
                ex, ey = ex / w, ey / h
                ns = np.cross(ex, ey)
                den = refl @ ns
                with np.errstate(divide="ignore", invalid="ignore"):
                    ts = ((S[0] - pc) @ ns) / den
                q = pc + refl * ts[:, None] - S[0]
                a, b = q @ ex, q @ ey
                on = (ts > 0) & (a >= 0) & (a <= w) & (b >= 0) & (b <= h)
                if np.any(on):
                    ecol[jj[on]] += 255.0 * st.screen_level * st.glint_gain
                    elab[jj[on]] |= SCREEN_GLINT
            if st.lamp_dir is not None and st.lamp_gain > 0:
                ld = Rh.T @ st.lamp_dir
                on = refl @ ld >= math.cos(math.radians(st.lamp_radius_deg))
                if np.any(on):
                    ecol[jj[on]] += 255.0 * st.lamp_gain
                    elab[jj[on]] |= LAMP_GLINT
        col[near[ii]] = ecol
        labels[near[ii]] = elab


def ray_grid(K: Intrinsics, rect: tuple[float, float, float, float], out_w: int, out_h: int, ss: int) -> np.ndarray:
    """Unit ray directions (camera frame) through ``ss x ss`` sub-samples of each output pixel of
    ``rect`` (upright full-frame pixels). Shape ``(out_h*ss, out_w*ss, 3)``."""
    x, y, w, h = rect
    xs = x + (np.arange(out_w * ss) + 0.5) / ss * (w / out_w)
    ys = y + (np.arange(out_h * ss) + 0.5) / ss * (h / out_h)
    rx = (xs - K.cx) / K.fx
    ry = (ys - K.cy) / K.fy
    dirs = np.empty((len(ys), len(xs), 3), np.float64)
    dirs[:, :, 0] = rx[None, :]
    dirs[:, :, 1] = ry[:, None]
    dirs[:, :, 2] = 1.0
    dirs /= np.linalg.norm(dirs, axis=2, keepdims=True)
    return dirs


def _pixel_rays(K: Intrinsics, rect, out_w: int, out_h: int, px: np.ndarray, py: np.ndarray, ox: np.ndarray | float = 0.5, oy: np.ndarray | float = 0.5) -> np.ndarray:
    """Unit camera-frame rays through output pixels ``(px, py)`` at sub-pixel offsets."""
    x, y, w, h = rect
    u = x + (px + ox) * (w / out_w)
    v = y + (py + oy) * (h / out_h)
    d = np.stack([(u - K.cx) / K.fx, (v - K.cy) / K.fy, np.ones_like(u, dtype=float)], axis=-1)
    return d / np.linalg.norm(d, axis=-1, keepdims=True)


def _project_sphere_box(st: RenderState, K: Intrinsics, rect, out_w: int, out_h: int, centre: np.ndarray, radius: float) -> tuple[int, int, int, int] | None:
    """Output-pixel box (x0, y0, x1, y1) that contains the image of a world sphere."""
    c = st.cam_R.T @ (centre - st.cam_t)
    if c[2] <= radius:
        return (0, 0, out_w, out_h)
    dist = float(np.linalg.norm(c))
    ang = math.asin(min(1.0, radius / dist))
    # Bound with the projection of the cone around the centre direction.
    u, v = K.project(tuple(c))  # type: ignore[arg-type]
    tan_c = math.hypot(c[0], c[1]) / c[2]
    grow = (1 + tan_c * tan_c) * 1.15
    ru = K.fx * math.tan(ang) * grow + 2
    rv = K.fy * math.tan(ang) * grow + 2
    x, y, w, h = rect
    sx, sy = out_w / w, out_h / h
    x0 = int(math.floor((u - ru - x) * sx))
    x1 = int(math.ceil((u + ru - x) * sx))
    y0 = int(math.floor((v - rv - y) * sy))
    y1 = int(math.ceil((v + rv - y) * sy))
    x0, y0 = max(0, x0), max(0, y0)
    x1, y1 = min(out_w, x1), min(out_h, y1)
    if x1 <= x0 or y1 <= y0:
        return None
    return (x0, y0, x1, y1)


def _opening_box(st: RenderState, eye: EyeState, K: Intrinsics, rect, out_w: int, out_h: int) -> tuple[int, int, int, int] | None:
    """Output-pixel box around everything :func:`_shade_eyes` can draw for one eye (the lid
    opening plus lashes), from a ring of points on the lid sphere."""
    nasal, temporal = st.person.corner_deg
    az = np.linspace(-nasal - 2, temporal + 2, 25)
    _, up, lo = lid_opening(np.clip(az, -nasal, temporal), np.zeros_like(az), st.person, eye.gaze_elev_deg, 0.0)
    els = np.concatenate([np.maximum(up, lo) + 4.0, np.minimum(lo, up) - 2.0, np.zeros(1) + 4.0])
    azs = np.concatenate([az, az, [0.0]])
    sx = 1.0 if eye.side == "left" else -1.0
    a, e = np.radians(azs), np.radians(np.clip(els, -89, 89))
    v = np.stack([sx * np.sin(a) * np.cos(e), -np.sin(e), -np.cos(a) * np.cos(e)], axis=1) * (LID_RADIUS_M + 0.5e-3)
    Rh, th = st.head_R, st.head_t
    C_h = Rh.T @ (eye.center - th)
    pw = th + (C_h + v) @ Rh.T
    pc = (pw - st.cam_t) @ st.cam_R
    if np.any(pc[:, 2] <= 1e-3):
        return _project_sphere_box(st, K, rect, out_w, out_h, eye.center, LID_RADIUS_M)
    u = K.fx * pc[:, 0] / pc[:, 2] + K.cx
    w = K.fy * pc[:, 1] / pc[:, 2] + K.cy
    x, y, rw, rh = rect
    sx_, sy_ = out_w / rw, out_h / rh
    x0 = max(0, int(math.floor((u.min() - x) * sx_)) - 2)
    x1 = min(out_w, int(math.ceil((u.max() - x) * sx_)) + 2)
    y0 = max(0, int(math.floor((w.min() - y) * sy_)) - 2)
    y1 = min(out_h, int(math.ceil((w.max() - y) * sy_)) + 2)
    if x1 <= x0 or y1 <= y0:
        return None
    return (x0, y0, x1, y1)


def _shade_pixels(st: RenderState, K: Intrinsics, rect, out_w: int, out_h: int, px: np.ndarray, py: np.ndarray, ss: int) -> tuple[np.ndarray, np.ndarray, np.ndarray]:
    """Shade pixels at their centres; supersample (``ss x ss``) the ones on a label edge.
    Returns colour (N,3), labels at the centre (N,), and per-mask coverage (N,5)."""
    dirs = _pixel_rays(K, rect, out_w, out_h, px.astype(float), py.astype(float)) @ st.cam_R.T
    col, lab = shade_rays_labels(st, st.cam_t, dirs)
    cov = np.stack(list(masks_from_labels(lab).values()), axis=1)
    return col, lab, cov


def render_region(
    st: RenderState,
    K: Intrinsics,
    rect: tuple[float, float, float, float],
    out_w: int,
    out_h: int,
    ss: int = 1,
    want_masks: bool = False,
    skin_scale: int = 1,
) -> tuple[np.ndarray, dict[str, np.ndarray]]:
    """Render ``rect`` of the upright full frame (camera ``K``, pose in ``st``) at ``out_w x out_h``.

    Every pixel is shaded at its centre; pixels whose region label differs from a neighbour's
    (iris edge, lids, glints, face outline) are re-shaded with ``ss x ss`` sub-samples, so edges
    are anti-aliased exactly where it matters. With ``skin_scale > 1`` the face away from the
    eyes is shaded at reduced resolution and upsampled (cosmetic only; the eye regions are
    always shaded at full resolution).

    Returns a float32 BGR image (0-255, not clipped, no noise or blur) and, with ``want_masks``,
    coverage masks (fraction of sub-samples) of the same size."""
    import cv2

    names = ("iris", "pupil", "screen_glint", "lamp_glint", "open")
    img = np.empty((out_h, out_w, 3), np.float32)
    lab = np.zeros((out_h, out_w), np.int32)
    cov = np.zeros((out_h, out_w, 5), np.float32)
    hc, hr = head_bounds(st)
    head_box = _project_sphere_box(st, K, rect, out_w, out_h, hc, hr)
    eye_boxes = [b for b in (_opening_box(st, e, K, rect, out_w, out_h) for e in st.eyes.values()) if b is not None]
    # Background everywhere first.
    yy = (np.arange(out_h) + 0.5) * (rect[3] / out_h) + rect[1]
    vdir = (yy - K.cy) / K.fy
    img[:] = np.array([92, 98, 104], np.float32)[None, None, :]
    img *= (0.9 + 0.12 * (vdir / np.sqrt(1 + vdir * vdir)))[:, None, None].astype(np.float32)
    if head_box is None:
        return img, ({k: cov[:, :, i] for i, k in enumerate(names)} if want_masks else {})

    def shade_box(box: tuple[int, int, int, int]) -> None:
        x0, y0, x1, y1 = box
        py, px = np.mgrid[y0:y1, x0:x1]
        c, lb, cv = _shade_pixels(st, K, rect, out_w, out_h, px.ravel(), py.ravel(), 1)
        img[y0:y1, x0:x1] = c.reshape(y1 - y0, x1 - x0, 3)
        lab[y0:y1, x0:x1] = lb.reshape(y1 - y0, x1 - x0)
        cov[y0:y1, x0:x1] = cv.reshape(y1 - y0, x1 - x0, 5)

    hx0, hy0, hx1, hy1 = head_box
    if skin_scale > 1 and not want_masks:
        # Coarse pass over the head box, upsampled; then full resolution around the eyes.
        cw = max(1, (hx1 - hx0 + skin_scale - 1) // skin_scale)
        ch = max(1, (hy1 - hy0 + skin_scale - 1) // skin_scale)
        sub_rect = (
            rect[0] + hx0 * rect[2] / out_w,
            rect[1] + hy0 * rect[3] / out_h,
            cw * skin_scale * rect[2] / out_w,
            ch * skin_scale * rect[3] / out_h,
        )
        py, px = np.mgrid[0:ch, 0:cw]
        dirs = _pixel_rays(K, sub_rect, cw, ch, px.ravel().astype(float), py.ravel().astype(float)) @ st.cam_R.T
        c, lb = shade_rays_labels(st, st.cam_t, dirs)
        up = cv2.resize(c.reshape(ch, cw, 3), (cw * skin_scale, ch * skin_scale), interpolation=cv2.INTER_LINEAR)
        img[hy0:hy1, hx0:hx1] = up[: hy1 - hy0, : hx1 - hx0]
        lab[hy0:hy1, hx0:hx1] = SKIN_L
        for x0, y0, x1, y1 in eye_boxes:
            py, px = np.mgrid[y0:y1, x0:x1]
            dirs = _pixel_rays(K, rect, out_w, out_h, px.ravel().astype(float), py.ravel().astype(float)) @ st.cam_R.T
            c, lb = shade_rays_labels(st, st.cam_t, dirs, eye_only=True)
            touched = lb != UNTOUCHED
            ty, tx = py.ravel()[touched], px.ravel()[touched]
            img[ty, tx] = c[touched]
            lab[ty, tx] = lb[touched]
        fine_boxes = eye_boxes
    else:
        shade_box(head_box)
        fine_boxes = [head_box]

    if ss > 1:
        # Edge pixels inside the full-resolution boxes get supersampled.
        edge = np.zeros((out_h, out_w), bool)
        for x0, y0, x1, y1 in fine_boxes:
            sub = lab[y0:y1, x0:x1]
            e = np.zeros(sub.shape, bool)
            dx = sub[:, 1:] != sub[:, :-1]
            dy = sub[1:, :] != sub[:-1, :]
            e[:, 1:] |= dx
            e[:, :-1] |= dx
            e[1:, :] |= dy
            e[:-1, :] |= dy
            edge[y0:y1, x0:x1] |= e
        ey, ex = np.nonzero(edge)
        if len(ex):
            # N-rooks pattern: every sub-sample has its own x and its own y, so straight edges
            # aligned with the pixel grid are resolved to 1/ss^2 of a pixel, not 1/ss.
            i, j = np.meshgrid(np.arange(ss), np.arange(ss))
            ox = ((i + (j + 0.5) / ss) / ss).ravel()
            oy = ((j + (i + 0.5) / ss) / ss).ravel()
            m = len(ox)
            px = np.repeat(ex, m).astype(float)
            py = np.repeat(ey, m).astype(float)
            dirs = _pixel_rays(K, rect, out_w, out_h, px, py, np.tile(ox, len(ex)), np.tile(oy, len(ex))) @ st.cam_R.T
            eye_only = skin_scale > 1 and not want_masks
            c, lb = shade_rays_labels(st, st.cam_t, dirs, eye_only=eye_only)
            if eye_only:
                # Sub-samples that miss the eyes keep the pixel's (coarse) skin colour.
                miss = lb == UNTOUCHED
                c[miss] = np.repeat(img[ey, ex], m, axis=0)[miss]
                lb[miss] = SKIN_L
            img[ey, ex] = c.reshape(len(ex), m, 3).mean(axis=1)
            cv = np.stack(list(masks_from_labels(lb).values()), axis=1)
            cov[ey, ex] = cv.reshape(len(ex), m, 5).mean(axis=1)
    masks = {k: cov[:, :, i] for i, k in enumerate(names)} if want_masks else {}
    return img, masks


def finish_image(
    img: np.ndarray,
    rng: np.random.Generator,
    *,
    blur_sigma: float = 0.0,
    motion: tuple[float, float] = (0.0, 0.0),
    gain: float = 1.0,
    noise: float = 0.0,
) -> np.ndarray:
    """Apply defocus (Gaussian), motion blur (line kernel, in output pixels), exposure gain and
    sensor noise; return uint8. ``img`` should include any padding the blur needs."""
    import cv2

    out = img
    if blur_sigma > 0.05:
        out = cv2.GaussianBlur(out, (0, 0), sigmaX=float(blur_sigma), borderType=cv2.BORDER_REPLICATE)
    mlen = math.hypot(*motion)
    if mlen > 0.7:
        k = int(math.ceil(mlen)) | 1
        ker = np.zeros((k, k), np.float32)
        c = k // 2
        steps = max(2, int(mlen * 3))
        for s in np.linspace(-0.5, 0.5, steps):
            ker[int(round(c + s * motion[1])), int(round(c + s * motion[0]))] += 1
        ker /= ker.sum()
        out = cv2.filter2D(out, -1, ker, borderType=cv2.BORDER_REPLICATE)
    if gain != 1.0:
        out = out * gain
    if noise > 0:
        out = out + rng.standard_normal(out.shape, dtype=np.float32) * noise
    return np.clip(out, 0, 255).astype(np.uint8)


def describe_eye(eye: EyeState) -> dict[str, Any]:
    return {
        "center": eye.center.tolist(),
        "optical": eye.optical.tolist(),
        "visual": eye.visual.tolist(),
        "corneaCenter": eye.cornea_center.tolist(),
        "limbusCenter": eye.limbus_center.tolist(),
    }
