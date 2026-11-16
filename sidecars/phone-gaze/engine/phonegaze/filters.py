"""Smoothing, fixation and blink handling on the gaze stream. Owner: Models.

Imported by: ``pipeline.py`` (``build_filter``).
"""

from __future__ import annotations

from typing import Protocol

from .config import FiltersConfig
from .types import GazePoint, Observation


class GazeFilter(Protocol):
    """``update`` receives each raw model output (``None`` when there is none) and the frame's
    observation; it returns the point to emit (may be held during a blink), or ``None``."""

    def update(self, point: GazePoint | None, obs: Observation | None) -> GazePoint | None: ...

    def reset(self) -> None: ...


def build_filter(config: FiltersConfig) -> GazeFilter:
    """The filter named by ``config.kind`` (``"none"`` passes points through)."""
    raise NotImplementedError
