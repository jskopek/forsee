"""Global shortcuts (recalibrate, quick refine, validate, pause). Owner: Core.
Uses pynput on macOS (installed only there); a no-op elsewhere."""

from __future__ import annotations

from collections.abc import Callable

from ..config import HotkeysConfig


class HotkeyListener:
    def __init__(self, config: HotkeysConfig, actions: dict[str, Callable[[], None]]) -> None:
        """``actions`` maps ``"recalibrate"``, ``"quick_refine"``, ``"validate"``, ``"pause"``
        to callables. Callbacks run on pynput's thread; marshal to the event loop."""
        self.config = config
        self.actions = actions

    def start(self) -> None:
        raise NotImplementedError

    def stop(self) -> None:
        raise NotImplementedError
