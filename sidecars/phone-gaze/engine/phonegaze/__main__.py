"""Command line entry point: ``python -m phonegaze``. Owner: Core.

Arguments Core must support (others may be added)::

    --config PATH     config file (default: phonegaze.config.DEFAULT_PATH)
    --sim             start the simulated phone in-process and connect to it
    --phone URL       phone base URL (overrides phone.url)
    --port N          engine port (overrides server.port)
    --no-browser      do not open the UI
    --log-level LEVEL

Starts the aiohttp server from ``phonegaze.server`` and runs until Ctrl-C.
"""

from __future__ import annotations

import sys


def main(argv: list[str] | None = None) -> int:
    """Parse arguments, build the Engine, serve until interrupted. Returns the exit code."""
    raise NotImplementedError("Core: implement phonegaze.__main__.main")


if __name__ == "__main__":
    sys.exit(main())
