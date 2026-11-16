"""Phone-pose solve: where the phone camera is relative to the webcam, from the same head seen
by both.

Per paired frame, ``webcam_from_phone = webcam_from_head @ inverse(phone_from_head)``. Single
frames are poor (the webcam's head rotation is off by a few degrees and its distance by a few
centimetres, and one degree of rotation error moves the solved phone by about a centimetre at
60 cm), so the solve averages robustly over a window:

- ``poses``: Huber mean of the per-frame rotations; then, with that rotation fixed, the Huber
  mean of ``t_webcam - R @ t_phone`` (so per-frame rotation noise does not leak into the
  translation through the 60 cm lever arm).
- ``points``: robust rigid alignment (Kabsch) of the eye and head positions from both cameras
  over the window. Needs the head to have moved in three dimensions; ignores head rotations.
- ``hybrid``: ``points`` once the positions spread at least :data:`POINT_SPREAD_M` in every
  direction, ``poses`` before that.

Segments: a move of the phone (gyro, gravity, or recent frames that disagree with the anchored
pose) ends the current segment and starts a new, empty one: the pose is re-solved from frames
after the move only. Every segment keeps its last estimate, so changes can be applied to
observations (``track_phone``).
"""

from __future__ import annotations

import math
from collections import deque
from dataclasses import dataclass, field
from typing import Any

import numpy as np

from .geometry import DEG, Pose, kabsch, robust_kabsch, robust_rotation_mean, robust_sd, robust_vector_mean

POINT_SPREAD_M = 0.012
"""``hybrid``: standard deviation of the paired positions needed along every axis before the
point alignment is trusted."""

MOVING_HOLD_S = 0.4
"""After the gyro last saw motion, frames are ignored for this long (the phone settles)."""

VISION_MOVE_T_M = 0.03
VISION_MOVE_R_DEG = 4.0
VISION_WINDOW_S = 1.5
ANCHOR_MAX_SE_DEG = 10.0
ANCHOR_MAX_SE_M = 0.1
CORRELATION_S = 0.5
"""Per-frame errors are correlated over about this long; the uncertainty counts one
independent sample per this many seconds."""


@dataclass
class Pair:
    t: float
    pose: Pose  # per-frame webcam_from_phone
    phone_pts: np.ndarray  # 3 x 3: left eye, right eye, head (phone camera coordinates)
    webcam_pts: np.ndarray  # same points in webcam coordinates
    phone_head: Pose
    webcam_head: Pose


@dataclass
class Estimate:
    pose: Pose  # webcam_from_phone
    n: int
    duration_s: float
    sd_rot_deg: float
    sd_t_m: float
    se_rot_deg: float
    se_t_m: float
    method: str
    t: float

    def to_dict(self) -> dict[str, Any]:
        return {
            "webcam_from_phone": self.pose.to_dict(),
            "n": self.n,
            "duration_s": self.duration_s,
            "sd_rot_deg": self.sd_rot_deg,
            "sd_t_m": self.sd_t_m,
            "se_rot_deg": self.se_rot_deg,
            "se_t_m": self.se_t_m,
            "method": self.method,
        }


@dataclass
class Segment:
    id: int
    started: float
    reason: str
    pairs: deque = field(default_factory=deque)
    estimate: Estimate | None = None
    anchored_at: float | None = None
    first_pair_at: float | None = None
    gravity: np.ndarray | None = None
    gravity_n: int = 0
    rejected: int = 0


class PhonePoseSolver:
    def __init__(self, method: str = "poses", window_s: float = 20.0, min_pairs: int = 20, move_rotation_dps: float = 6.0, move_gravity_deg: float = 1.5, move_vision: bool = True, solve_every: int = 3) -> None:
        self.method = method
        self.window_s = window_s
        self.min_pairs = min_pairs
        self.move_rotation_dps = move_rotation_dps
        self.move_gravity_deg = move_gravity_deg
        self.move_vision = move_vision
        self.solve_every = max(1, solve_every)
        self.segments: dict[int, Segment] = {}
        self.current = self._new_segment(0.0, "start")
        self.last_motion: float | None = None
        self.moves = 0
        self.last_move: dict[str, Any] | None = None
        self._recent_dev: deque = deque()
        self._since_solve = 0

    # -- segments --------------------------------------------------------------------------------

    def _new_segment(self, t: float, reason: str) -> Segment:
        sid = max(self.segments, default=-1) + 1
        seg = Segment(sid, t, reason)
        self.segments[sid] = seg
        # keep only a few old segments (their estimates are what track_phone needs)
        for old in sorted(self.segments)[:-8]:
            if old != sid:
                del self.segments[old]
        return seg

    def moved(self, t: float, reason: str) -> None:
        """The phone moved: start a new segment (the pose is re-solved from what follows)."""
        self.moves += 1
        self.last_move = {"t": t, "reason": reason, "from_segment": self.current.id}
        self.current = self._new_segment(t, reason)
        self._recent_dev.clear()

    def reset(self, t: float = 0.0) -> None:
        self.segments.clear()
        self.current = self._new_segment(t, "reset")
        self._recent_dev.clear()

    @property
    def estimate(self) -> Estimate | None:
        return self.current.estimate

    def anchored(self) -> bool:
        """Enough paired frames, and an uncertainty that means something (the point alignment
        of a head that has not moved is degenerate)."""
        e = self.current.estimate
        return e is not None and e.n >= self.min_pairs and e.se_rot_deg < ANCHOR_MAX_SE_DEG and e.se_t_m < ANCHOR_MAX_SE_M

    def usable(self, segment: Segment | None = None, min_n: int = 5) -> bool:
        """Good enough to use (fewer frames than anchoring needs: right after a move the fresh
        estimate beats the stale one)."""
        e = (segment or self.current).estimate
        return e is not None and e.n >= min_n and e.se_rot_deg < ANCHOR_MAX_SE_DEG and e.se_t_m < ANCHOR_MAX_SE_M

    def moving(self, t: float) -> bool:
        return self.last_motion is not None and t - self.last_motion < MOVING_HOLD_S

    # -- inputs -----------------------------------------------------------------------------------

    def imu(self, t: float, gravity: Any, rotation_rate: Any) -> bool:
        """Phone gravity (any units) and rotation rate (rad/s) from a frame header. Returns True
        when this frame started a move."""
        started = False
        if rotation_rate is not None:
            w = float(np.linalg.norm(np.asarray(rotation_rate, float))) / DEG
            if w > self.move_rotation_dps:
                if not self.moving(t):
                    self.moved(t, f"phone rotating ({w:.0f} deg/s)")
                    started = True
                self.last_motion = t
        if gravity is not None and not self.moving(t):
            g = np.asarray(gravity, float)
            n = float(np.linalg.norm(g))
            if n > 0.5:
                g = g / n
                seg = self.current
                if seg.gravity is None or seg.gravity_n < 10:
                    acc = g if seg.gravity is None else seg.gravity * seg.gravity_n + g
                    seg.gravity_n += 1
                    seg.gravity = acc / np.linalg.norm(acc)
                else:
                    ang = math.degrees(math.acos(max(-1.0, min(1.0, float(g @ seg.gravity)))))
                    if ang > self.move_gravity_deg:
                        self.moved(t, f"phone tilted by {ang:.1f} deg")
                        started = True
        return started

    def add(self, t: float, phone_head: Pose, webcam_head: Pose, phone_pts: np.ndarray, webcam_pts: np.ndarray) -> None:
        """One paired frame (both head poses at the same instant, camera_from_head)."""
        if self.moving(t):
            self.current.rejected += 1
            return
        per = webcam_head @ phone_head.inverse()
        pair = Pair(t, per, np.asarray(phone_pts, float), np.asarray(webcam_pts, float), phone_head, webcam_head)
        seg = self.current
        if self.move_vision and self.anchored() and self._vision_move(t, pair):
            seg = self.current  # a new segment was started
        if seg.first_pair_at is None:
            seg.first_pair_at = t
        seg.pairs.append(pair)
        while seg.pairs and seg.pairs[0].t < t - self.window_s:
            seg.pairs.popleft()
        self._since_solve += 1
        if seg.estimate is None or len(seg.pairs) < self.min_pairs or self._since_solve >= self.solve_every:
            self._since_solve = 0
            seg.estimate = self.solve(list(seg.pairs))
            if seg.anchored_at is None and self.anchored():
                seg.anchored_at = t

    def _vision_move(self, t: float, pair: Pair) -> bool:
        est = self.current.estimate
        assert est is not None
        r = est.pose.R
        dev_t = (pair.webcam_head.t - r @ pair.phone_head.t) - est.pose.t
        dev_r = (pair.pose.R @ r.T)
        from scipy.spatial.transform import Rotation

        rv = Rotation.from_matrix(dev_r).as_rotvec()
        self._recent_dev.append((t, dev_t, rv))
        while self._recent_dev and self._recent_dev[0][0] < t - VISION_WINDOW_S:
            self._recent_dev.popleft()
        if len(self._recent_dev) < 12:
            return False
        mt = np.median(np.array([d[1] for d in self._recent_dev]), axis=0)
        mr = np.median(np.array([d[2] for d in self._recent_dev]), axis=0)
        if np.linalg.norm(mt) > max(VISION_MOVE_T_M, 4 * est.se_t_m) or np.linalg.norm(mr) / DEG > max(VISION_MOVE_R_DEG, 4 * est.se_rot_deg):
            self.moved(t, f"the cameras disagree with the anchored pose ({np.linalg.norm(mt) * 100:.1f} cm, {np.linalg.norm(mr) / DEG:.1f} deg)")
            return True
        return False

    # -- solving ----------------------------------------------------------------------------------

    def solve(self, pairs: list[Pair]) -> Estimate | None:
        if len(pairs) < 3:
            return None
        method = self.method
        if method == "hybrid":
            pts = np.concatenate([p.phone_pts for p in pairs])
            spread = np.linalg.svd(pts - pts.mean(axis=0), compute_uv=False) / math.sqrt(len(pts))
            method = "points" if spread[-1] >= POINT_SPREAD_M else "poses"
        duration = pairs[-1].t - pairs[0].t
        n_eff = max(1.0, min(len(pairs), duration / CORRELATION_S))
        if method == "points":
            src = np.concatenate([p.phone_pts for p in pairs])
            dst = np.concatenate([p.webcam_pts for p in pairs])
            pose, res = robust_kabsch(src, dst)
            if not np.all(np.isfinite(pose.R)):
                pose = kabsch(src, dst)
            rots = np.stack([p.pose.R for p in pairs])
            from scipy.spatial.transform import Rotation

            rot_res = np.linalg.norm(Rotation.from_matrix(np.einsum("ji,njk->nik", pose.R, rots)).as_rotvec(), axis=1) / DEG
            sd_t = robust_sd(res)
            sd_r = robust_sd(rot_res)
            # rotation from points: error ~ position noise / spread
            spread = np.linalg.svd(src - src.mean(axis=0), compute_uv=False) / math.sqrt(len(src))
            se_r = math.degrees(sd_t / max(float(spread[-1]), 1e-3)) / math.sqrt(n_eff)
            return Estimate(pose, len(pairs), duration, sd_r, sd_t, se_r, sd_t / math.sqrt(n_eff), "points", pairs[-1].t)
        rots = np.stack([p.pose.R for p in pairs])
        r_mean, r_res = robust_rotation_mean(rots)
        ts = np.stack([p.webcam_head.t - r_mean @ p.phone_head.t for p in pairs])
        t_mean, t_res = robust_vector_mean(ts)
        sd_r, sd_t = robust_sd(r_res), robust_sd(t_res)
        se_r = sd_r / math.sqrt(n_eff)
        # a rotation error also moves the translation by about (distance x angle)
        lever = float(np.median([np.linalg.norm(p.phone_head.t) for p in pairs]))
        se_t = math.hypot(sd_t / math.sqrt(n_eff), lever * se_r * DEG)
        return Estimate(Pose(r_mean, t_mean), len(pairs), duration, sd_r, sd_t, se_r, se_t, "poses", pairs[-1].t)

    # -- for the UI ------------------------------------------------------------------------------

    def status(self, t: float) -> str:
        if self.moving(t):
            return "moving"
        seg = self.current
        if self.anchored():
            return "anchored"
        if self.moves and seg.reason != "start":
            return "re-anchoring"
        return "anchoring" if seg.pairs else "waiting"

    def describe(self, t: float) -> dict[str, Any]:
        seg = self.current
        e = seg.estimate
        return {
            "status": self.status(t),
            "segment": seg.id,
            "pairs": len(seg.pairs),
            "rejected_while_moving": seg.rejected,
            "estimate": e.to_dict() if e else None,
            "anchored": self.anchored(),
            "time_to_anchor_s": (seg.anchored_at - seg.first_pair_at) if seg.anchored_at is not None and seg.first_pair_at is not None else None,
            "moves": self.moves,
            "last_move": self.last_move,
            "method": self.method,
        }
