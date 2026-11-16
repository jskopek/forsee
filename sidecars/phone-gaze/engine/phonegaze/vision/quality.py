"""Image quality: sharpness, exposure, iris size. Owner: Vision."""

from __future__ import annotations

from typing import Any

from ..types import DecodedFrame, Observation


def measure_quality(frame: DecodedFrame, obs: Observation | None) -> dict[str, Any]:
    """Numbers Core's aiming uses to compare cameras and zooms. Keys (all optional/None):
    ``iris_px`` (mean iris diameter, pixels), ``sharpness`` (higher is sharper, unitless,
    comparable across zooms), ``brightness`` (0-255 mean of the eye regions),
    ``eyes_in_frame`` (0, 1 or 2), ``edge_margin`` (smallest distance from an eye to the frame
    edge, fraction of the frame)."""
    raise NotImplementedError
