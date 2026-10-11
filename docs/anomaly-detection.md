# Experimental anomaly detection

> **Status: experimental, explainable, simulator-calibrated.** This is a transparent statistical heuristic. It is not
> a validated predictor of real-world equipment failure and must not be used for operational decisions.

It lives beside – never inside – the alarm engine: `backend/app/domain/anomaly.py` (pure functions),
`app/services/anomaly_service.py` (reads stored telemetry), endpoints `GET /api/v1/anomalies[/{vessel}]`.
Alarms stay the authoritative safety-relevant mechanism; the anomaly score is advisory context.

## Idea

A *combination* of a statistically significant vibration rise **and** a sustained temperature climb on the main
engine is a classic early signature of e.g. bearing wear or degrading cooling – even while both readings are still
inside their alarm limits.

## Features and score

Computed from stored, usable (`good`/`uncertain`) samples only:

| Feature | Definition |
|---|---|
| `vibration_z` | `(mean(last 45 s) − median(reference)) / σ_ref`, reference = the 300 s before the recent window, `σ_ref = max(1.4826·MAD, 2 % of the median)` (robust to outliers) |
| `temp_slope_c_per_min` | OLS slope of temperature over the last 120 s |
| `temp_slope_t` | slope ÷ its standard error – a slope below `t = 3` is treated as noise and ignored |

`v = clamp(vibration_z / 6)`, `t = clamp(slope / 0.8 °C·min⁻¹)`, **score = (v + t) / 2** – so one signal alone can
never exceed 0.5.

| Status | Rule |
|---|---|
| `anomaly` | both features exceed their *watch* level (`z ≥ 3`, slope ≥ 0.3 °C/min) **and** score ≥ 0.6 |
| `watch` | exactly one feature exceeds its watch level |
| `normal` | otherwise |
| `insufficient_data` | fewer than 60 reference / 15 recent / 40 temperature samples (e.g. right after start-up or after a data gap) – reported, never guessed |
| `not_applicable` | engine is stopped, starting or tripped |

The API returns the score, status, a human-readable `explanation`, all feature values and whether a
vibration/temperature alarm is already active. The vessel page shows these verbatim.

## Assumptions and limitations

* Calibrated on the *simulator's* signals (≈ 1 Hz; nominal vibration 2–4 mm/s, σ ≈ 0.16 mm/s). Constants are illustrative.
* Assumes roughly steady load; load transients move both signals legitimately and may produce false `watch` states.
* Needs ~2 minutes of stored data after start-up before it reports anything but `insufficient_data`.
* Evaluated on demand from PostgreSQL (≈ 700 rows per vessel); not persisted and no history of scores is kept.
* No machine-learning model is used, so there is nothing to over-fit or retrain – and nothing that proves real-world validity.

## Tests and measured behaviour

* `backend/tests/test_anomaly.py` – deterministic synthetic labelled scenarios: normal operation → `normal`; combined
  drift **below** both alarm thresholds → `anomaly`; vibration-only step → `watch` (score ≤ 0.5); temperature-only ramp →
  `watch`; very noisy temperature without trend → `normal`; short history → `insufficient_data`; exact OLS slope; configurable thresholds.
* `backend/tests/test_api_core.py::test_anomaly_*` – the same through the API with data stored via the real ingestion pipeline.
* Measured against the live C++ simulator (scenario `engine_vibration` on VES-001, 1 Hz): scenario activated at
  19:19:56; the assessment was `watch` 10 s later, **`anomaly` 20 s after activation (vibration 3.7 mm/s, still far below the 7.1 mm/s
  limit; no alarm active)**; the `ME_VIB_HIGH` alarm was raised 43 s after activation. Order of magnitude of lead time: tens of seconds
  in simulation – this says nothing about real machinery.
