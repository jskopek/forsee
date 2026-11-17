"""Reading tuning settings live. Owner: Vision.

Estimators keep a reference to ``config.estimators`` (or ``None`` in unit tests) and read their
tuning settings through :func:`opt` on every frame, so a change in the Experiments page applies at
the next frame without rebuilding them (and without losing their state).
"""

from __future__ import annotations

from typing import Any


def opt(config: Any, name: str, default: Any) -> Any:
    """``config.<name>``, or ``default`` when there is no config or no such setting."""
    if config is None:
        return default
    v = getattr(config, name, default)
    return default if v is None else v
