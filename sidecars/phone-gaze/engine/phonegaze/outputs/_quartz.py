"""Minimal ctypes binding to the macOS Quartz calls the outputs need. Owner: Core.

Nothing is loaded at import time; :func:`quartz` returns ``None`` on other systems or when the
frameworks cannot be loaded, so every caller degrades instead of crashing. No PyObjC needed.

Coordinates: Quartz "global display coordinates" are points with the origin at the top-left of
the MAIN display, y down; the same as the engine's screen points. Retina needs no scaling.
"""

from __future__ import annotations

import ctypes
import ctypes.util
import logging
import sys
from functools import lru_cache
from typing import Any

log = logging.getLogger(__name__)

# CGEventType
MOUSE_MOVED = 5
LEFT_MOUSE_DOWN = 1
LEFT_MOUSE_UP = 2
LEFT_BUTTON = 0
HID_EVENT_TAP = 0


class CGPoint(ctypes.Structure):
    _fields_ = [("x", ctypes.c_double), ("y", ctypes.c_double)]


class CGSize(ctypes.Structure):
    _fields_ = [("width", ctypes.c_double), ("height", ctypes.c_double)]


class CGRect(ctypes.Structure):
    _fields_ = [("origin", CGPoint), ("size", CGSize)]


class Quartz:
    """The loaded functions. Construct with :func:`quartz`."""

    def __init__(self, cg: Any, cf: Any) -> None:
        self.cg = cg
        self.cf = cf
        cg.CGMainDisplayID.restype = ctypes.c_uint32
        cg.CGDisplayBounds.restype = CGRect
        cg.CGDisplayBounds.argtypes = [ctypes.c_uint32]
        cg.CGDisplayScreenSize.restype = CGSize
        cg.CGDisplayScreenSize.argtypes = [ctypes.c_uint32]
        cg.CGDisplayCopyDisplayMode.restype = ctypes.c_void_p
        cg.CGDisplayCopyDisplayMode.argtypes = [ctypes.c_uint32]
        cg.CGDisplayModeGetPixelWidth.restype = ctypes.c_size_t
        cg.CGDisplayModeGetPixelWidth.argtypes = [ctypes.c_void_p]
        cg.CGDisplayModeGetWidth.restype = ctypes.c_size_t
        cg.CGDisplayModeGetWidth.argtypes = [ctypes.c_void_p]
        cg.CGDisplayModeRelease.argtypes = [ctypes.c_void_p]
        cg.CGEventCreateMouseEvent.restype = ctypes.c_void_p
        cg.CGEventCreateMouseEvent.argtypes = [ctypes.c_void_p, ctypes.c_uint32, CGPoint, ctypes.c_uint32]
        cg.CGEventPost.argtypes = [ctypes.c_uint32, ctypes.c_void_p]
        cg.CGWarpMouseCursorPosition.argtypes = [CGPoint]
        cg.CGEventCreate.restype = ctypes.c_void_p
        cg.CGEventCreate.argtypes = [ctypes.c_void_p]
        cg.CGEventGetLocation.restype = CGPoint
        cg.CGEventGetLocation.argtypes = [ctypes.c_void_p]
        cf.CFRelease.argtypes = [ctypes.c_void_p]
        self._preflight_post = getattr(cg, "CGPreflightPostEventAccess", None)
        if self._preflight_post is not None:
            self._preflight_post.restype = ctypes.c_bool
        self._ax_trusted = None
        try:
            app = ctypes.cdll.LoadLibrary("/System/Library/Frameworks/ApplicationServices.framework/ApplicationServices")
            self._ax_trusted = app.AXIsProcessTrusted
            self._ax_trusted.restype = ctypes.c_bool
        except OSError:
            pass

    # -- displays ----------------------------------------------------------------------------

    def main_display(self) -> int:
        return int(self.cg.CGMainDisplayID())

    def display_bounds(self, display: int | None = None) -> tuple[float, float, float, float]:
        r = self.cg.CGDisplayBounds(self.main_display() if display is None else display)
        return (r.origin.x, r.origin.y, r.size.width, r.size.height)

    def display_size_mm(self, display: int | None = None) -> tuple[float, float]:
        s = self.cg.CGDisplayScreenSize(self.main_display() if display is None else display)
        return (s.width, s.height)

    def backing_scale(self, display: int | None = None) -> float:
        mode = self.cg.CGDisplayCopyDisplayMode(self.main_display() if display is None else display)
        if not mode:
            return 1.0
        try:
            pw = self.cg.CGDisplayModeGetPixelWidth(mode)
            w = self.cg.CGDisplayModeGetWidth(mode)
            return float(pw) / float(w) if w else 1.0
        finally:
            self.cg.CGDisplayModeRelease(mode)

    # -- permissions -------------------------------------------------------------------------

    def can_post_events(self) -> bool | None:
        """``CGPreflightPostEventAccess`` (macOS 10.15+), else ``AXIsProcessTrusted``."""
        if self._preflight_post is not None:
            return bool(self._preflight_post())
        return self.accessibility_trusted()

    def accessibility_trusted(self) -> bool | None:
        return None if self._ax_trusted is None else bool(self._ax_trusted())

    # -- pointer -----------------------------------------------------------------------------

    def mouse_location(self) -> tuple[float, float]:
        ev = self.cg.CGEventCreate(None)
        try:
            p = self.cg.CGEventGetLocation(ev)
            return (p.x, p.y)
        finally:
            if ev:
                self.cf.CFRelease(ev)

    def post_mouse(self, event_type: int, x: float, y: float) -> None:
        ev = self.cg.CGEventCreateMouseEvent(None, event_type, CGPoint(x, y), LEFT_BUTTON)
        if not ev:
            raise OSError("CGEventCreateMouseEvent failed")
        try:
            self.cg.CGEventPost(HID_EVENT_TAP, ev)
        finally:
            self.cf.CFRelease(ev)

    def move(self, x: float, y: float) -> None:
        self.post_mouse(MOUSE_MOVED, x, y)

    def warp(self, x: float, y: float) -> None:
        self.cg.CGWarpMouseCursorPosition(CGPoint(x, y))

    def click(self, x: float, y: float) -> None:
        self.post_mouse(LEFT_MOUSE_DOWN, x, y)
        self.post_mouse(LEFT_MOUSE_UP, x, y)


@lru_cache(maxsize=1)
def quartz() -> Quartz | None:
    """The Quartz binding, or ``None`` when not on macOS or it cannot be loaded."""
    if sys.platform != "darwin":
        return None
    try:
        cg = ctypes.cdll.LoadLibrary(
            ctypes.util.find_library("CoreGraphics")
            or "/System/Library/Frameworks/CoreGraphics.framework/CoreGraphics"
        )
        cf = ctypes.cdll.LoadLibrary(
            ctypes.util.find_library("CoreFoundation")
            or "/System/Library/Frameworks/CoreFoundation.framework/CoreFoundation"
        )
        return Quartz(cg, cf)
    except (OSError, AttributeError) as exc:
        log.warning("cannot load Quartz: %s", exc)
        return None
