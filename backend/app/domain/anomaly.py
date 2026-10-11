"""Explainable anomaly detection for the main engine (optional feature, separate from the alarm engine).

Idea
    Neither vibration nor temperature has to cross its alarm threshold for a *combination* to be unusual:
    a statistically significant rise of engine vibration together with a sustained temperature climb is a
    classic early signature of e.g. bearing wear or degraded cooling.  We score exactly that combination.

Features (computed on stored, usable samples only)
    vibration_z   robust z-score of the recent mean against a reference window
                  ((recent_mean - ref_median) / (1.4826 * MAD_ref), sigma floored at 2 % of the median)
    temp_slope    ordinary-least-squares slope of temperature over the last ``slope_window_s`` in degC/min
    temp_slope_t  slope divided by its standard error (significance; guards against noise-induced slopes)

Scoring
    v = clamp(vibration_z / vib_z_anomaly), t = clamp(temp_slope / slope_anomaly)   (0 when not significant)
    score = (v + t) / 2.  One feature on its own can therefore reach at most 0.5.
    status: 'anomaly' if both features exceed their watch level and score >= 0.6;
            'watch'   if either feature exceeds its watch level;  else 'normal'.

Limitations (also in docs/anomaly-detection.md)
    * Calibrated on the *simulator's* signals (≈1 Hz, nominal vibration 2-4 mm/s); thresholds are illustrative.
    * Assumes the engine is running at roughly steady load; load changes shift both signals legitimately.
    * It is a transparent statistical heuristic, **not** a validated predictor of real-world equipment failure.
"""

from __future__ import annotations

import statistics
from dataclasses import dataclass, field
from datetime import datetime, timedelta
from typing import Literal

Status = Literal["insufficient_data", "normal", "watch", "anomaly"]


@dataclass(frozen=True, slots=True)
class AnomalyConfig:
    reference_s: float = 300.0
    recent_s: float = 45.0
    slope_window_s: float = 120.0
    min_reference_samples: int = 60
    min_recent_samples: int = 15
    min_slope_samples: int = 40
    vib_z_watch: float = 3.0
    vib_z_anomaly: float = 6.0
    slope_watch: float = 0.3  # degC per minute
    slope_anomaly: float = 0.8
    slope_min_t: float = 3.0
    sigma_floor_fraction: float = 0.02
    anomaly_score: float = 0.6


@dataclass(frozen=True, slots=True)
class Sample:
    ts: datetime
    value: float


@dataclass(slots=True)
class AnomalyResult:
    status: Status
    score: float
    explanation: str
    features: dict[str, float | None] = field(default_factory=dict)


def _clamp01(x: float) -> float:
    return max(0.0, min(1.0, x))


def robust_z(
    recent: list[float], reference: list[float], floor_fraction: float
) -> tuple[float, float, float]:
    """Return (z, reference_median, sigma)."""
    med = statistics.median(reference)
    mad = statistics.median(abs(v - med) for v in reference)
    sigma = max(1.4826 * mad, floor_fraction * abs(med), 1e-9)
    return (statistics.fmean(recent) - med) / sigma, med, sigma


def ols_slope_per_minute(points: list[Sample]) -> tuple[float, float]:
    """Slope in units/min and its t-statistic."""
    n = len(points)
    t0 = points[0].ts
    xs = [(p.ts - t0).total_seconds() / 60.0 for p in points]
    ys = [p.value for p in points]
    mx, my = statistics.fmean(xs), statistics.fmean(ys)
    sxx = sum((x - mx) ** 2 for x in xs)
    if sxx <= 0:
        return 0.0, 0.0
    slope = sum((x - mx) * (y - my) for x, y in zip(xs, ys, strict=True)) / sxx
    intercept = my - slope * mx
    ss_res = sum((y - (intercept + slope * x)) ** 2 for x, y in zip(xs, ys, strict=True))
    if n <= 2:
        return slope, 0.0
    se = (ss_res / (n - 2) / sxx) ** 0.5
    t = slope / se if se > 1e-12 else (float("inf") if slope != 0 else 0.0)
    return slope, t


def assess(
    vibration: list[Sample],
    temperature: list[Sample],
    now: datetime,
    cfg: AnomalyConfig = AnomalyConfig(),
) -> AnomalyResult:
    recent_from = now - timedelta(seconds=cfg.recent_s)
    ref_from = recent_from - timedelta(seconds=cfg.reference_s)
    ref = [s.value for s in vibration if ref_from <= s.ts < recent_from]
    rec = [s.value for s in vibration if recent_from <= s.ts <= now]
    slope_from = now - timedelta(seconds=cfg.slope_window_s)
    tpts = [s for s in temperature if slope_from <= s.ts <= now]
    if (
        len(ref) < cfg.min_reference_samples
        or len(rec) < cfg.min_recent_samples
        or len(tpts) < cfg.min_slope_samples
    ):
        return AnomalyResult(
            "insufficient_data",
            0.0,
            f"Not enough stored data yet (reference {len(ref)}/{cfg.min_reference_samples}, recent "
            f"{len(rec)}/{cfg.min_recent_samples}, temperature {len(tpts)}/{cfg.min_slope_samples} samples).",
            {
                "reference_samples": len(ref),
                "recent_samples": len(rec),
                "temperature_samples": len(tpts),
            },
        )

    z, ref_med, sigma = robust_z(rec, ref, cfg.sigma_floor_fraction)
    slope, slope_t = ols_slope_per_minute(tpts)
    significant_slope = slope if slope_t >= cfg.slope_min_t else 0.0

    v = _clamp01(z / cfg.vib_z_anomaly)
    t = _clamp01(significant_slope / cfg.slope_anomaly)
    score = round((v + t) / 2.0, 3)
    vib_hit, temp_hit = z >= cfg.vib_z_watch, significant_slope >= cfg.slope_watch
    if vib_hit and temp_hit and score >= cfg.anomaly_score:
        status: Status = "anomaly"
    elif vib_hit or temp_hit:
        status = "watch"
    else:
        status = "normal"

    vib_txt = (
        f"vibration {statistics.fmean(rec):.2f} mm/s is {z:+.1f} robust sigma from its "
        f"{cfg.reference_s:.0f}s baseline ({ref_med:.2f} mm/s)"
    )
    temp_txt = f"temperature is changing {slope:+.2f} degC/min (t={slope_t:.1f})"
    if status == "anomaly":
        why = f"Combined drift: {vib_txt} AND {temp_txt}; neither has to be in alarm yet."
    elif status == "watch":
        which = "vibration" if vib_hit else "temperature"
        why = f"Watch ({which} only): {vib_txt}; {temp_txt}."
    else:
        why = f"Normal: {vib_txt}; {temp_txt}."
    return AnomalyResult(
        status,
        score,
        why,
        {
            "vibration_z": round(z, 2),
            "vibration_recent_mean": round(statistics.fmean(rec), 3),
            "vibration_reference_median": round(ref_med, 3),
            "vibration_sigma": round(sigma, 4),
            "temp_slope_c_per_min": round(slope, 3),
            "temp_slope_t": round(slope_t, 2),
            "reference_samples": len(ref),
            "recent_samples": len(rec),
            "temperature_samples": len(tpts),
        },
    )
