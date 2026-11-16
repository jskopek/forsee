"""The simulated phone: a synthetic face and eyes with known gaze, served over the same wire
protocol as the iPhone app. Owner: Simulator.

Modules:

- ``person.py``: the synthetic person (head, eyeballs with cornea and kappa, saccades, pursuit,
  fixational drift, blinks, head-motion scripts).
- ``render.py``: analytic ray-cast renderer (exact limbus and corneal reflections).
- ``scene.py``: ``SimScene`` (person, screen, cameras, orientation and gravity; captures frames
  with their ground truth; renders any sensor rectangle).
- ``arkit.py``: the ``arkit`` header block in the app's exact layout, with noise and bias.
- ``server.py``: ``SimPhone`` (aiohttp server with the phone routes in docs/PROTOCOL.md plus
  the ``/sim/...`` control routes) and :func:`run_sim`.
- ``eyecrop.py``: :func:`render_eye_crop`, one eye crop with exact truth for vision tests.
- ``oracle.py``: ``OracleEstimator``, an estimator that reads the truth (for testing models).

Run it alone with ``python -m phonegaze.sim --mode camera|arkit --port 8081``.

Imported by: ``pipeline.py`` (``--sim``), tests (``SimPhone`` on a free port).
"""

from __future__ import annotations
