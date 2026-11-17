"""Every module in the package imports (stubs included). Owner: Foundation."""

from __future__ import annotations

import importlib
import pkgutil

import phonegaze
from phonegaze.download import MODELS, model_path


def test_all_modules_import() -> None:
    names = [m.name for m in pkgutil.walk_packages(phonegaze.__path__, "phonegaze.")]
    assert "phonegaze.types" in names and "phonegaze.vision.arkit" in names
    for name in names:
        importlib.import_module(name)


def test_model_registry() -> None:
    assert "face_landmarker.task" in MODELS
    assert model_path("face_landmarker.task").name == "face_landmarker.task"
