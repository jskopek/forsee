"""Synthetic scene. Owner: Simulator."""

from __future__ import annotations

from typing import Any

import numpy as np

from ..types import ScreenInfo


class SimScene:
    """A person looking at a screen, filmed by a phone.

    Geometry is in metres in the phone's UPRIGHT camera frame (x right, y down, z forward).
    """

    def __init__(self, seed: int = 1) -> None:
        self.seed = seed

    @property
    def screen(self) -> ScreenInfo:
        """The simulated display (``source="sim"``); the engine uses it instead of macOS's."""
        raise NotImplementedError

    def look_at(self, x: float, y: float) -> None:
        """Make the person look at screen point ``(x, y)`` (points)."""
        raise NotImplementedError

    def step(self, dt: float) -> None:
        """Advance head motion, blinks and fixational noise by ``dt`` seconds."""
        raise NotImplementedError

    def render(self, camera: str, zoom: float, width: int, height: int) -> tuple[np.ndarray, dict[str, Any]]:
        """A SENSOR-orientation BGR image of the scene and the ``camera`` header fields
        (intrinsics included, ``intrinsicsIncludeZoom: true``)."""
        raise NotImplementedError

    def truth(self) -> dict[str, Any]:
        """The ``sim`` header block (PROTOCOL.md "Simulator extensions")."""
        raise NotImplementedError
