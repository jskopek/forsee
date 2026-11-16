"""Global shortcuts (recalibrate, quick refine, validate, pause). Owner: Core.
Uses pynput on macOS (installed only there); a no-op elsewhere.

Never fails: when pynput is missing, the platform is not macOS, a shortcut string is invalid, or
macOS has not granted Input Monitoring, :attr:`HotkeyListener.status` says so and
:attr:`HotkeyListener.available` is false. The UI shows that status.
"""

from __future__ import annotations

import logging
import sys
from collections.abc import Callable
from typing import Any

from ..config import HotkeysConfig

log = logging.getLogger(__name__)

ACTIONS = ("recalibrate", "quick_refine", "validate", "pause")

PERMISSION_HELP = (
    "Global shortcuts need Input Monitoring: open System Settings > Privacy & Security > Input "
    "Monitoring and turn on the app that started Python (Terminal, iTerm or your editor)."
)


class HotkeyListener:
    def __init__(self, config: HotkeysConfig, actions: dict[str, Callable[[], None]], keyboard_module: Any = None) -> None:
        """``actions`` maps ``"recalibrate"``, ``"quick_refine"``, ``"validate"``, ``"pause"``
        to callables. Callbacks run on pynput's thread; marshal to the event loop.

        ``keyboard_module`` replaces ``pynput.keyboard`` (tests)."""
        self.config = config
        self.actions = actions
        self._keyboard = keyboard_module
        self._listener: Any = None
        self.available = False
        self.status = "not started"
        self.bindings: dict[str, str] = {}

    def start(self) -> None:
        if not self.config.enabled:
            self.status = "off"
            return
        kb = self._keyboard
        if kb is None:
            if sys.platform != "darwin":
                self.status = "unavailable: global shortcuts are only supported on macOS"
                return
            try:
                from pynput import keyboard as kb  # type: ignore[no-redef]
            except Exception as exc:  # noqa: BLE001 - ImportError, or pynput failing to load its backend
                self.status = f"unavailable: pynput could not be loaded ({exc})"
                return
        mapping: dict[str, Callable[[], None]] = {}
        for action in ACTIONS:
            combo = str(getattr(self.config, action, "") or "").strip()
            fn = self.actions.get(action)
            if not combo or fn is None:
                continue
            try:
                kb.HotKey.parse(combo)
            except Exception as exc:  # noqa: BLE001
                log.warning("ignoring shortcut %s=%r: %s", action, combo, exc)
                continue
            mapping[combo] = self._wrap(action, fn)
            self.bindings[action] = combo
        if not mapping:
            self.status = "unavailable: no valid shortcuts configured"
            return
        try:
            self._listener = kb.GlobalHotKeys(mapping)
            self._listener.daemon = True
            self._listener.start()
        except Exception as exc:  # noqa: BLE001
            self._listener = None
            self.status = f"unavailable: {exc}"
            return
        trusted = getattr(self._listener, "IS_TRUSTED", True)
        if trusted is False:
            self.status = "no permission: " + PERMISSION_HELP
            log.warning(PERMISSION_HELP)
        else:
            self.status = "ok"
        self.available = True

    def _wrap(self, action: str, fn: Callable[[], None]) -> Callable[[], None]:
        def run() -> None:
            try:
                fn()
            except Exception:  # noqa: BLE001
                log.exception("shortcut %s failed", action)

        return run

    def stop(self) -> None:
        if self._listener is not None:
            try:
                self._listener.stop()
            except Exception:  # noqa: BLE001
                pass
            self._listener = None
        self.available = False
        if self.status == "ok":
            self.status = "stopped"
