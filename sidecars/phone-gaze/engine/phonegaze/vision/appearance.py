"""Appearance estimator (optional pretrained network). Owner: Vision. Deliberately a stub.

Decision (2026-11-16): no pretrained gaze model is shipped or downloaded. The brief allows one
only if its code, weights AND training data licences are all compatible with an MIT project and
the weights can be downloaded here. ``docs/research/04-appearance-models-and-open-source.md``
found none:

- L2CS-Net, MobileGaze, WebEyeTrack and hysts' demo have MIT code, but their weights are trained
  on MPIIFaceGaze / ETH-XGaze (CC BY-NC-SA 4.0), Gaze360 ("non-commercial research only") or
  GazeCapture (bans commercial use of models trained on it).
- UniGaze, GazeFollower, OpenFace 3, the ETH-XGaze baseline and FAZE have non-commercial code.

The research note's optional idea (a MobileGaze ONNX plug-in, off by default, labelled
non-commercial) is left for the owner to decide on. If added later: download into the ignored
models folder with ``download.ensure_model`` on first use, run with ``onnxruntime`` on a
Zhang-normalised face crop, and fill ``gaze_dir`` with ``extra["appearance"]["license"]`` set.

The class exists so ``"appearance"`` in ``estimators.order`` is valid; it adds nothing.
"""

from __future__ import annotations

import logging
from typing import Any

from ..types import DecodedFrame, Observation

log = logging.getLogger(__name__)

REASON = (
    "no pretrained gaze model has code, weights and training data all under licences compatible "
    "with an MIT project (see docs/research/04-appearance-models-and-open-source.md)"
)


class AppearanceEstimator:
    """[``appearance``] Placeholder: always returns ``None`` (adds nothing)."""

    name = "appearance"

    def __init__(self, config: Any = None) -> None:
        self.config = config
        self._warned = False

    def reset(self) -> None:
        pass

    def process(self, frame: DecodedFrame, previous: Observation | None) -> Observation | None:
        if not self._warned:
            log.info("appearance estimator is a stub: %s", REASON)
            self._warned = True
        return None
