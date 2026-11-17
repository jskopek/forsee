"""The lab on RENDERED synthetic video (real estimators, HEVC .mov through ffmpeg). Owner: Lab.

Slow: the simulator renders about 30 frames. Still synthetic: no real footage has been through
the lab.
"""

from __future__ import annotations

import shutil
import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).parent))

from lab_synth import make_session  # noqa: E402

from phonegaze import lab as L  # noqa: E402
from phonegaze.config import Config  # noqa: E402

pytestmark = [pytest.mark.slow, pytest.mark.skipif(shutil.which("ffmpeg") is None, reason="needs ffmpeg")]


def test_rendered_session_real_estimators(tmp_path: Path) -> None:
    pytest.importorskip("mediapipe")
    from phonegaze.download import model_path

    if not model_path("face_landmarker.task").exists():
        pytest.skip("face landmarker model not downloaded")
    session = make_session(tmp_path / "rendered", render=True, grid="3x3", pursuit_s=2.0)
    cfg = Config()
    cfg.lab.output_dir = str(tmp_path / "out")
    cfg.lab.every = 1
    cfg.lab.combos = ["landmarks+iris_edge", "sim_oracle"]
    res = L.run_lab(L.open_source(session), cfg, images=True)
    cam = res["cameras"]["back-wide-2x"]
    rot = cam["frames"]["rotation"]
    # Detection by face finding agrees with gravity (the simulator's sensor is upside down).
    assert rot["rotation"] == 180 and rot["agrees_with_gravity"] is True
    assert cam["frames"]["located"] >= 0.9 * cam["frames"]["frames"]
    real = cam["combos"]["landmarks+iris_edge"]
    f = real["failures"]
    assert f["face_not_found"] <= 0.1 * f["frames"] and f["iris_edge_failed"] <= 0.2 * f["frames"]
    assert real["chosen"] is not None
    # Loose: vision on 1280-pixel synthetic video is a few degrees (see the lab report).
    assert real["models"][real["chosen"]]["loo_deg"] < 8.0
    oracle = cam["combos"]["sim_oracle"]
    assert oracle["models"][oracle["chosen"]]["loo_deg"] < 0.5
    images = list((Path(res["output_dir"]) / "eye-images").rglob("*.png"))
    assert images, "--images should write annotated eye crops into the output folder only"
    paths = L.write_reports(res, Path(res["output_dir"]))
    assert "Upright rotation 180" in paths["md"].read_text()
