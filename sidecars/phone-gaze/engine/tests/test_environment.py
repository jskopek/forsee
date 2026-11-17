"""The heavy dependencies install and work on this platform. Owner: Foundation."""

from __future__ import annotations

import numpy as np
import pytest

from phonegaze.download import model_path


def test_opencv_jpeg_round_trip() -> None:
    import cv2

    img = np.zeros((16, 16, 3), np.uint8)
    img[4:8, 4:8] = 255
    ok, buf = cv2.imencode(".jpg", img)
    assert ok
    assert cv2.imdecode(buf, cv2.IMREAD_COLOR).shape == (16, 16, 3)


def test_onnxruntime_imports() -> None:
    import onnxruntime

    assert "CPUExecutionProvider" in onnxruntime.get_available_providers()


def test_mediapipe_face_landmarker_loads() -> None:
    path = model_path("face_landmarker.task")
    if not path.exists():
        pytest.skip("run: python -m phonegaze.download")
    import mediapipe as mp
    from mediapipe.tasks.python import BaseOptions, vision

    options = vision.FaceLandmarkerOptions(
        base_options=BaseOptions(model_asset_path=str(path)),
        running_mode=vision.RunningMode.IMAGE,
        num_faces=1,
    )
    with vision.FaceLandmarker.create_from_options(options) as landmarker:
        blank = mp.Image(image_format=mp.ImageFormat.SRGB, data=np.zeros((64, 64, 3), np.uint8))
        assert landmarker.detect(blank).face_landmarks == []
