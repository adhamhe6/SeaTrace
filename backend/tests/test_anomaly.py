"""Anomaly scoring on synthetic labelled scenarios (deterministic, seeded)."""

import random
from datetime import UTC, datetime, timedelta

import pytest
from app.domain.anomaly import AnomalyConfig, Sample, assess, ols_slope_per_minute

NOW = datetime(2026, 1, 1, 12, 0, 0, tzinfo=UTC)
SECONDS = 600


def series(fn, seconds=SECONDS, seed=1):
    rnd = random.Random(seed)
    return [Sample(NOW - timedelta(seconds=seconds - i), fn(i, rnd)) for i in range(seconds + 1)]


def baseline_vib(i, r):
    return 3.0 + r.gauss(0, 0.15)


def baseline_temp(i, r):
    return 82.0 + r.gauss(0, 0.3)


def test_normal_operation_is_normal():
    res = assess(series(baseline_vib), series(baseline_temp), NOW)
    assert res.status == "normal" and res.score < 0.15
    assert "Normal" in res.explanation


def test_combined_drift_below_alarm_thresholds_is_flagged_as_anomaly():
    # vibration creeps to ~5.5 mm/s (alarm at 7.1) while temperature climbs ~1.2 degC/min to ~86 degC (alarm 95)
    def vib(i, r):
        return 3.0 + r.gauss(0, 0.15) + max(0, i - 450) * 0.017

    def temp(i, r):
        return 82.0 + r.gauss(0, 0.3) + max(0, i - 450) * 0.02

    v, t = series(vib), series(temp)
    assert max(s.value for s in v) < 7.1 and max(s.value for s in t) < 95
    res = assess(v, t, NOW)
    assert res.status == "anomaly" and res.score >= 0.6
    assert res.features["vibration_z"] >= 3 and res.features["temp_slope_c_per_min"] >= 0.3
    assert "Combined drift" in res.explanation


def test_vibration_only_shift_is_only_a_watch():
    def vib(i, r):
        return 3.0 + r.gauss(0, 0.15) + (2.5 if i > 500 else 0)

    res = assess(series(vib), series(baseline_temp), NOW)
    assert res.status == "watch" and res.score <= 0.5


def test_temperature_only_ramp_is_only_a_watch():
    def temp(i, r):
        return 82.0 + r.gauss(0, 0.3) + max(0, i - 400) * 0.03

    res = assess(series(baseline_vib), series(temp), NOW)
    assert res.status == "watch" and res.score <= 0.5


def test_noise_induced_slope_is_not_significant():
    def temp(i, r):
        return 82.0 + r.gauss(0, 2.0)  # very noisy, no trend

    res = assess(series(baseline_vib), series(temp), NOW)
    assert res.status == "normal"


def test_insufficient_data_is_reported_not_guessed():
    short = series(baseline_vib, seconds=20)
    res = assess(short, series(baseline_temp, seconds=20), NOW)
    assert (
        res.status == "insufficient_data" and res.score == 0.0 and "Not enough" in res.explanation
    )


def test_ols_slope_exact_for_linear_data():
    pts = [
        Sample(NOW + timedelta(seconds=i * 6), 10 + i * 0.1) for i in range(11)
    ]  # 0.1 per 6 s = 1/min
    slope, t = ols_slope_per_minute(pts)
    assert slope == pytest.approx(1.0) and t > 1e6


def test_config_thresholds_are_respected():
    def vib(i, r):
        return 3.0 + r.gauss(0, 0.15) + max(0, i - 450) * 0.017

    def temp(i, r):
        return 82.0 + r.gauss(0, 0.3) + max(0, i - 450) * 0.02

    strict = AnomalyConfig(vib_z_watch=50.0, vib_z_anomaly=100.0)
    assert assess(series(vib), series(temp), NOW, strict).status != "anomaly"
