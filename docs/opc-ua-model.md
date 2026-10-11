# SeaTrace OPC UA information model

> All values published by the simulator are **simulated**. Ranges are illustrative and are not
> authoritative operating limits of any real vessel or equipment.

* Endpoint: `opc.tcp://<host>:4840/seatrace/simulator` (config: `SIM_OPCUA_PORT`, default `4840`).
* Namespace URI: `urn:seatrace:simulator` (namespace index is assigned at runtime — clients must
  resolve it with `get_namespace_index`, never hard-code `2`).
* All NodeIds are **string** NodeIds inside that namespace. Identifier = dotted path, e.g.
  `ns=<n>;s=VES-001.ME1.Temperature`.
* Server is single-threaded (`UA_Server_run_iterate` loop). Simulation ticks (default 1 Hz, `SIM_TICK_MS`)
  and method callbacks execute on the same thread, so there is no shared-state race.

## Address space

```
Objects
└── SeaTrace                         (Object)           s=SeaTrace
    ├── Simulator                    (Object)           s=Simulator
    │   ├── Notice                   (String, RO)       "SIMULATED DATA - not a real vessel ..."
    │   ├── Seed                     (UInt32, RO)
    │   ├── Heartbeat                (UInt64, RO)       increments every tick, even during telemetry interruption
    │   ├── ActiveScenarios          (String, RO)       JSON array, see below
    │   ├── ActivateScenario         (Method)           s=Simulator.ActivateScenario
    │   ├── ClearScenario            (Method)           s=Simulator.ClearScenario
    │   └── ResetScenarios           (Method)           s=Simulator.ResetScenarios
    └── Vessels                      (Object)           s=Vessels
        └── <VesselCode>             (Object)           s=VES-001   (DisplayName = vessel name)
            ├── VesselId             (String, RO)       "VES-001"
            ├── Name                 (String, RO)       "MV Aurora Tide"
            └── <EquipCode>          (Object)           s=VES-001.ME1  (DisplayName = equipment name)
                ├── EquipmentType    (String, RO)       MainEngine | Generator | CoolingSystem | BilgeSystem
                ├── State            (String)           operating state, see below; SourceTimestamp = time of last tick
                ├── SensorHealth     (String)           OK | DEGRADED | FAULT  (simulator's own diagnostic summary)
                └── <Measurement>    (Double Variable)  s=VES-001.ME1.Temperature
                    └── Unit         (String Property)  s=VES-001.ME1.Temperature.Unit   e.g. "°C"
```

Every `Double` measurement variable carries:

* **Value** — `Double` (never NaN; for Bad statuses the value is the last published value or 0 and **must be ignored** by clients).
* **StatusCode** — data quality (table below).
* **SourceTimestamp** — time (UTC) the simulator "measured" the value. Frozen when telemetry is interrupted.
* **ServerTimestamp** — time the server wrote it.

Variables are `Read`/`Subscribe`-able by anonymous clients. Method calls require the control account (below).

## Equipment inventory (default `simulator/config/fleet.json`)

| Vessel | Name | Equipment codes |
|---|---|---|
| `VES-001` | MV Aurora Tide | `ME1`, `GEN1`, `COOL1`, `BILGE1` |
| `VES-002` | MV Baltic Meridian | `ME1`, `GEN1`, `COOL1`, `BILGE1` |

| EquipmentType | Measurements (BrowseName → unit) | States |
|---|---|---|
| `MainEngine` | `Rpm` rpm · `Temperature` °C · `Vibration` mm/s · `Load` % | STOPPED, STARTING, RUNNING, DEGRADED, TRIPPED |
| `Generator` | `PowerOutput` kW · `Load` % · `Frequency` Hz | STOPPED, STARTING, RUNNING, DEGRADED |
| `CoolingSystem` | `Pressure` bar · `Temperature` °C | STOPPED, RUNNING, DEGRADED |
| `BilgeSystem` | `WaterLevel` cm | STANDBY, PUMPING, DEGRADED |

Measurement keys used by the backend (lower-snake-case of the BrowseName): `rpm`, `temperature`, `vibration`,
`load`, `power_output`, `frequency`, `pressure`, `water_level`.

`DEGRADED` = a fault scenario is pushing the equipment outside its normal operating envelope.
`TRIPPED` (main engine only) = protective shutdown after sustained over-temperature; the engine stays tripped until its
scenario is cleared/reset, then restarts through `STARTING`.

### Status codes (data quality)

| Situation | StatusCode | Backend quality |
|---|---|---|
| Normal | `Good` (0x00000000) | `good` |
| Sensor failure scenario (`sensor_failure`) | `BadSensorFailure` (0x808C0000) | `bad` |
| Sensor reading beyond physical limits (`sensor_out_of_range`) | `Good`, absurd value | backend plausibility check → `invalid` |
| Stuck sensor (`sensor_stuck`) | `Good`, value constant, SourceTimestamp advancing | backend flat-line detector → `stuck` |
| Telemetry interruption (`telemetry_interruption`) | `Good`, SourceTimestamp **stops advancing** | backend staleness detector → `stale` |
| Value outside the sensor's nominal band but plausible | `Good` | `good` (alarm engine decides) |

`UncertainSensorNotAccurate` (0x40930000) is published for ~10 s after a sensor recovers (`uncertain`).

## Control methods

Callable only by the control account (username/password user token). Anonymous callers get `BadUserAccessDenied`.
Credentials come from `SIM_CONTROL_USER` / `SIM_CONTROL_PASSWORD`.

| Method | Inputs | Outputs |
|---|---|---|
| `ActivateScenario` | `vesselId: String`, `scenarioId: String`, `durationSeconds: UInt32` (0 = until cleared / scenario default) | `accepted: Boolean`, `message: String` |
| `ClearScenario` | `vesselId: String`, `scenarioId: String` (empty = all scenarios of that vessel) | `accepted: Boolean`, `message: String` |
| `ResetScenarios` | – | `accepted: Boolean`, `message: String` |

Method outcomes: unknown vessel/scenario or already-active scenario → `accepted=false` with a message (the call itself succeeds).
Failure of the call (bad credentials, outage) surfaces as OPC UA status errors.

`opcua_outage` is accepted immediately; ~1 s later the server stops its listener for `durationSeconds` (default 20, max 120), then
restarts it. While it is down *all* clients get connection loss; the simulation keeps stepping, so a gap appears in history.

### `ActiveScenarios` JSON

```json
[{"scenario_id":"engine_overheat","vessel_id":"VES-001","started_at":"2026-01-01T12:00:00.000Z","ends_at":null}]
```
`ends_at` is `null` for scenarios without a deadline.

## Scenario catalogue

| `scenarioId` | Target | Effect (physical relationship) | Default duration | Auto-clear |
|---|---|---|---|---|
| `engine_overheat` | ME1 | Cooling effectiveness degrades gradually (~0.5 °C/s ramp); engine temperature rises, cooling outlet temperature rises, vibration rises slightly; trips above trip temperature | 0 | no |
| `engine_vibration` | ME1 | Bearing-wear signature: vibration ramps to ≈2.5× nominal, engine temperature creeps up (+8 °C) | 0 | no |
| `cooling_pressure_loss` | COOL1 | Pressure decays toward ≈0.6 bar; flow loss reduces cooling effectiveness so ME1 temperature drifts up | 0 | no |
| `bilge_flooding` | BILGE1 | Ingress exceeds pump capacity, level rises ≈1 cm/s | 0 | no |
| `sensor_stuck` | ME1.Temperature | Value freezes (Good status, advancing source timestamp) while the real process continues | 0 | no |
| `sensor_out_of_range` | COOL1.Pressure | Publishes physically impossible value (-50 bar) with Good status | 0 | no |
| `sensor_failure` | GEN1.PowerOutput | StatusCode `BadSensorFailure` | 0 | no |
| `telemetry_interruption` | whole vessel | Sensor values/timestamps stop updating (server stays up) | 60 s | yes |
| `opcua_outage` | whole server | Listener stopped and restarted (`vesselId` ignored, pass `""`) | 20 s | yes |

Clearing a scenario returns the process to normal along a physical recovery curve (not an instant jump).

## Illustrative normal operating values (RUNNING)

| Measurement | Nominal | Notes |
|---|---|---|
| ME1 Rpm | 90 – 105 rpm (slow-speed two-stroke) | |
| ME1 Temperature | 78 – 88 °C | jacket cooling-water outlet |
| ME1 Vibration | 2.0 – 4.0 mm/s | RMS velocity |
| ME1 Load | 60 – 80 % | |
| GEN1 PowerOutput | 300 – 500 kW | |
| GEN1 Frequency | 49.8 – 50.2 Hz | |
| COOL1 Pressure | 2.2 – 3.0 bar | |
| COOL1 Temperature | 60 – 70 °C | |
| BILGE1 WaterLevel | 3 – 20 cm | pump starts at 35 cm, stops at 12 cm |

## Security

* `SIM_SECURITY_MODE=secure` (compose default): endpoint offers `Basic256Sha256` `SignAndEncrypt` **only**; server and client use
  self-signed development certificates (`scripts/gen-dev-certs.sh`); the server trusts only the backend's client certificate.
* `SIM_SECURITY_MODE=none`: unsecured development endpoint (also allows username/password on an unencrypted channel). Never expose it
  beyond a developer machine.
* Anonymous access is read-only; control methods need the control account.

## Deviations and implementation notes (simulator)

Recorded by the simulator implementation (`simulator/`). Items 1-2 are genuine deviations from the text above; the rest
clarify behaviour the contract leaves open.

1. **Numeric StatusCode values.** The first draft of this contract printed wrong numbers for the two named codes. The standard
   values (OPC UA specification, open62541, asyncua) are `BadSensorFailure = 0x808C0000` and `UncertainSensorNotAccurate = 0x40930000`;
   the table above was corrected and the simulator emits these. Clients should still classify by the severity bits (top two bits:
   `00` good, `01` uncertain, `10` bad), as the backend does (`app/domain/quality.py`).
2. **ServerTimestamp.** open62541 stamps the ServerTimestamp with the time of the *read / notification*, not the time of the write
   (the stack overwrites it; there is no supported way to keep a stored value). Only **SourceTimestamp** is meaningful for freshness
   and it follows the contract (simulation time of the tick, frozen during `telemetry_interruption`).
3. **Namespace index.** The server's ApplicationUri is `urn:seatrace:simulator`, identical to the namespace URI, so the namespace
   is index **1** (not 2). Resolve it with `get_namespace_index("urn:seatrace:simulator")`.
4. **Endpoint URL.** The server answers on any path of `opc.tcp://<host>:<port>`; `/seatrace/simulator` is accepted but not required.
5. **Method argument types are enforced by the server.** `durationSeconds` must be sent as a real `UInt32` variant
   (asyncua: `ua.Variant(30, ua.VariantType.UInt32)`); a plain Python `int` is sent as Int64 and fails with `BadInvalidArgument`.
   Anonymous callers receive `BadUserAccessDenied` (also for malformed calls). The `UserExecutable` attribute of the methods is
   `false` for anonymous sessions.
6. **`ActiveScenarios` entries** for the server-wide `opcua_outage` carry `"vessel_id": ""`. Its `ends_at` is
   `start + 1 s + duration` (the listener goes down 1 s after the call and stays down for `durationSeconds`).
7. **Method semantics.** `ActivateScenario` with unknown scenario *and* unknown vessel reports the scenario error first. `opcua_outage`
   rejects `durationSeconds > 120` with `accepted=false`. `ClearScenario` of a scenario that is not active returns `accepted=false`
   (clearing "all of a vessel" with nothing active returns `accepted=true`). `ClearScenario("", "opcua_outage")` cancels a pending outage.
8. **Quality after recovery.** The 10 s `UncertainSensorNotAccurate` phase applies to the three sensor scenarios
   (`sensor_stuck`, `sensor_out_of_range`, `sensor_failure`); during it `SensorHealth` is `DEGRADED`, while a fault is active it is
   `FAULT`. `telemetry_interruption` has no uncertain phase: publishing simply resumes.
9. **Engine restart interlock.** After a trip the engine stays `TRIPPED` until its `engine_overheat` scenario is cleared *and* the jacket
   has cooled below the restart temperature (default 95 deg C) *and* the cooling system is effective again; only then
   `STARTING` (~15 s) -> `RUNNING`. A configured `STOPPED` machine stays stopped unless `auto_start_after_s` is set in `fleet.json`.
10. **Telemetry interruption at start-up.** If a vessel starts with `telemetry_interruption` active its nodes report
    `BadWaitingForInitialData` until the first publish.
11. **Anonymous access** is also available in `secure` mode (read-only); the control methods need the username token.
