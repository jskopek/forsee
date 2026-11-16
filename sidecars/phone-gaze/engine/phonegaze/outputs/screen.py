"""Main display geometry. Owner: Core.

On macOS reads ``CGDisplayBounds`` (points), ``CGDisplayScreenSize`` (millimetres) and the
backing scale through ctypes, with no extra dependency. Elsewhere returns a 1440x900 pt,
286x179 mm placeholder with ``source="fallback"`` so Linux tests run.
"""

from __future__ import annotations

from ..types import ScreenInfo


def get_screen_info() -> ScreenInfo:
    raise NotImplementedError
