"""Shared types for every area of the engine. Owner: Foundation.

Other areas import from here and never redefine these. Types change only by ADDING fields with
defaults (never renaming, removing or changing a unit), so code written against an older version
keeps working. If you need a new field, add it at the end of the class with a default of ``None``
and say in its docstring which area fills it.

Conventions (see ARCHITECTURE.md and docs/INTERFACES.md):

- **Pixel coordinates are continuous.** Pixel ``(i, j)`` covers ``[i, i+1) x [j, j+1)``, so its
  centre is ``(i + 0.5, j + 0.5)`` and the image spans ``[0, width] x [0, height]``. OpenCV and
  numpy index results (integer = pixel centre) must have 0.5 added before being stored here.
  Origin top-left, x right, y down.
- **Sensor pixels** are pixels of the full buffer as the phone delivers it (landscape, never
  rotated, never mirrored). **Upright pixels** are pixels of that same full frame after Core has
  rotated it upright by a multiple of 90 degrees. Every pixel position in an ``Observation`` is in
  UPRIGHT FULL-FRAME pixels, whichever crop it was measured on.
- **Camera coordinates** are metres in the UPRIGHT camera frame: x right, y down, z forward (out of
  the lens, towards the user). They match the upright image: a point ``(X, Y, Z)`` projects to
  ``u = fx * X / Z + cx``, ``v = fy * Y / Z + cy`` with the upright intrinsics.
- **Rays** are ``((u - cx) / fx, (v - cy) / fy)`` with upright intrinsics: unitless tangents that
  survive zoom and lens changes. Use :meth:`Intrinsics.ray`.
- **Left and right** are the person's own eyes. In an unmirrored image of a person facing the
  camera, their left eye appears on the image's RIGHT.
- **Screen coordinates** are macOS points on the main display, origin top-left, x right, y down.
- **Time.** ``t`` is the phone clock in seconds (``CACurrentMediaTime``, seconds since the phone
  booted). ``t_local`` is the engine's ``time.monotonic()`` in seconds.
- **Missing values are ``None``, never 0 or NaN.** ``to_dict`` writes ``None`` as JSON ``null``.

Serialised dictionaries use snake_case keys (the phone wire format in PROTOCOL.md uses camelCase;
:meth:`Frame.from_message` is the only place that translates).
"""

from __future__ import annotations

import math
from dataclasses import asdict, dataclass, field, fields
from typing import TYPE_CHECKING, Any, Literal, Protocol, runtime_checkable

import numpy as np

if TYPE_CHECKING:  # pragma: no cover
    from .protocol import Message

Vec2 = tuple[float, float]
Vec3 = tuple[float, float, float]
Rect = tuple[float, float, float, float]
"""``(x, y, width, height)``: top-left corner and size, in the pixel space named where it is used."""

Rotation = Literal[0, 90, 180, 270]
"""Degrees CLOCKWISE the sensor image is turned to make it upright."""

IRIS_DIAMETER_MM = 11.7
"""Typical adult visible iris diameter, used to estimate distance from apparent iris size."""


# --------------------------------------------------------------------------------------------
# Small helpers
# --------------------------------------------------------------------------------------------


def _tuple(value: Any, n: int | None = None) -> tuple[float, ...] | None:
    if value is None:
        return None
    out = tuple(float(v) for v in value)
    if n is not None and len(out) != n:
        raise ValueError(f"expected {n} numbers, got {len(out)}")
    return out


def _jsonable(value: Any) -> Any:
    """Convert numpy values, tuples and dataclasses into plain JSON types. NaN becomes None."""
    if value is None or isinstance(value, (bool, str)):
        return value
    if isinstance(value, (int, np.integer)):
        return int(value)
    if isinstance(value, (float, np.floating)):
        f = float(value)
        return f if math.isfinite(f) else None
    if isinstance(value, np.ndarray):
        return _jsonable(value.tolist())
    if isinstance(value, dict):
        return {str(k): _jsonable(v) for k, v in value.items()}
    if isinstance(value, (list, tuple)):
        return [_jsonable(v) for v in value]
    if hasattr(value, "to_dict"):
        return value.to_dict()
    raise TypeError(f"cannot serialise {type(value).__name__}")


def _simple_from_dict(cls: type, data: dict[str, Any], tuples: dict[str, int | None] | None = None):
    """Build a flat dataclass from a dict, ignoring unknown keys (forward compatibility)."""
    tuples = tuples or {}
    kwargs: dict[str, Any] = {}
    for f in fields(cls):
        if f.name not in data:
            continue
        value = data[f.name]
        if f.name in tuples and value is not None:
            value = _tuple(value, tuples[f.name])
        kwargs[f.name] = value
    return cls(**kwargs)


# --------------------------------------------------------------------------------------------
# Camera and frames (from the phone)
# --------------------------------------------------------------------------------------------


@dataclass
class Intrinsics:
    """Pinhole intrinsics for one image size, in pixels (continuous convention).

    Attributes:
        fx, fy: focal lengths in pixels.
        cx, cy: principal point in pixels.
        width, height: image size in pixels these numbers refer to.
    """

    fx: float
    fy: float
    cx: float
    cy: float
    width: int
    height: int

    def ray(self, u: float, v: float) -> Vec2:
        """Direction through pixel ``(u, v)`` as ``((u - cx) / fx, (v - cy) / fy)``."""
        return ((u - self.cx) / self.fx, (v - self.cy) / self.fy)

    def pixel(self, rx: float, ry: float) -> Vec2:
        """Inverse of :meth:`ray`."""
        return (rx * self.fx + self.cx, ry * self.fy + self.cy)

    def project(self, point: Vec3) -> Vec2:
        """Project a camera-coordinate point (metres, z > 0) to pixels."""
        x, y, z = point
        return (self.fx * x / z + self.cx, self.fy * y / z + self.cy)

    def matrix(self) -> np.ndarray:
        """The 3x3 camera matrix K."""
        return np.array([[self.fx, 0, self.cx], [0, self.fy, self.cy], [0, 0, 1]], dtype=float)

    def rotated(self, rotation: Rotation) -> Intrinsics:
        """Intrinsics of the same camera after turning the image ``rotation`` degrees clockwise."""
        w, h = self.width, self.height
        if rotation == 0:
            return Intrinsics(self.fx, self.fy, self.cx, self.cy, w, h)
        if rotation == 90:
            return Intrinsics(self.fy, self.fx, h - self.cy, self.cx, h, w)
        if rotation == 180:
            return Intrinsics(self.fx, self.fy, w - self.cx, h - self.cy, w, h)
        if rotation == 270:
            return Intrinsics(self.fy, self.fx, self.cy, w - self.cx, h, w)
        raise ValueError(f"rotation must be 0, 90, 180 or 270, not {rotation}")

    @staticmethod
    def from_fov(width: int, height: int, hfov_deg: float, zoom: float = 1.0) -> Intrinsics:
        """Fallback when the phone sent no intrinsics: square pixels, centred principal point."""
        fx = (width / 2) / math.tan(math.radians(hfov_deg) / 2) * zoom
        return Intrinsics(fx, fx, width / 2, height / 2, width, height)

    def to_dict(self) -> dict[str, Any]:
        return _jsonable(asdict(self))

    @classmethod
    def from_dict(cls, data: dict[str, Any]) -> Intrinsics:
        return cls(
            float(data["fx"]),
            float(data["fy"]),
            float(data["cx"]),
            float(data["cy"]),
            int(data["width"]),
            int(data["height"]),
        )


@dataclass
class CameraInfo:
    """The camera that produced a frame, as described in the frame header (PROTOCOL.md).

    Attributes:
        id: AVFoundation ``uniqueID``, or ``"arkit-face"`` for ARKit mode, or ``"sim"``.
        position: ``"front"``, ``"back"`` or ``"unknown"``.
        type: ``"wide"``, ``"ultrawide"``, ``"tele"``, ``"arkit"`` or ``"sim"``.
        zoom: ``videoZoomFactor`` currently applied (1.0 = no zoom).
        width, height: SENSOR buffer size in pixels (landscape, as delivered).
        intrinsics: intrinsics of the delivered sensor buffer at the current zoom, in sensor
            pixels. Already adjusted for zoom; see :meth:`from_header` for how the wire fields
            are interpreted. ``None`` if neither the phone nor the field of view gave any.
        intrinsics_source: ``"attachment"`` (per-frame camera intrinsic matrix), ``"arkit"``
            (``ARCamera.intrinsics``), ``"fov"`` (computed from the field of view) or ``"sim"``.
        fov_deg: horizontal field of view of the format at zoom 1, in degrees, if known.
    """

    id: str
    position: str
    type: str
    zoom: float
    width: int
    height: int
    intrinsics: Intrinsics | None
    intrinsics_source: str = "fov"
    fov_deg: float | None = None

    @classmethod
    def from_header(cls, cam: dict[str, Any]) -> CameraInfo:
        """Build from a frame header's ``camera`` object (camelCase wire format).

        Zoom handling, decided once here: the wire ``fx fy cx cy`` are taken as given when
        ``intrinsicsIncludeZoom`` is true (ARKit, simulator). When it is false or missing, they
        describe the unzoomed sensor and are scaled about the image centre by ``zoom``.
        """
        width, height = int(cam["width"]), int(cam["height"])
        zoom = float(cam.get("zoom") or 1.0)
        fov = cam.get("fieldOfView")
        intr: Intrinsics | None = None
        source = str(cam.get("intrinsicsSource") or "fov")
        if all(cam.get(k) is not None for k in ("fx", "fy", "cx", "cy")):
            fx, fy, cx, cy = (float(cam[k]) for k in ("fx", "fy", "cx", "cy"))
            if not cam.get("intrinsicsIncludeZoom", False) and zoom != 1.0:
                fx, fy = fx * zoom, fy * zoom
                cx = width / 2 + (cx - width / 2) * zoom
                cy = height / 2 + (cy - height / 2) * zoom
            intr = Intrinsics(fx, fy, cx, cy, width, height)
        elif fov:
            intr = Intrinsics.from_fov(width, height, float(fov), zoom)
            source = "fov"
        return cls(
            id=str(cam.get("id", "")),
            position=str(cam.get("position", "unknown")),
            type=str(cam.get("type", "wide")),
            zoom=zoom,
            width=width,
            height=height,
            intrinsics=intr,
            intrinsics_source=source,
            fov_deg=float(fov) if fov else None,
        )

    def to_dict(self) -> dict[str, Any]:
        d = _jsonable({f.name: getattr(self, f.name) for f in fields(self) if f.name != "intrinsics"})
        d["intrinsics"] = self.intrinsics.to_dict() if self.intrinsics else None
        return d

    @classmethod
    def from_dict(cls, data: dict[str, Any]) -> CameraInfo:
        intr = data.get("intrinsics")
        return cls(
            id=data["id"],
            position=data["position"],
            type=data["type"],
            zoom=float(data["zoom"]),
            width=int(data["width"]),
            height=int(data["height"]),
            intrinsics=Intrinsics.from_dict(intr) if intr else None,
            intrinsics_source=data.get("intrinsics_source", "fov"),
            fov_deg=data.get("fov_deg"),
        )


@dataclass
class Part:
    """One binary part of a ``frame`` message (PROTOCOL.md, "Parts").

    Attributes:
        name: unique within the frame. ``"wide"`` for the downscaled whole frame; ROI names as
            requested (``"left_eye"``, ``"right_eye"`` for ARKit- or vision-placed ROIs);
            ``"depth"`` for a depth map.
        kind: ``"wide"``, ``"roi"`` or ``"depth"``.
        format: ``"jpeg"``, ``"gray8"`` (row-major uint8), ``"depth16"`` (row-major little-endian
            float16 metres) or ``"depth32"`` (float32 metres).
        width, height: pixel size of the encoded image.
        rect: ``(x, y, w, h)`` of the source region in SENSOR pixels. The part's pixels map
            linearly onto this rectangle: sensor_x = x + part_x * w / width.
        data: the encoded bytes.
    """

    name: str
    kind: str
    format: str
    width: int
    height: int
    rect: Rect
    data: bytes = b""

    def descriptor(self) -> dict[str, Any]:
        """The wire descriptor (without the payload) for a frame header's ``parts`` list."""
        return {
            "name": self.name,
            "kind": self.kind,
            "format": self.format,
            "bytes": len(self.data),
            "width": self.width,
            "height": self.height,
            "rect": [float(v) for v in self.rect],
        }


@dataclass
class LensState:
    """Lens and exposure state at capture. All optional; ``None`` when the phone did not say.

    Attributes:
        position: AVFoundation ``lensPosition``, 0 (near) to 1 (far), unitless.
        adjusting_focus, adjusting_exposure: autofocus / autoexposure still moving.
        iso: sensor ISO.
        exposure_s: exposure duration in seconds.
        focus_locked: focus locked by ``/api/focus``.
    """

    position: float | None = None
    adjusting_focus: bool | None = None
    adjusting_exposure: bool | None = None
    iso: float | None = None
    exposure_s: float | None = None
    focus_locked: bool | None = None

    @classmethod
    def from_header(cls, lens: dict[str, Any] | None) -> LensState:
        lens = lens or {}
        return cls(
            position=lens.get("position"),
            adjusting_focus=lens.get("adjustingFocus"),
            adjusting_exposure=lens.get("adjustingExposure"),
            iso=lens.get("iso"),
            exposure_s=lens.get("exposureS"),
            focus_locked=lens.get("focusLocked"),
        )


@dataclass
class ArkitData:
    """ARKit face tracking for one frame, exactly as the phone sent it (ARKit conventions).

    Matrices are 4x4 numpy arrays rebuilt from the wire's 16 column-major floats, so
    ``m[:3, 3]`` is the translation. Spaces (see PROTOCOL.md "ARKit"):

    - ``face``: face anchor -> ARKit world. Face space: origin behind the nose, +x towards the
      viewer's right (the person's LEFT), +y up, +z out of the face towards the camera.
    - ``left_eye`` / ``right_eye``: eye -> face space; each eye looks along its +z. ``left`` is
      the person's left eye (ARKit names them the same way).
    - ``camera``: ARKit camera -> ARKit world. ARKit camera space: +x along the sensor image's +u
      (landscape), +y up the image (-v), +z towards the viewer (the camera looks down -z).
    - ``look_at``: point in face space, metres. Only its direction is meaningful.

    The ARKit estimator converts to engine camera coordinates once:
    ``p_sensor_cam = diag(1, -1, -1) @ (inv(camera) @ face @ ...)[:3]``, then
    :attr:`DecodedFrame.sensor_to_upright_3d`.
    """

    tracked: bool
    face: np.ndarray | None = None
    left_eye: np.ndarray | None = None
    right_eye: np.ndarray | None = None
    camera: np.ndarray | None = None
    look_at: Vec3 | None = None
    blend_shapes: dict[str, float] = field(default_factory=dict)
    eye_pixels: dict[str, Vec2] = field(default_factory=dict)
    """Eye centres projected into SENSOR pixels, keyed ``"left"`` / ``"right"``."""

    @staticmethod
    def matrix(values: list[float] | None) -> np.ndarray | None:
        """16 column-major floats -> 4x4 array. ``None`` stays ``None``."""
        if values is None:
            return None
        arr = np.asarray(values, dtype=float)
        if arr.shape != (16,) or not np.all(np.isfinite(arr)):
            return None
        return arr.reshape(4, 4).T  # column-major on the wire

    @classmethod
    def from_header(cls, ar: dict[str, Any]) -> ArkitData:
        look = ar.get("lookAt")
        return cls(
            tracked=bool(ar.get("tracked", False)),
            face=cls.matrix(ar.get("face")),
            left_eye=cls.matrix(ar.get("leftEye")),
            right_eye=cls.matrix(ar.get("rightEye")),
            camera=cls.matrix(ar.get("camera")),
            look_at=_tuple(look, 3) if look else None,
            blend_shapes={k: float(v) for k, v in (ar.get("blendShapes") or {}).items()},
            eye_pixels={
                k: (float(v[0]), float(v[1])) for k, v in (ar.get("eyePixels") or {}).items()
            },
        )


@dataclass
class Frame:
    """One ``frame`` message from the phone (or simulator, or a recording), not yet decoded.

    Attributes:
        seq: frame counter from the phone, increasing; gaps mean dropped frames.
        t: capture time, phone clock, seconds.
        mode: ``"camera"`` (AVFoundation) or ``"arkit"``.
        camera: the camera and its sensor-pixel intrinsics.
        lens: focus and exposure state.
        gravity: gravity in the phone's portrait frame (x right, y up, z out of the screen), in g.
        rotation_rate: rotation rate in the same frame, rad/s.
        parts: binary parts in wire order.
        arkit: ARKit data in ARKit mode, else ``None``.
        t_received: engine ``time.monotonic()`` when the message was fully read; set by Core.
        header: the raw JSON header, for fields not modelled here (``sim``, ``depth``...).
    """

    seq: int
    t: float
    mode: str
    camera: CameraInfo
    lens: LensState
    gravity: Vec3 | None
    rotation_rate: Vec3 | None
    parts: list[Part]
    arkit: ArkitData | None = None
    t_received: float | None = None
    header: dict[str, Any] = field(default_factory=dict)

    def part(self, name: str) -> Part | None:
        for p in self.parts:
            if p.name == name:
                return p
        return None

    @classmethod
    def from_message(cls, message: Message, t_received: float | None = None) -> Frame:
        """Build from a decoded PGZ1 ``frame`` message (see :mod:`phonegaze.protocol`)."""
        h = message.header
        if h.get("type") != "frame":
            raise ValueError(f"not a frame message: {h.get('type')!r}")
        parts = []
        for desc, data in zip(h.get("parts", []), message.parts):
            parts.append(
                Part(
                    name=desc["name"],
                    kind=desc.get("kind", "roi"),
                    format=desc.get("format", "jpeg"),
                    width=int(desc["width"]),
                    height=int(desc["height"]),
                    rect=_tuple(desc["rect"], 4),  # type: ignore[arg-type]
                    data=data,
                )
            )
        grav = h.get("gravity")
        rot = h.get("rotationRate")
        return cls(
            seq=int(h["seq"]),
            t=float(h["t"]),
            mode=str(h.get("mode", "camera")),
            camera=CameraInfo.from_header(h["camera"]),
            lens=LensState.from_header(h.get("lens")),
            gravity=_tuple(grav, 3) if grav else None,  # type: ignore[arg-type]
            rotation_rate=_tuple(rot, 3) if rot else None,  # type: ignore[arg-type]
            parts=parts,
            arkit=ArkitData.from_header(h["arkit"]) if h.get("arkit") else None,
            t_received=t_received,
            header=h,
        )


# --------------------------------------------------------------------------------------------
# Upright decoding
# --------------------------------------------------------------------------------------------

# Sensor image axes expressed in the phone's portrait device frame (x right, y up, z out of the
# screen), for a phone whose camera delivers landscape buffers. Derived, not yet checked on a
# device: the back camera's buffer is upright when the phone is held landscape with its top to
# the LEFT (home button on the right); the front camera's buffer is unmirrored. If the owner's
# phone shows faces upside down, fix these two rows (or set stream.rotation in the config).
SENSOR_AXES_IN_DEVICE: dict[str, tuple[Vec3, Vec3]] = {
    # position: (image +u direction, image +v direction)
    "back": ((0.0, -1.0, 0.0), (-1.0, 0.0, 0.0)),
    "front": ((0.0, 1.0, 0.0), (-1.0, 0.0, 0.0)),
}


def upright_rotation(gravity: Vec3 | None, position: str) -> Rotation:
    """Clockwise rotation (0/90/180/270) that makes gravity point down the image.

    Pure function, no hysteresis: Core keeps the last value while the phone is near flat
    (``|g| projected on the image < 0.5 g``) or near a 45-degree boundary.
    Returns 0 when gravity is unknown.
    """
    if gravity is None:
        return 0
    u_axis, v_axis = SENSOR_AXES_IN_DEVICE.get(position, SENSOR_AXES_IN_DEVICE["back"])
    g = np.asarray(gravity, dtype=float)
    gu, gv = float(np.dot(g, u_axis)), float(np.dot(g, v_axis))
    best: Rotation = 0
    best_down = -math.inf
    for rot in (0, 90, 180, 270):
        down = rotate_vector2((gu, gv), rot)[1]  # type: ignore[arg-type]
        if down > best_down:
            best, best_down = rot, down  # type: ignore[assignment]
    return best


def rotate_vector2(vec: Vec2, rotation: Rotation) -> Vec2:
    """Rotate an image-space direction (x right, y down) clockwise by ``rotation`` degrees."""
    x, y = vec
    if rotation == 0:
        return (x, y)
    if rotation == 90:
        return (-y, x)
    if rotation == 180:
        return (-x, -y)
    if rotation == 270:
        return (y, -x)
    raise ValueError(rotation)


def rotation_affine(rotation: Rotation, width: float, height: float) -> np.ndarray:
    """3x3 homogeneous map from sensor pixels to upright pixels for a ``width x height`` image."""
    if rotation == 0:
        return np.eye(3)
    if rotation == 90:  # (x, y) -> (H - y, x)
        return np.array([[0, -1, height], [1, 0, 0], [0, 0, 1]], dtype=float)
    if rotation == 180:  # (x, y) -> (W - x, H - y)
        return np.array([[-1, 0, width], [0, -1, height], [0, 0, 1]], dtype=float)
    if rotation == 270:  # (x, y) -> (y, W - x)
        return np.array([[0, 1, 0], [-1, 0, width], [0, 0, 1]], dtype=float)
    raise ValueError(rotation)


def rotation_3d(rotation: Rotation) -> np.ndarray:
    """3x3 matrix taking SENSOR camera coordinates to UPRIGHT camera coordinates."""
    c = {0: (1, 0), 90: (0, 1), 180: (-1, 0), 270: (0, -1)}[rotation]
    cos, sin = c
    # Image-plane clockwise rotation with y down: (x, y) -> (x cos - y sin, x sin + y cos).
    return np.array([[cos, -sin, 0], [sin, cos, 0], [0, 0, 1]], dtype=float)


def apply_affine(m: np.ndarray, point: Vec2) -> Vec2:
    """Apply a 3x3 homogeneous affine map to one point."""
    x, y, _ = m @ np.array([point[0], point[1], 1.0])
    return (float(x), float(y))


@dataclass
class DecodedImage:
    """One part decoded to pixels and turned upright.

    Attributes:
        name, kind: copied from the :class:`Part`.
        pixels: ``uint8`` array, ``H x W x 3`` in BGR order (OpenCV convention), upright.
            Depth parts are ``float32`` ``H x W`` metres.
        to_full: 3x3 homogeneous affine from THIS image's pixels to UPRIGHT FULL-FRAME pixels.
            Includes the crop offset, the scale and the rotation.
        rect_full: the region this image covers, ``(x, y, w, h)`` in upright full-frame pixels.
    """

    name: str
    kind: str
    pixels: np.ndarray
    to_full: np.ndarray
    rect_full: Rect

    @property
    def gray(self) -> np.ndarray:
        """``uint8`` ``H x W`` luminance (computed on each access; cache it if you need it often)."""
        import cv2

        if self.pixels.ndim == 2:
            return self.pixels
        return cv2.cvtColor(self.pixels, cv2.COLOR_BGR2GRAY)

    @property
    def from_full(self) -> np.ndarray:
        """Inverse of :attr:`to_full`."""
        return np.linalg.inv(self.to_full)

    def point_to_full(self, point: Vec2) -> Vec2:
        return apply_affine(self.to_full, point)

    def point_from_full(self, point: Vec2) -> Vec2:
        return apply_affine(self.from_full, point)

    @property
    def scale(self) -> float:
        """Image pixels per full-frame pixel (1.0 for native-resolution crops)."""
        return float(1.0 / math.sqrt(abs(np.linalg.det(self.to_full[:2, :2]))))


@dataclass
class DecodedFrame:
    """What every estimator receives: upright images plus the geometry to go back to the sensor.

    Attributes:
        frame: the undecoded frame (header data: lens, gravity, ARKit, ``header['sim']``...).
        rotation: degrees clockwise applied to the sensor image.
        width, height: UPRIGHT full-frame size in pixels.
        intrinsics: UPRIGHT full-frame intrinsics (``None`` if unknown).
        images: decoded parts by name: ``"wide"`` (whole frame, downscaled) and ROIs.
        sensor_to_upright: 3x3 affine, sensor pixels -> upright full-frame pixels.
        sensor_to_upright_3d: 3x3 rotation, sensor camera coordinates -> upright camera
            coordinates (both x right, y down, z forward).
    """

    frame: Frame
    rotation: Rotation
    width: int
    height: int
    intrinsics: Intrinsics | None
    images: dict[str, DecodedImage]
    sensor_to_upright: np.ndarray
    sensor_to_upright_3d: np.ndarray

    @property
    def upright_to_sensor(self) -> np.ndarray:
        return np.linalg.inv(self.sensor_to_upright)

    @property
    def wide(self) -> DecodedImage | None:
        return self.images.get("wide")

    def rois(self) -> list[DecodedImage]:
        return [im for im in self.images.values() if im.kind == "roi"]

    def rect_to_sensor_normalized(self, rect_upright: Rect) -> Rect:
        """An upright full-frame rectangle -> the normalised SENSOR rectangle ``/api/stream/config``
        expects (0-1, top-left origin). Use it to place ROIs on the phone."""
        x, y, w, h = rect_upright
        corners = [(x, y), (x + w, y), (x, y + h), (x + w, y + h)]
        inv = self.upright_to_sensor
        pts = np.array([apply_affine(inv, c) for c in corners])
        sw, sh = self.frame.camera.width, self.frame.camera.height
        x0, y0 = pts.min(axis=0)
        x1, y1 = pts.max(axis=0)
        return (x0 / sw, y0 / sh, (x1 - x0) / sw, (y1 - y0) / sh)

    @classmethod
    def from_frame(cls, frame: Frame, rotation: Rotation | None = None) -> DecodedFrame:
        """Decode every image part and turn it upright.

        ``rotation=None`` uses :func:`upright_rotation` on the frame's gravity (no hysteresis;
        Core passes its own stable value). Unknown formats are skipped, not fatal.
        """
        import cv2

        if rotation is None:
            rotation = upright_rotation(frame.gravity, frame.camera.position)
        sw, sh = frame.camera.width, frame.camera.height
        s2u = rotation_affine(rotation, sw, sh)
        if rotation in (90, 270):
            uw, uh = sh, sw
        else:
            uw, uh = sw, sh
        intr = frame.camera.intrinsics.rotated(rotation) if frame.camera.intrinsics else None
        rot_code = {
            90: cv2.ROTATE_90_CLOCKWISE,
            180: cv2.ROTATE_180,
            270: cv2.ROTATE_90_COUNTERCLOCKWISE,
        }.get(rotation)

        images: dict[str, DecodedImage] = {}
        for part in frame.parts:
            pixels = _decode_part(part)
            if pixels is None:
                continue
            rx, ry, rw, rh = part.rect
            # part pixels -> sensor pixels
            p2s = np.array(
                [[rw / part.width, 0, rx], [0, rh / part.height, ry], [0, 0, 1]], dtype=float
            )
            # upright part pixels -> part pixels
            u2p = np.linalg.inv(rotation_affine(rotation, part.width, part.height))
            if rot_code is not None:
                pixels = cv2.rotate(pixels, rot_code)
            to_full = s2u @ p2s @ u2p
            corners = np.array(
                [apply_affine(s2u, c) for c in [(rx, ry), (rx + rw, ry + rh)]], dtype=float
            )
            x0, y0 = corners.min(axis=0)
            x1, y1 = corners.max(axis=0)
            images[part.name] = DecodedImage(
                name=part.name,
                kind=part.kind,
                pixels=pixels,
                to_full=to_full,
                rect_full=(float(x0), float(y0), float(x1 - x0), float(y1 - y0)),
            )
        return cls(
            frame=frame,
            rotation=rotation,
            width=uw,
            height=uh,
            intrinsics=intr,
            images=images,
            sensor_to_upright=s2u,
            sensor_to_upright_3d=rotation_3d(rotation),
        )


def _decode_part(part: Part) -> np.ndarray | None:
    import cv2

    if part.format == "jpeg":
        arr = cv2.imdecode(np.frombuffer(part.data, np.uint8), cv2.IMREAD_COLOR)
        return arr
    if part.format == "gray8":
        gray = np.frombuffer(part.data, np.uint8).reshape(part.height, part.width)
        return cv2.cvtColor(gray, cv2.COLOR_GRAY2BGR)
    if part.format == "depth16":
        return np.frombuffer(part.data, "<f2").reshape(part.height, part.width).astype(np.float32)
    if part.format == "depth32":
        return np.frombuffer(part.data, "<f4").reshape(part.height, part.width).copy()
    return None


# --------------------------------------------------------------------------------------------
# Observations (what estimators produce)
# --------------------------------------------------------------------------------------------


@dataclass
class EyeObs:
    """Everything measured about one eye in one frame. Every field optional (``None``).

    Pixel positions are UPRIGHT FULL-FRAME pixels; 3D values are metres in upright camera
    coordinates.

    Attributes:
        found: the eye was located at all.
        iris_center: iris centre, pixels.
        iris_radius: iris radius, pixels (mean of the ellipse's semi-axes when fitted).
        iris_ellipse: fitted limbus ellipse ``(cx, cy, semi_major, semi_minor, angle_deg)``,
            pixels; angle of the major axis from +x towards +y (clockwise on screen).
        iris_edge_sharpness: width of the limbus edge in pixels (smaller is sharper).
        pupil_center: pupil centre if separately resolved, pixels.
        reflection_center: centre of the screen's corneal reflection, pixels.
        reflection_corners: the reflection's four corners in pixels, ordered by the SCREEN
            corner they reflect: top-left, top-right, bottom-right, bottom-left.
        reflection_score: 0-1 confidence that the reflection is the screen.
        inner_corner, outer_corner: eye corners (towards the nose / towards the ear), pixels.
        openness: eyelid aperture height / eye corner distance, unitless (about 0.3 open, 0 shut).
        blink: the eye is closed or closing.
        eyeball_center: eyeball rotation centre, camera coordinates, metres.
        gaze_dir: unit gaze direction (optical or visual axis as the estimator states in
            ``Observation.extra``), camera coordinates.
        confidence: 0-1 estimator confidence in this eye's measurements.
        extra: estimator-specific JSON-serialisable values (floats, lists, strings).
    """

    found: bool = False
    iris_center: Vec2 | None = None
    iris_radius: float | None = None
    iris_ellipse: tuple[float, float, float, float, float] | None = None
    iris_edge_sharpness: float | None = None
    pupil_center: Vec2 | None = None
    reflection_center: Vec2 | None = None
    reflection_corners: list[Vec2] | None = None
    reflection_score: float | None = None
    inner_corner: Vec2 | None = None
    outer_corner: Vec2 | None = None
    openness: float | None = None
    blink: bool | None = None
    eyeball_center: Vec3 | None = None
    gaze_dir: Vec3 | None = None
    confidence: float | None = None
    extra: dict[str, Any] = field(default_factory=dict)

    # Class constant (no annotation, so not a dataclass field): tuple fields and their lengths.
    _TUPLES = {
        "iris_center": 2,
        "iris_ellipse": 5,
        "pupil_center": 2,
        "reflection_center": 2,
        "inner_corner": 2,
        "outer_corner": 2,
        "eyeball_center": 3,
        "gaze_dir": 3,
    }

    def to_dict(self) -> dict[str, Any]:
        return _jsonable({f.name: getattr(self, f.name) for f in fields(self)})

    @classmethod
    def from_dict(cls, data: dict[str, Any] | None) -> EyeObs:
        if not data:
            return cls()
        obj = _simple_from_dict(cls, data, cls._TUPLES)
        if obj.reflection_corners is not None:
            obj.reflection_corners = [_tuple(c, 2) for c in obj.reflection_corners]  # type: ignore[misc]
        obj.extra = dict(obj.extra or {})
        return obj



@dataclass
class Observation:
    """Everything the estimators measured in one frame. Missing values are ``None``.

    Estimator chain: Core builds one with :meth:`empty` per frame and passes it through every
    enabled estimator in configured order (``estimators.order``). Each estimator fills or
    overwrites fields and returns it (see :class:`Estimator`). Every field an estimator sets is
    recorded in ``provenance``.

    Attributes:
        seq, t: copied from the frame (phone clock).
        t_local: engine monotonic time the frame was received.
        camera_id, zoom: copied from the frame.
        intrinsics: UPRIGHT full-frame intrinsics used for every pixel value here.
        rotation: the upright rotation used.
        left, right: per-eye measurements (always present; ``found`` says if located).
        head_rotation: 3x3 rotation, head frame -> upright camera coordinates, as nested lists
            (row-major, ``np.array(head_rotation)`` works). Head frame: x from the person's right
            eye towards their left eye, y down the face (towards the chin), z from the face
            towards the back of the head. The identity therefore means "upright, facing the
            camera squarely"; the face points along the head frame's -z.
        head_position: head reference point, camera coordinates, metres (the point midway
            between the two eyeball centres when known, else the estimator's face origin).
        distance: metres from the camera to the point between the eyes.
        face_rect: face bounding box ``(x, y, w, h)`` in upright full-frame pixels.
        quality: image quality numbers, e.g. ``{"sharpness_left": ..., "brightness": ...}``.
        estimators: names of estimators that ran and returned something, in order.
        provenance: dotted field path -> estimator name, e.g. ``{"left.iris_center": "iris_edge"}``.
        extra: estimator-specific JSON-serialisable values, namespaced by estimator name:
            ``extra["arkit"] = {...}``.
    """

    seq: int
    t: float
    t_local: float | None = None
    camera_id: str = ""
    zoom: float = 1.0
    intrinsics: Intrinsics | None = None
    rotation: int = 0
    left: EyeObs = field(default_factory=EyeObs)
    right: EyeObs = field(default_factory=EyeObs)
    head_rotation: list[list[float]] | None = None
    head_position: Vec3 | None = None
    distance: float | None = None
    face_rect: Rect | None = None
    quality: dict[str, float] = field(default_factory=dict)
    estimators: list[str] = field(default_factory=list)
    provenance: dict[str, str] = field(default_factory=dict)
    extra: dict[str, Any] = field(default_factory=dict)

    @classmethod
    def empty(cls, frame: DecodedFrame) -> Observation:
        """A blank observation for ``frame``, ready to pass to the first estimator."""
        f = frame.frame
        return cls(
            seq=f.seq,
            t=f.t,
            t_local=f.t_received,
            camera_id=f.camera.id,
            zoom=f.camera.zoom,
            intrinsics=frame.intrinsics,
            rotation=frame.rotation,
        )

    def eye(self, side: str) -> EyeObs:
        """``"left"`` or ``"right"`` (the person's)."""
        if side not in ("left", "right"):
            raise ValueError(side)
        return self.left if side == "left" else self.right

    def set(self, path: str, value: Any, estimator: str) -> None:
        """Set a field by dotted path (``"left.iris_center"`` or ``"distance"``) and record who
        set it. Prefer this over plain assignment so provenance stays complete."""
        target: Any = self
        parts = path.split(".")
        for p in parts[:-1]:
            target = getattr(target, p)
        if not hasattr(target, parts[-1]):
            raise AttributeError(path)
        setattr(target, parts[-1], value)
        self.provenance[path] = estimator

    def to_dict(self) -> dict[str, Any]:
        d: dict[str, Any] = {}
        for f in fields(self):
            v = getattr(self, f.name)
            if f.name == "intrinsics":
                d[f.name] = v.to_dict() if v else None
            elif f.name in ("left", "right"):
                d[f.name] = v.to_dict()
            else:
                d[f.name] = _jsonable(v)
        return d

    @classmethod
    def from_dict(cls, data: dict[str, Any]) -> Observation:
        obj = _simple_from_dict(
            cls,
            {k: v for k, v in data.items() if k not in ("left", "right", "intrinsics")},
            {"head_position": 3, "face_rect": 4},
        )
        obj.left = EyeObs.from_dict(data.get("left"))
        obj.right = EyeObs.from_dict(data.get("right"))
        intr = data.get("intrinsics")
        obj.intrinsics = Intrinsics.from_dict(intr) if intr else None
        obj.quality = dict(obj.quality or {})
        obj.estimators = list(obj.estimators or [])
        obj.provenance = dict(obj.provenance or {})
        obj.extra = dict(obj.extra or {})
        return obj


# --------------------------------------------------------------------------------------------
# Screen, calibration and gaze
# --------------------------------------------------------------------------------------------


@dataclass
class ScreenInfo:
    """The display gaze is mapped onto (the Mac's main display).

    Attributes:
        width, height: size in macOS points (the units of screen coordinates).
        width_mm, height_mm: physical size of the visible area in millimetres, read from macOS
            (``CGDisplayScreenSize``). ``None`` only if macOS did not say; never asked of the user.
        scale: backing pixels per point (2.0 on Retina).
        name: display name, for the UI.
        source: ``"macos"``, ``"sim"`` (the simulator's screen) or ``"browser"`` (fallback).
    """

    width: float
    height: float
    width_mm: float | None = None
    height_mm: float | None = None
    scale: float = 1.0
    name: str = ""
    source: str = "macos"

    @property
    def mm_per_point(self) -> tuple[float, float] | None:
        if self.width_mm is None or self.height_mm is None:
            return None
        return (self.width_mm / self.width, self.height_mm / self.height)

    def to_mm(self, x: float, y: float) -> Vec2 | None:
        """Screen point -> millimetres from the top-left corner of the visible area."""
        mpp = self.mm_per_point
        return None if mpp is None else (x * mpp[0], y * mpp[1])

    def to_dict(self) -> dict[str, Any]:
        return _jsonable(asdict(self))

    @classmethod
    def from_dict(cls, data: dict[str, Any]) -> ScreenInfo:
        return _simple_from_dict(cls, data)


CalibKind = Literal["grid", "pursuit", "refine", "validate", "drift"]


@dataclass
class CalibSample:
    """One frame's observation paired with where the person was asked to look.

    Attributes:
        target: ``(x, y)`` screen points of the dot at the frame's time.
        obs: the observation (after the full estimator chain, before any model).
        kind: which calibration step produced it. ``"validate"`` samples are never used to fit.
        dot_id: groups samples of one dot (leave-one-dot-out uses it). Unique within a run;
            pursuit samples use one id per short time window.
        run_id: calibration run this belongs to.
        pose_group: head-position round (0 for the first, 1 for "move your head and repeat"...).
        t_local: engine monotonic time of the sample.
    """

    target: Vec2
    obs: Observation
    kind: str = "grid"
    dot_id: int = 0
    run_id: str = ""
    pose_group: int = 0
    t_local: float | None = None

    def to_dict(self) -> dict[str, Any]:
        return {
            "target": list(self.target),
            "obs": self.obs.to_dict(),
            "kind": self.kind,
            "dot_id": self.dot_id,
            "run_id": self.run_id,
            "pose_group": self.pose_group,
            "t_local": _jsonable(self.t_local),
        }

    @classmethod
    def from_dict(cls, data: dict[str, Any]) -> CalibSample:
        return cls(
            target=_tuple(data["target"], 2),  # type: ignore[arg-type]
            obs=Observation.from_dict(data["obs"]),
            kind=data.get("kind", "grid"),
            dot_id=int(data.get("dot_id", 0)),
            run_id=data.get("run_id", ""),
            pose_group=int(data.get("pose_group", 0)),
            t_local=data.get("t_local"),
        )


@dataclass
class GazePoint:
    """Where the person is looking, as a model or filter output. Also the WebSocket sample.

    Attributes:
        x, y: screen points (may fall outside the screen; consumers clamp).
        t: phone-clock time of the frame it came from, seconds.
        confidence: 0-1.
        valid: false during blinks, lost tracking, or when the model has nothing to say.
            Consumers must ignore ``x``/``y`` when false.
        model: name of the model that produced it (``"geometric"``, ``"ridge"``...).
        t_local: engine monotonic time when it was produced.
        left, right: per-eye estimates in screen points, when the model makes them.
        fixation: the filter's fixation state, if any (true while in a fixation).
        extra: model- or filter-specific JSON values.
    """

    x: float
    y: float
    t: float
    confidence: float = 1.0
    valid: bool = True
    model: str = ""
    t_local: float | None = None
    left: Vec2 | None = None
    right: Vec2 | None = None
    fixation: bool | None = None
    extra: dict[str, Any] = field(default_factory=dict)

    def to_dict(self) -> dict[str, Any]:
        return _jsonable(asdict(self))

    @classmethod
    def from_dict(cls, data: dict[str, Any]) -> GazePoint:
        return _simple_from_dict(cls, data, {"left": 2, "right": 2})


@dataclass
class FitReport:
    """The result of fitting one gaze model, shown in the UI and used to choose a model.

    Errors in degrees are visual angles at the eye (needs a distance; ``None`` if unknown).

    Attributes:
        model: model name.
        ok: the fit succeeded and the model can predict.
        n_samples, n_dots: amount of training data.
        train_error_deg, train_error_pt: mean error on the training samples.
        loo_error_deg, loo_error_pt: mean leave-one-dot-out error (the selection score).
        precision_deg: RMS sample-to-sample dispersion of predictions within a dot.
        per_dot: per-dot details, e.g. ``[{"dot_id": 3, "target": [x, y], "mean": [x, y],
            "error_deg": 1.2}]``.
        params: small JSON summary of fitted parameters, for display.
        message: human-readable note or failure reason.
        fit_seconds: wall time spent fitting.
    """

    model: str
    ok: bool
    n_samples: int = 0
    n_dots: int = 0
    train_error_deg: float | None = None
    train_error_pt: float | None = None
    loo_error_deg: float | None = None
    loo_error_pt: float | None = None
    precision_deg: float | None = None
    per_dot: list[dict[str, Any]] = field(default_factory=list)
    params: dict[str, Any] = field(default_factory=dict)
    message: str = ""
    fit_seconds: float | None = None

    def to_dict(self) -> dict[str, Any]:
        return _jsonable(asdict(self))

    @classmethod
    def from_dict(cls, data: dict[str, Any]) -> FitReport:
        return _simple_from_dict(cls, data)


# --------------------------------------------------------------------------------------------
# The central interfaces
# --------------------------------------------------------------------------------------------


@runtime_checkable
class Estimator(Protocol):
    """Turns a decoded frame into measurements. Owner of implementations: Vision.

    Chain semantics (decided here, Core implements them in ``pipeline.py``):

    1. Per frame, Core builds ``obs = Observation.empty(decoded)``.
    2. For each enabled estimator in ``config.estimators.order``:
       ``result = est.process(decoded, obs)``. If ``result`` is not ``None`` it becomes ``obs``
       and ``est.name`` is appended to ``obs.estimators``; ``None`` means "nothing to add" and
       ``obs`` is kept unchanged. An estimator may mutate ``previous`` in place and return it.
    3. An exception in one estimator is logged (rate-limited) and treated as ``None``.
    4. Later estimators may overwrite earlier values when they are more precise (iris edge
       refines the landmark iris centre). Set fields with :meth:`Observation.set` so
       ``provenance`` records who set what.
    5. ``previous`` is never ``None`` inside the pipeline; standalone callers (tests, replay)
       may pass ``None``, and the estimator then starts from ``Observation.empty(frame)``.

    Estimators keep their own state between frames (tracking, smoothing) and must clear it in
    :meth:`reset`. ``process`` runs on a worker thread, one frame at a time, in frame order;
    it should take under 15 ms at 30 fps.
    """

    name: str

    def process(self, frame: DecodedFrame, previous: Observation | None) -> Observation | None: ...

    def reset(self) -> None: ...


@runtime_checkable
class GazeModel(Protocol):
    """Maps an observation to a screen point. Owner of implementations: Models.

    ``fit`` uses only samples whose ``kind`` is not ``"validate"``. ``predict`` must be cheap
    (well under 1 ms) and return ``None`` (or a ``GazePoint`` with ``valid=False``) when the
    observation lacks what the model needs. ``to_dict`` must include ``{"type": <registry
    name>}`` so ``phonegaze.models.load_model`` can rebuild it.
    """

    name: str

    def fit(self, samples: list[CalibSample], screen: ScreenInfo) -> FitReport: ...

    def predict(self, obs: Observation) -> GazePoint | None: ...

    def to_dict(self) -> dict[str, Any]: ...


@runtime_checkable
class OutputSink(Protocol):
    """Somewhere filtered gaze goes: the system cursor, the Forsee WebSocket, dwell clicks.
    Owner of implementations: Core (``outputs/``).

    ``emit`` is called on the pipeline's event loop thread once per frame, after filtering,
    with ``point=None`` when there is no gaze. It must not block (queue internally if needed).
    ``close`` releases resources; it may be called more than once.
    """

    name: str

    def emit(self, point: GazePoint | None, obs: Observation | None) -> None: ...

    def close(self) -> None: ...
