"""PGZ1 framing. Owner: Foundation."""

from __future__ import annotations

import io
import json
import struct
from pathlib import Path

import pytest

from phonegaze.protocol import (
    MAGIC,
    Decoder,
    Message,
    ProtocolError,
    decode_all,
    encode,
    read_messages,
    write_messages,
)
from phonegaze.types import Frame

DATA = Path(__file__).resolve().parent / "data"


def vector() -> tuple[bytes, list[dict]]:
    return (DATA / "pgz1_vector.bin").read_bytes(), json.loads(
        (DATA / "pgz1_vector.json").read_text()
    )


def test_encode_layout() -> None:
    raw = encode({"type": "frame", "parts": [{"name": "a"}]}, [b"xyz"])
    assert raw[:4] == MAGIC
    (hlen,) = struct.unpack(">I", raw[4:8])
    header = json.loads(raw[8 : 8 + hlen])
    assert header["parts"][0]["bytes"] == 3
    assert raw[8 + hlen :] == b"xyz"


def test_encode_rejects_mismatched_parts() -> None:
    with pytest.raises(ProtocolError):
        encode({"type": "frame", "parts": []}, [b"x"])
    with pytest.raises(ProtocolError):
        encode({"no": "type"})
    with pytest.raises(ValueError):
        encode({"type": "status", "x": float("nan")})


def test_message_without_parts_has_no_parts_key() -> None:
    raw = encode({"type": "status", "t": 1.5})
    (msg,) = decode_all(raw)
    assert msg.header == {"type": "status", "t": 1.5}
    assert msg.parts == []


def test_vector_decodes_to_expected() -> None:
    blob, expected = vector()
    msgs = decode_all(blob)
    assert [m.header for m in msgs] == [e["header"] for e in expected]
    assert [[p.hex() for p in m.parts] for m in msgs] == [e["parts"] for e in expected]
    assert [m.type for m in msgs] == ["hello", "frame", "status"]


def test_vector_reencodes_byte_for_byte() -> None:
    blob, expected = vector()
    again = b"".join(encode(e["header"], [bytes.fromhex(p) for p in e["parts"]]) for e in expected)
    assert again == blob


@pytest.mark.parametrize("chunk", [1, 2, 3, 7, 64, 100000])
def test_incremental_any_chunking(chunk: int) -> None:
    blob, expected = vector()
    blob = blob * 3
    d = Decoder()
    msgs: list[Message] = []
    for i in range(0, len(blob), chunk):
        msgs += d.feed(blob[i : i + chunk])
    assert len(msgs) == 9
    assert d.buffered == 0
    assert msgs[4].header == expected[1]["header"]


def test_bad_magic_raises_early() -> None:
    with pytest.raises(ProtocolError):
        Decoder().feed(b"PGZ2")
    with pytest.raises(ProtocolError):
        Decoder().feed(b"X")


def test_bad_header_raises() -> None:
    bad = MAGIC + struct.pack(">I", 3) + b"[1]"
    with pytest.raises(ProtocolError):
        Decoder().feed(bad)
    bad = MAGIC + struct.pack(">I", 2) + b"{x"
    with pytest.raises(ProtocolError):
        Decoder().feed(bad)
    huge = MAGIC + struct.pack(">I", 1 << 30)
    with pytest.raises(ProtocolError):
        Decoder().feed(huge)


def test_trailing_bytes() -> None:
    blob, _ = vector()
    with pytest.raises(ProtocolError):
        decode_all(blob[:-1])


def test_file_helpers_round_trip() -> None:
    blob, _ = vector()
    msgs = decode_all(blob)
    buf = io.BytesIO()
    write_messages(buf, msgs)
    assert buf.getvalue() == blob
    buf.seek(0)
    assert [m.header for m in read_messages(buf, chunk_size=5)] == [m.header for m in msgs]
    # A truncated recording yields the complete messages only.
    assert len(list(read_messages(io.BytesIO(blob[:-3])))) == 2


def test_vector_frame_builds_frame() -> None:
    blob, _ = vector()
    frame = Frame.from_message(decode_all(blob)[1], t_received=5.0)
    assert frame.seq == 42 and frame.mode == "arkit"
    assert frame.camera.intrinsics is not None and frame.camera.intrinsics.fx == 8.0
    assert frame.part("left_eye") is not None
    assert frame.arkit is not None and frame.arkit.tracked
    # Column-major on the wire: translation lands in the last column.
    assert frame.arkit.face is not None
    assert frame.arkit.face[:3, 3].tolist() == pytest.approx([0.01, -0.02, -0.55])
    assert frame.arkit.eye_pixels["left"] == (5.0, 2.0)
