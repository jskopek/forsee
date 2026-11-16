"""Main display geometry. Owner: Core.

On macOS reads ``CGDisplayBounds`` (points), ``CGDisplayScreenSize`` (millimetres) and the
backing scale through ctypes, with no extra dependency. Elsewhere returns a 1440x900 pt,
286x179 mm placeholder with ``source="fallback"`` so Linux tests run.

:func:`screen_from_browser` builds a ``ScreenInfo`` from the UI's ``ui.screen`` message, used
when macOS could not be asked.
"""

from __future__ import annotations

import logging
from typing import Any

from ..types import ScreenInfo
from ._quartz import quartz

log = logging.getLogger(__name__)

FALLBACK = ScreenInfo(width=1440, height=900, width_mm=286.0, height_mm=179.0, scale=2.0, name="placeholder", source="fallback")

# Without EDID data macOS reports 72 dpi (2.835 px/mm); treat that as "unknown".
_BOGUS_MM_PER_PT = 25.4 / 72.0
# A typical Mac laptop: about 127 points per inch. Used only when nothing better is known.
_TYPICAL_MM_PER_PT = 25.4 / 127.0


def get_screen_info() -> ScreenInfo:
    q = quartz()
    if q is None:
        return ScreenInfo(**FALLBACK.to_dict())
    try:
        x, y, w, h = q.display_bounds()
        wmm, hmm = q.display_size_mm()
        scale = q.backing_scale()
    except Exception as exc:  # noqa: BLE001
        log.warning("cannot read the main display from macOS: %s", exc)
        return ScreenInfo(**FALLBACK.to_dict())
    width_mm: float | None = float(wmm) if wmm and wmm > 0 else None
    height_mm: float | None = float(hmm) if hmm and hmm > 0 else None
    name = "main display"
    if width_mm and w and abs(width_mm / w - _BOGUS_MM_PER_PT) < 0.002:
        # Sanity check: the 72 dpi default means macOS does not know the size.
        log.warning("macOS does not know the display's physical size; assuming a typical laptop density")
        width_mm, height_mm = w * _TYPICAL_MM_PER_PT, h * _TYPICAL_MM_PER_PT
        name = "main display (size estimated)"
    return ScreenInfo(width=float(w), height=float(h), width_mm=width_mm, height_mm=height_mm, scale=scale or 1.0, name=name, source="macos")


def screen_from_browser(msg: dict[str, Any]) -> ScreenInfo | None:
    """From a ``ui.screen`` message. Only trusted when the page is fullscreen (then the inner
    size is the screen size in points). Physical size is estimated (typical laptop density)."""
    try:
        w = float(msg["inner_width"])
        h = float(msg["inner_height"])
    except (KeyError, TypeError, ValueError):
        return None
    if not msg.get("fullscreen") or w <= 0 or h <= 0:
        return None
    return ScreenInfo(
        width=w,
        height=h,
        width_mm=w * _TYPICAL_MM_PER_PT,
        height_mm=h * _TYPICAL_MM_PER_PT,
        scale=float(msg.get("device_pixel_ratio") or 1.0),
        name="browser (size estimated)",
        source="browser",
    )
