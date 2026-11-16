"""Reflection-based gaze model (PCCR-style). Owner: Models.

``ReflectionModel`` (registry ``reflection``): a second-order polynomial, fitted by ridge with
leave-one-dot-out regularisation, from the vector between the iris centre and the screen's
corneal reflection, divided by the iris radius (research note 02, "what to build" 3-4). Both
are measured in the same image, so the feature is a ratio: zoom- and distance-invariant to first
order. With ``head=True`` (default) linear head-pose terms are added.

The feature moves only about a third as much as the raw iris position per degree (note 02), so
the model needs the 2x crop and good reflection detection. It refuses to fit when fewer than
half the calibration samples have a reflection, and predicts nothing when neither eye has one.
"""

from __future__ import annotations

from typing import Any

from .regression import RidgeModel


class ReflectionModel(RidgeModel):
    name = "reflection"
    eye_groups = ("reflection",)
    min_fraction = 0.5

    def __init__(self, degree: int = 2, head: bool = True, **options: Any) -> None:
        super().__init__(degree=degree, head=head, **options)
