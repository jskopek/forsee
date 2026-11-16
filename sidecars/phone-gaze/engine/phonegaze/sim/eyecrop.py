"""One synthetic eye crop with exact ground truth, for vision tests. Owner: Simulator.

Usage::

    from phonegaze.sim.eyecrop import render_eye_crop

    img, truth = render_eye_crop("left", distance_m=0.6, zoom=2.0, gaze=(300, 200))
    truth["crop"]["irisEllipse"]      # (cx, cy, a, b, angle_deg) in crop pixels, exact
    truth["crop"]["reflectionCenter"] # where the screen centre is mirrored, crop pixels

``img`` is an UPRIGHT BGR uint8 crop (no rotation games). Pixel coordinates follow
``types.py`` (continuous, pixel centre at +0.5). ``truth`` holds:

- ``crop``: the eye's facts in crop pixels: ``irisCenter`` (projection of the 3D limbus centre),
  ``irisEllipse`` (the exact image of the limbus), ``irisRadius``, ``pupilCenter``,
  ``pupilEllipse``, ``eyeballCenter``, ``reflectionCenter``, ``reflectionCorners`` (images of
  the screen's TL, TR, BR, BL), ``reflectionVisible``, ``innerCorner``, ``outerCorner``,
  ``upperLid``, ``lowerLid``, ``openness``;
- ``full``: the same in upright full-frame pixels; ``rect``: the crop's ``(x, y, w, h)`` in
  full-frame pixels; ``intrinsics``: upright full-frame intrinsics (``Intrinsics.to_dict``);
- ``sim``: the whole frame ``sim`` block (3D eye centres, gaze directions, head pose...);
- ``masks`` (with ``with_masks=True``): coverage maps (0-1 per pixel) ``iris`` (iris or pupil
  visible), ``pupil``, ``screen_glint``, ``lamp_glint``, ``open`` (inside the lid opening).

Noise, blur and exposure are applied only when asked; the default image is clean.
"""

from __future__ import annotations

from typing import Any

import numpy as np

from .render import finish_image, render_region
from .scene import SimScene

_POINT_KEYS = ("irisCenter", "pupilCenter", "eyeballCenter", "corneaCenter", "reflectionCenter", "innerCorner", "outerCorner", "upperLid", "lowerLid")


def render_eye_crop(
    side: str = "left",
    *,
    distance_m: float = 0.6,
    zoom: float = 2.0,
    camera: str = "wide",
    gaze: tuple[float, float] | None = None,
    head_offset_m: tuple[float, float, float] = (0.0, 0.0, 0.0),
    head_rotation_deg: tuple[float, float, float] = (0.0, 0.0, 0.0),
    crop_size: tuple[int, int] = (256, 160),
    blink: float = 0.0,
    pupil_radius_m: float | None = None,
    iris_color: str | None = None,
    lids_deg: tuple[float, float] | None = None,
    screen_level: float = 1.0,
    glint_gain: float | None = None,
    lamp: bool = True,
    noise: float = 0.0,
    blur_px: float = 0.0,
    gain: float = 1.0,
    ss: int = 3,
    seed: int = 1,
    with_masks: bool = False,
) -> tuple[np.ndarray, dict[str, Any]]:
    """Render one eye of the synthetic person (see the module docstring)."""
    if side not in ("left", "right"):
        raise ValueError(side)
    sc = SimScene(seed, orientation=0, camera=camera)
    k = sc.knobs
    k.jitter_deg = 0.0
    k.blink_rate_per_min = 0.0
    k.lamp = lamp
    if glint_gain is not None:
        k.glint_gain = glint_gain
    if iris_color is not None:
        sc.person.params.iris_color = iris_color
    if lids_deg is not None:
        # (upper, lower) lid heights in degrees from the eye centre; (50, 50) shows the whole iris.
        sc.person.params.upper_lid_deg, sc.person.params.lower_lid_deg = (float(v) for v in lids_deg)
    if pupil_radius_m is not None:
        for ep in sc.person.eyes.values():
            ep.pupil_radius_m = pupil_radius_m
    cam = sc.camera
    w, h, _ = cam.pick_format(3840)
    sc.set_camera(cam.id, w, h, zoom)
    direction = np.array([0.0, -0.03, 0.6])
    pos = direction / np.linalg.norm(direction) * distance_m + np.asarray(head_offset_m, dtype=float)
    sc.set_head(list(pos), list(head_rotation_deg))
    gx, gy = gaze if gaze is not None else (sc.screen.width / 2, sc.screen.height / 2)
    sc.look_at(gx, gy, human=False)
    sc.person.step(1e-6)
    cap = sc.capture()
    st = cap.state
    st.blink = float(blink)
    st.screen_level = float(screen_level)
    if blink:
        cap.truth = sc._truth(cap)  # noqa: SLF001 - lids moved
    full = cap.truth["eyes"][side]
    cw, ch = crop_size
    x0 = float(np.floor(full["irisCenter"][0] - cw / 2))
    y0 = float(np.floor(full["irisCenter"][1] - ch / 2))
    rect = (x0, y0, float(cw), float(ch))
    img, masks = render_region(st, cap.K_up, rect, cw, ch, ss=ss, want_masks=with_masks)
    if blur_px > 0:
        pad = int(np.ceil(3 * blur_px)) + 1
        big, _ = render_region(st, cap.K_up, (x0 - pad, y0 - pad, cw + 2 * pad, ch + 2 * pad), cw + 2 * pad, ch + 2 * pad, ss=ss)
        out = finish_image(big, np.random.default_rng(seed), blur_sigma=blur_px, gain=gain, noise=noise)[pad : pad + ch, pad : pad + cw]
    else:
        out = finish_image(img, np.random.default_rng(seed), gain=gain, noise=noise)

    def shift(p: list[float]) -> list[float]:
        return [p[0] - x0, p[1] - y0]

    crop: dict[str, Any] = {}
    for key, val in full.items():
        if key in _POINT_KEYS:
            crop[key] = shift(val)
        elif key in ("irisEllipse", "pupilEllipse"):
            crop[key] = [val[0] - x0, val[1] - y0, *val[2:]]
        elif key == "reflectionCorners":
            crop[key] = [shift(p) for p in val]
        else:
            crop[key] = val
    truth: dict[str, Any] = {
        "side": side,
        "crop": crop,
        "full": full,
        "rect": list(rect),
        "intrinsics": cap.K_up.to_dict(),
        "sim": cap.truth,
    }
    if with_masks:
        truth["masks"] = masks
    return np.ascontiguousarray(out), truth
