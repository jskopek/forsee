"""Regenerate the PGZ1 test vector: ``python tests/make_vector.py``.

Writes ``tests/data/pgz1_vector.bin`` (three messages back to back: hello, frame, status) and
``tests/data/pgz1_vector.json`` (the expected decode: each header, and each part as hex).
Then run ``npx -y prettier@3.10.1 --write tests/data/pgz1_vector.json`` (repository CI checks
formatting). Python's encoder must reproduce the .bin byte for byte from the JSON. Other encoders
(Swift's JSONSerialization writes ``1000`` for ``1000.0`` and may order keys differently) only
need to DECODE the .bin to the same headers and parts, and produce messages this decoder accepts.
"""

from __future__ import annotations

import json
from pathlib import Path

from phonegaze.protocol import encode

DATA = Path(__file__).resolve().parent / "data"

IDENTITY = [1.0, 0.0, 0.0, 0.0, 0.0, 1.0, 0.0, 0.0, 0.0, 0.0, 1.0, 0.0, 0.0, 0.0, 0.0, 1.0]
FACE = [1.0, 0.0, 0.0, 0.0, 0.0, 1.0, 0.0, 0.0, 0.0, 0.0, 1.0, 0.0, 0.01, -0.02, -0.55, 1.0]


def messages() -> list[tuple[dict, list[bytes]]]:
    hello = {
        "type": "hello",
        "protocol": 1,
        "t": 1000.0,
        "app": {"name": "EyeCapture", "version": "0.2"},
        "device": {"model": "iPhone16,2", "system": "iOS 18.1"},
        "capabilities": {
            "arkit": True,
            "depth": False,
            "roiSources": ["mac", "arkit"],
            "formats": ["jpeg", "gray8"],
            "maxRois": 4,
        },
        "streamConfig": {
            "maxFps": 30,
            "wide": {"enabled": True, "width": 4, "quality": 0.6, "every": 1},
            "rois": [{"name": "left_eye", "x": 0.5, "y": 0.25, "w": 0.25, "h": 0.5}],
            "roiQuality": 0.9,
            "roiSource": "mac",
            "roiSize": {"w": 0.1, "h": 0.06},
            "arkit": True,
            "depth": False,
        },
    }
    wide = bytes(range(8))  # 4 x 2 gray8
    roi = bytes([200, 201, 202, 203])  # 2 x 2 gray8
    frame = {
        "type": "frame",
        "seq": 42,
        "t": 1000.5,
        "tSent": 1000.512,
        "mode": "arkit",
        "dropped": 0,
        "camera": {
            "id": "arkit-face",
            "position": "front",
            "type": "arkit",
            "zoom": 1.0,
            "width": 8,
            "height": 4,
            "fx": 8.0,
            "fy": 8.0,
            "cx": 4.0,
            "cy": 2.0,
            "intrinsicsSource": "arkit",
            "intrinsicsIncludeZoom": True,
            "fieldOfView": 53.13,
        },
        "lens": {
            "position": 0.5,
            "adjustingFocus": False,
            "adjustingExposure": False,
            "iso": 100.0,
            "exposureS": 0.008,
            "focusLocked": False,
        },
        "gravity": [0.0, -1.0, 0.0],
        "rotationRate": [0.0, 0.0, 0.0],
        "parts": [
            {
                "name": "wide",
                "kind": "wide",
                "format": "gray8",
                "width": 4,
                "height": 2,
                "rect": [0, 0, 8, 4],
            },
            {
                "name": "left_eye",
                "kind": "roi",
                "format": "gray8",
                "width": 2,
                "height": 2,
                "rect": [4, 1, 2, 2],
            },
        ],
        "arkit": {
            "tracked": True,
            "face": FACE,
            "leftEye": IDENTITY,
            "rightEye": IDENTITY,
            "camera": IDENTITY,
            "lookAt": [0.0, 0.0, 1.0],
            "blendShapes": {"blink_left": 0.1, "blink_right": 0.2},
            "eyePixels": {"left": [5.0, 2.0], "right": [3.0, 2.0]},
        },
    }
    status = {
        "type": "status",
        "t": 1001.0,
        "state": {"mode": "arkit", "cameraId": "arkit-face", "measuredFps": 29.9},
        "stream": {"clients": 1, "sent": 42, "dropped": 3},
    }
    return [(hello, []), (frame, [wide, roi]), (status, [])]


def main() -> None:
    DATA.mkdir(exist_ok=True)
    blob = b""
    expected = []
    for header, parts in messages():
        blob += encode(header, parts)
        # The header as encoded (parts gain "bytes").
        encoded = encode(header, parts)
        hlen = int.from_bytes(encoded[4:8], "big")
        expected.append(
            {"header": json.loads(encoded[8 : 8 + hlen]), "parts": [p.hex() for p in parts]}
        )
    (DATA / "pgz1_vector.bin").write_bytes(blob)
    (DATA / "pgz1_vector.json").write_text(json.dumps(expected, indent=2) + "\n")
    print(f"wrote {len(blob)} bytes, {len(expected)} messages")


if __name__ == "__main__":
    main()
