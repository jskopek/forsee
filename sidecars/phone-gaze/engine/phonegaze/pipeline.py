"""The frame loop and the Engine object that owns all running state. Owner: Core.

Per frame: ``Frame`` -> ``DecodedFrame.from_frame`` (upright) -> estimator chain
(:func:`run_estimators`) -> active ``GazeModel.predict`` -> filter -> every ``OutputSink``.
Also feeds calibration runs, the recorder, and the UI's WebSocket.

Imported by: ``server.py`` (``Engine``), ``__main__.py``, ``replay.py``, end-to-end tests.
"""

from __future__ import annotations

import logging
from typing import Any

from .config import Config
from .types import DecodedFrame, Estimator, GazePoint, Observation, ScreenInfo

log = logging.getLogger(__name__)


def run_estimators(estimators: list[Estimator], frame: DecodedFrame) -> Observation:
    """Run the chain exactly as :class:`phonegaze.types.Estimator` specifies.

    Implemented by Foundation so every area (and replay) shares one definition. Core may add
    timing and rate-limited logging but must keep the semantics.
    """
    obs = Observation.empty(frame)
    for est in estimators:
        try:
            result = est.process(frame, obs)
        except Exception:  # noqa: BLE001 - one bad estimator must not stop the frame
            log.exception("estimator %s failed on frame %s", getattr(est, "name", est), frame.frame.seq)
            continue
        if result is not None:
            obs = result
            obs.estimators.append(est.name)
    return obs


class Engine:
    """Everything that runs: config, phone client, estimators, models, filter, outputs,
    calibration, recorder. One instance per process; ``server.py`` wraps it in HTTP.

    Public attributes the server and tests read:

    - ``config: Config``
    - ``screen: ScreenInfo``
    - ``last_obs: Observation | None``, ``last_gaze: GazePoint | None``
    - ``paused: bool``
    """

    def __init__(self, config: Config) -> None:
        self.config = config
        self.screen: ScreenInfo | None = None
        self.last_obs: Observation | None = None
        self.last_gaze: GazePoint | None = None
        self.paused = False

    async def start(self) -> None:
        """Connect to the phone (or simulator), start the frame loop and outputs."""
        raise NotImplementedError

    async def stop(self) -> None:
        raise NotImplementedError

    def state(self) -> dict[str, Any]:
        """The ``state`` object sent to the UI (shape in docs/INTERFACES.md)."""
        raise NotImplementedError

    def subscribe(self, callback: Any) -> Any:
        """Register ``callback(message: dict)`` for UI WebSocket messages; returns an
        unsubscribe function."""
        raise NotImplementedError
