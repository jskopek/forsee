"""The browser UI: static files served by ``server.py`` at ``/``. Owner: UI.

Everything in this folder except this file is a static asset (HTML, CSS, JavaScript; no build
step, no CDN, works offline). The entry point is ``index.html``. The API it talks to is in
docs/INTERFACES.md.
"""

from pathlib import Path

STATIC_DIR = Path(__file__).resolve().parent
