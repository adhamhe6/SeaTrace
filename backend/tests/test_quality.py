import math
from datetime import UTC, datetime, timedelta

import pytest
from app.domain.enums import Quality
from app.domain.quality import FlatlineDetector, classify, quality_from_status

T = datetime(2026, 1, 1, tzinfo=UTC)


@pytest.mark.parametrize(
    ("status", "expected"),
    [
        (None, Quality.GOOD),
        (0, Quality.GOOD),
        (0x80300000, Quality.BAD),
        (0x80000000, Quality.BAD),
        (0x40950000, Quality.UNCERTAIN),
        (0x00960000, Quality.GOOD),
    ],
)
def test_status_code_severity_mapping(status, expected):
    assert quality_from_status(status) is expected


@pytest.mark.parametrize(
    ("raw", "status", "quality", "value"),
    [
        (50.0, 0, Quality.GOOD, 50.0),
        (50, 0, Quality.GOOD, 50.0),
        (-1.0, 0, Quality.INVALID, -1.0),
        (1e6, 0, Quality.INVALID, 1e6),
        (math.nan, 0, Quality.INVALID, None),
        (math.inf, 0, Quality.INVALID, None),
        ("12", 0, Quality.INVALID, None),
        (True, 0, Quality.INVALID, None),
        (None, 0, Quality.INVALID, None),
        (50.0, 0x80300000, Quality.BAD, None),
        (50.0, 0x40950000, Quality.UNCERTAIN, 50.0),
    ],
)
def test_classify(raw, status, quality, value):
    c = classify(raw, status, 0.0, 100.0)
    assert (c.quality, c.value) == (quality, value)
    if quality is not Quality.GOOD:
        assert c.value != 0.0 or raw == 0.0  # invalid data is never coerced to zero


def test_flatline_requires_repeat_count():
    d = FlatlineDetector(5, timedelta(0))
    flags = [d.observe(1, 7.0, T + timedelta(seconds=i)) for i in range(7)]
    assert flags == [False, False, False, False, True, True, True]


def test_flatline_resets_on_change_and_on_missing_value():
    d = FlatlineDetector(3, timedelta(0))
    assert [d.observe(1, v, T) for v in (1.0, 1.0, 2.0, 2.0, 2.0)] == [
        False,
        False,
        False,
        False,
        True,
    ]
    assert d.observe(1, None, T) is False
    assert d.observe(1, 2.0, T) is False


def test_flatline_sensors_are_independent_and_duration_is_respected():
    d = FlatlineDetector(2, timedelta(seconds=10))
    assert d.observe(1, 5.0, T) is False
    assert d.observe(1, 5.0, T + timedelta(seconds=5)) is False  # enough samples, not long enough
    assert d.observe(1, 5.0, T + timedelta(seconds=11)) is True
    assert d.observe(2, 5.0, T) is False
