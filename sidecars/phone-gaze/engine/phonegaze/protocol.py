"""PGZ1 stream framing: encoder and incremental decoder. Owner: Foundation.

The exact wire format is in ``sidecars/phone-gaze/docs/PROTOCOL.md``. In short, a stream is a
sequence of messages, each::

    b"PGZ1"                       4 bytes, ASCII magic
    header_length                 4 bytes, unsigned big-endian
    header                        header_length bytes, UTF-8 JSON object
    part 0, part 1, ...           raw bytes; lengths are header["parts"][i]["bytes"]

A header always has ``"type"`` (``"hello"``, ``"frame"``, ``"status"``; decoders pass unknown
types through and callers ignore them). ``"parts"`` is optional; when absent the message has no
binary payload.

Used by: Core (``phone.py`` reads the stream, ``recorder.py``/``replay.py`` store it), Simulator
(``sim/`` writes it). Both sides must round-trip ``tests/data/pgz1_vector.bin``.
"""

from __future__ import annotations

import json
import struct
from collections.abc import Iterable, Iterator, Sequence
from dataclasses import dataclass, field
from typing import IO, Any

MAGIC = b"PGZ1"
PREFIX_BYTES = 8
MAX_HEADER_BYTES = 1 << 20  # 1 MiB
MAX_PART_BYTES = 64 << 20  # 64 MiB
CONTENT_TYPE = "application/x-pgz1"


class ProtocolError(ValueError):
    """The byte stream is not valid PGZ1. The stream cannot be resynchronised; reconnect."""


@dataclass
class Message:
    """One decoded message: the JSON header and the binary parts in header order."""

    header: dict[str, Any]
    parts: list[bytes] = field(default_factory=list)

    @property
    def type(self) -> str:
        return str(self.header.get("type", ""))

    def part(self, name: str) -> bytes | None:
        for desc, data in zip(self.header.get("parts", []), self.parts):
            if desc.get("name") == name:
                return data
        return None


def encode(header: dict[str, Any], parts: Sequence[bytes] = ()) -> bytes:
    """Encode one message.

    ``header["parts"]`` must have one descriptor per part, in order. Each descriptor's
    ``"bytes"`` is set (overwritten) from the actual part length, so callers may leave it out.
    If ``parts`` is empty and the header has no ``"parts"``, none is added.
    The header is serialised compactly with keys in insertion order (no sorting), UTF-8,
    no NaN (``allow_nan=False``; use ``null``).
    """
    if "type" not in header:
        raise ProtocolError("header needs a 'type'")
    descs = header.get("parts")
    if parts or descs is not None:
        descs = list(descs or [])
        if len(descs) != len(parts):
            raise ProtocolError(f"{len(parts)} parts but {len(descs)} descriptors")
        new_descs = []
        for desc, data in zip(descs, parts):
            d = dict(desc)
            d["bytes"] = len(data)
            new_descs.append(d)
        header = {**header, "parts": new_descs}
    raw = json.dumps(header, separators=(",", ":"), ensure_ascii=False, allow_nan=False).encode()
    if len(raw) > MAX_HEADER_BYTES:
        raise ProtocolError("header too large")
    return b"".join([MAGIC, struct.pack(">I", len(raw)), raw, *parts])


def _part_lengths(header: dict[str, Any]) -> list[int]:
    descs = header.get("parts") or []
    if not isinstance(descs, list):
        raise ProtocolError("'parts' must be a list")
    lengths = []
    for d in descs:
        try:
            n = int(d["bytes"])
        except (KeyError, TypeError, ValueError) as exc:
            raise ProtocolError("part descriptor without integer 'bytes'") from exc
        if n < 0 or n > MAX_PART_BYTES:
            raise ProtocolError(f"part length {n} out of range")
        lengths.append(n)
    return lengths


class Decoder:
    """Incremental decoder. Feed it bytes as they arrive; it returns whole messages.

    >>> d = Decoder()
    >>> msgs = d.feed(chunk)   # zero or more Message objects
    """

    def __init__(self) -> None:
        self._buf = bytearray()
        self._header: dict[str, Any] | None = None
        self._lengths: list[int] = []
        self._consumed = 0  # bytes of the current message already parsed (prefix + header)

    @property
    def buffered(self) -> int:
        """Bytes received but not yet returned as part of a message."""
        return len(self._buf)

    def feed(self, data: bytes | bytearray | memoryview) -> list[Message]:
        self._buf += data
        out: list[Message] = []
        while True:
            msg = self._next()
            if msg is None:
                return out
            out.append(msg)

    def _next(self) -> Message | None:
        buf = self._buf
        if self._header is None:
            if len(buf) < PREFIX_BYTES:
                if len(buf) and not MAGIC.startswith(bytes(buf[: len(MAGIC)])):
                    raise ProtocolError("bad magic")
                return None
            if bytes(buf[:4]) != MAGIC:
                raise ProtocolError(f"bad magic {bytes(buf[:4])!r}")
            (hlen,) = struct.unpack(">I", buf[4:8])
            if hlen > MAX_HEADER_BYTES:
                raise ProtocolError(f"header length {hlen} too large")
            if len(buf) < PREFIX_BYTES + hlen:
                return None
            try:
                header = json.loads(bytes(buf[PREFIX_BYTES : PREFIX_BYTES + hlen]).decode("utf-8"))
            except (UnicodeDecodeError, json.JSONDecodeError) as exc:
                raise ProtocolError(f"header is not JSON: {exc}") from exc
            if not isinstance(header, dict):
                raise ProtocolError("header is not a JSON object")
            self._lengths = _part_lengths(header)
            self._header = header
            self._consumed = PREFIX_BYTES + hlen
        total = self._consumed + sum(self._lengths)
        if len(buf) < total:
            return None
        parts = []
        pos = self._consumed
        for n in self._lengths:
            parts.append(bytes(buf[pos : pos + n]))
            pos += n
        header = self._header
        del buf[:total]
        self._header = None
        self._lengths = []
        self._consumed = 0
        return Message(header, parts)


def decode_all(data: bytes) -> list[Message]:
    """Decode a complete byte string. Raises ``ProtocolError`` if bytes are left over."""
    d = Decoder()
    msgs = d.feed(data)
    if d.buffered:
        raise ProtocolError(f"{d.buffered} trailing bytes")
    return msgs


def read_messages(stream: IO[bytes], chunk_size: int = 1 << 16) -> Iterator[Message]:
    """Iterate messages from a binary file object (a recording). A truncated final message
    (recording cut off) is dropped silently."""
    d = Decoder()
    while True:
        chunk = stream.read(chunk_size)
        if not chunk:
            return
        yield from d.feed(chunk)


def write_messages(stream: IO[bytes], messages: Iterable[Message]) -> None:
    for m in messages:
        stream.write(encode(m.header, m.parts))
