"""The simulated phone: a synthetic face and eyes with known gaze, served over the same wire
protocol as the iPhone app. Owner: Simulator.

Modules:

- ``scene.py``: ``SimScene`` (person, head pose, eyes, screen and phone geometry; renders
  sensor images; knows the true gaze point).
- ``server.py``: ``SimPhone`` (aiohttp server with the phone routes in docs/PROTOCOL.md plus
  the simulator routes) and :func:`run_sim`.

Imported by: ``__main__.py`` (``--sim``), tests (``SimPhone`` on a free port).
"""

from __future__ import annotations
