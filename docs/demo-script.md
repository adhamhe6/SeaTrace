# Demonstration script (≈ 8 minutes)

Prerequisite: the stack is running (`docker compose up --build`, see README) and you are signed in at
<http://localhost:8080> as the **operator** (credentials: `.env`, or printed by `scripts/init-env.sh`).
A banner on every screen reminds the audience that all data is simulated.

## 1. Normal operation (1 min)
1. **Fleet overview** – two vessels, both *Normal / Online*; no open alarms. Point at the live "last data" age and the
   OPC UA chip in the top bar (connected, security: secure).
2. Open **MV Aurora Tide**. Four equipment panels (main engine, generator, cooling, bilge) with state pills and live
   readings: value, unit, quality, source timestamp, age and a small bar showing the value inside its nominal range.
   The values move every second – they arrive over OPC UA from the C++ simulator, through PostgreSQL, over the WebSocket.
3. (Optional) show the **Anomaly insight** panel: "normal".

## 2. Inject a fault (2 min)
1. **Simulator** page → scenario *Cooling pressure loss* → vessel **VES-001** → *Activate*. A toast confirms; the
   action is recorded in the audit table (who, what, result).
2. Back on the vessel page watch cooling pressure fall and – because the simulation couples subsystems – the engine
   temperature start to drift upward.
3. After ~20–40 s the **Anomaly insight** flips to *watch/anomaly* with an explanation, *before* any alarm limit is crossed
   (when you use *Engine vibration* instead, the combined vibration + temperature drift is flagged ~20 s before the vibration alarm).

## 3. Alarm → acknowledge (2 min)
1. The top-bar counters and the **Alarm center** show a new *warning* alarm "Low cooling pressure" and, later, the *critical* one.
   Each has severity icon + text, state *Active – unacknowledged* and "Condition: active".
2. Open the alarm: rule, threshold, trigger value and time, transition history (*raised*).
3. As **viewer** (second browser/private window) the *Acknowledge* button is disabled with an explanation, and a direct
   API call returns `403` – the check is on the server.
4. As operator: *Acknowledge* (add a note). State becomes *Active – acknowledged*; history shows **who** and **when**.
5. Back on **Simulator** → *Clear* the scenario (or *Reset all*). Pressure recovers; after the dwell time the condition
   clears and the alarm closes (*Cleared* because it had been acknowledged first). Repeat once without acknowledging to
   show *Cleared – unacknowledged*: the condition is gone but the alarm still needs an operator.

## 4. Investigate and replay (2 min)
1. From the alarm detail click **Replay incident**. The window opens around the alarm (5 min before/after).
2. Charts are synchronised small-multiples of the **stored** telemetry; vertical markers show *raised / acknowledged /
   cleared*; the state ribbon shows `RUNNING → DEGRADED`.
3. Press **Play** at 10×, drag the cursor, step with ←/→. The "State at cursor" panel shows the last stored sample at or before
   the cursor for every measurement – no interpolation – and which alarms were active.
4. Show a gap: activate *Telemetry interruption* for 20 s on one vessel, then replay that window – the hole is shaded and
   labelled instead of drawn as a continuous line.

## 5. Failure and recovery (1 min)
1. *OPC UA server outage* (20 s): the top bar flips to *reconnecting*, the live-channel banner may appear, communication-loss
   alarms are raised, then everything recovers by itself (one subscription, no duplicate rows).
2. `docker compose restart backend` – the UI reconnects, history and open alarms are intact.
3. `docker compose stop db` – the API answers `503`, readiness fails, the UI shows an error state; `docker compose start db` recovers.

## Talking points
* Why OPC UA / C++ / Python, how data quality is carried (status codes, `invalid`, `stuck`, `stale`).
* Alarm lifecycle: hysteresis, persistence, de-duplication, ack vs. clear.
* What is real in this repo (protocol, persistence, alarm logic, security checks) and what is simulated (everything physical).
