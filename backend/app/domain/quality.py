"""Measurement validation and data-quality classification (pure functions + small stateful detector).

Invalid data is *never* coerced into a "normal" value: bad/invalid readings are stored with their
quality flag (value NULL for non-finite or Bad-status readings) so history stays truthful.
"""

from __future__ import annotations

import math
from dataclasses import dataclass
from datetime import datetime, timedelta

from app.domain.enums import Quality

# OPC UA status code severity lives in the two most significant bits.
_SEVERITY_MASK = 0xC0000000
_SEVERITY_BAD = 0x80000000
_SEVERITY_UNCERTAIN = 0x40000000


@dataclass(frozen=True, slots=True)
class Classified:
    value: float | None
    quality: Quality
    reason: str | None = None


def quality_from_status(status_code: int | None) -> Quality:
    if status_code is None:
        return Quality.GOOD
    sev = status_code & _SEVERITY_MASK
    if sev == _SEVERITY_BAD:
        return Quality.BAD
    if sev == _SEVERITY_UNCERTAIN:
        return Quality.UNCERTAIN
    return Quality.GOOD


def classify(
    raw_value: object, status_code: int | None, plausible_min: float, plausible_max: float
) -> Classified:
    """Classify one raw reading. ``raw_value`` is whatever the source delivered."""
    quality = quality_from_status(status_code)
    if quality is Quality.BAD:
        return Classified(None, Quality.BAD, f"bad status code 0x{status_code or 0:08X}")
    if isinstance(raw_value, bool) or not isinstance(raw_value, int | float):
        return Classified(
            None, Quality.INVALID, f"non-numeric value of type {type(raw_value).__name__}"
        )
    value = float(raw_value)
    if not math.isfinite(value):
        return Classified(None, Quality.INVALID, "non-finite value")
    if value < plausible_min or value > plausible_max:
        return Classified(
            value,
            Quality.INVALID,
            f"value {value:g} outside plausible range [{plausible_min:g}, {plausible_max:g}]",
        )
    return Classified(value, quality)


class FlatlineDetector:
    """Detects a sensor that keeps reporting an identical value while its timestamps advance.

    Samples are only flagged from the moment the run reaches ``min_samples`` *and* ``min_duration``;
    earlier samples of the run remain 'good' (we only know in hindsight that they were part of a flat line).
    """

    def __init__(self, min_samples: int, min_duration: timedelta) -> None:
        self._min_samples = min_samples
        self._min_duration = min_duration
        self._run: dict[int, tuple[float, int, datetime]] = {}  # sensor -> (value, count, started)

    def observe(self, sensor_id: int, value: float | None, ts: datetime) -> bool:
        """Return True if this sample is part of a confirmed flat line."""
        if value is None:
            self._run.pop(sensor_id, None)
            return False
        prev = self._run.get(sensor_id)
        if prev is None or prev[0] != value:
            self._run[sensor_id] = (value, 1, ts)
            return False
        count = prev[1] + 1
        self._run[sensor_id] = (value, count, prev[2])
        return count >= self._min_samples and (ts - prev[2]) >= self._min_duration

    def reset(self, sensor_id: int) -> None:
        self._run.pop(sensor_id, None)
