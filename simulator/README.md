# SeaTrace simulator

C++20 vessel simulator with an OPC UA server (open62541). It publishes the information model described in
[`docs/opc-ua-model.md`](../docs/opc-ua-model.md) for two simulated vessels and lets a control account inject
faults through OPC UA methods.

> All data is **simulated**. Nominal ranges, rated values and tuning parameters in `config/fleet.json` are
> illustrative simulation parameters, not authoritative operating limits of any real equipment.

## Layout

| Path | Content |
|---|---|
| `src/core/` | `seatrace_sim_core`: RNG, sensors, equipment models (MainEngine, Generator, CoolingSystem, BilgeSystem), Vessel, ScenarioManager, Simulation, config loading/validation, settings, JSON logger. No OPC UA dependency. |
| `src/opcua/` | `seatrace_sim_opcua`: address space builder, status mapping, method handlers, access control, security setup, `OpcUaServer` and the `Runner` loop. |
| `src/app/main.cpp` | `seatrace_simulator` executable. |
| `config/fleet.json` | Fleet definition (VES-001 "MV Aurora Tide", VES-002 "MV Baltic Meridian"). |
| `tests/` | GoogleTest unit and in-process OPC UA tests (`ctest`). |
| `Dockerfile` | Multi-stage image; **build context is the repository root**. |
| `../scripts/gen-dev-certs.sh` | Development certificates (see Security). |

## Build and test

Requirements: C++20 compiler (g++ 13 / clang 18), CMake >= 3.25, Ninja, git, OpenSSL 3 development files, python3
(open62541 build). Dependencies are fetched with pinned git tags: open62541 `v1.4.21`, nlohmann_json `v3.12.0`,
GoogleTest `v1.17.0`. Offline: pass `-DFETCHCONTENT_SOURCE_DIR_OPEN62541=...` (`..._GOOGLETEST`, `..._NLOHMANN_JSON`).

```sh
cmake -S simulator -B simulator/build -G Ninja          # Release by default, tests on
cmake --build simulator/build
ctest --test-dir simulator/build -j4 --output-on-failure   # 146 tests, ~20 s
```

open62541 is built as a static, single-threaded (`UA_MULTITHREADING=0`) library with the **OpenSSL** backend
(system OpenSSL 3 works; mbedTLS was not needed), reduced namespace 0, no PubSub/historizing/discovery/diagnostics.
`-Wall -Wextra -Wpedantic -Werror` applies to our targets only. Formatting: `clang-format -i` (`.clang-format`, Google
style, 100 columns).

## Running

```sh
export SIM_CONTROL_USER=control SIM_CONTROL_PASSWORD=change-me
# development, unencrypted (logs a loud warning):
SIM_SECURITY_MODE=none simulator/build/seatrace_simulator
# secure (default): Basic256Sha256 / SignAndEncrypt only
scripts/gen-dev-certs.sh
SIM_SERVER_CERT=pki/simulator/cert.der SIM_SERVER_KEY=pki/simulator/key.der \
SIM_TRUSTED_CLIENT_CERTS=pki/backend/cert.der simulator/build/seatrace_simulator
```

| Environment variable | Flag | Default | Meaning |
|---|---|---|---|
| `SIM_OPCUA_PORT` | `--port` | 4840 | TCP port |
| `SIM_TICK_MS` | `--tick-ms` | 1000 | simulation tick (10-60000 ms); physics run in real time, a faster tick only samples more often |
| `SIM_SEED` | `--seed` | 42 | random seed (0 - 2^32-1), published as `Simulator.Seed` |
| `SIM_CONFIG` | `--config` | `config/fleet.json` | fleet configuration |
| `SIM_SECURITY_MODE` | `--security-mode` | `secure` | `secure` or `none` |
| `SIM_CONTROL_USER` | `--control-user` | required | control account (non-empty) |
| `SIM_CONTROL_PASSWORD` | - (env only) | required | control password (non-empty; never logged, not accepted on the command line) |
| `SIM_SERVER_CERT`, `SIM_SERVER_KEY` | `--server-cert`, `--server-key` | secure mode | DER files |
| `SIM_TRUSTED_CLIENT_CERTS` | `--trusted-client-certs` | secure mode | comma separated DER client certificates |
| `SIM_LOG_LEVEL` | `--log-level` | `info` | `debug`, `info`, `warn`, `error` |

Flags override the environment. Logs are one JSON object per line on stdout (`ts`, `level`, `msg`, extra fields),
flushed per line. Exit codes: `0` clean shutdown (SIGINT/SIGTERM, ~0.1 s), `2` invalid arguments/environment/fleet
configuration, `3` server could not start (missing/invalid certificates, port in use, ...); a clear message goes to stderr.

## Configuration (`config/fleet.json`)

Per vessel: `code`, `name`, `equipment[]`, optional `initial_scenarios[]` (`scenario_id`, `duration_seconds`).
Per equipment: `code`, `name`, `type` (`MainEngine|Generator|CoolingSystem|BilgeSystem`), optional `initial_state`
(`RUNNING`/`STOPPED`/`STARTING`, bilge `STANDBY`/`PUMPING`), optional `auto_start_after_s`, `measurements[]` (exactly the
set required by the type; `unit` must match the contract; `nominal_min/max`, `plausible_min/max`, `noise_sigma`),
`rated{}` (design/protection values, e.g. `trip_temperature_c`, `power_kw`, `pump_*_level_cm`) and `parameters{}`
(dynamics tuning, e.g. `thermal_tau_s`, `load_period_s`). Unknown keys, duplicate codes, `nominal_min > nominal_max`,
unknown equipment types or scenario ids, bad units and out-of-range parameters are rejected at start-up with the JSON
path of the problem. VES-002 differs from VES-001 in load profile, rated power, trip temperature, sea temperature, etc.

## Model

Everything is deterministic: noise comes from `std::mt19937_64` raw output through our own Box-Muller transform (not
`std::normal_distribution`), one independent sub-stream per sensor and per process (`splitmix64(seed ^ splitmix64(FNV-1a(label)))`).
Same seed and same command sequence give bit-identical output (tested); only libm last-ulp differences could vary between platforms.

* Engine load follows a slow sinusoid plus AR(1) disturbance; rpm follows load; jacket temperature is a first-order lag towards
  `ambient + gain * heat / cooling_effectiveness`; vibration = base + rpm term + scenario terms.
* Cooling effectiveness (0.6 without flow .. 1.0) follows the cooling pressure; the coolant outlet temperature follows
  `sea + k * (engine - sea)`. So `cooling_pressure_loss` heats the engine and `engine_overheat` heats the coolant, not the bilge.
* Generator power = load % x rated kW; frequency droops with load. Bilge: mean-reverting seepage, pump on above 35 cm and off below
  12 cm (hysteresis), `PUMPING` / `DEGRADED`.
* Engine trip: temperature > trip limit for 5 s -> `TRIPPED` (rpm decays, vibration drops), latched until the scenario is cleared and the
  engine has cooled, then `STARTING` (~15 s) -> `RUNNING`.
* Sensor scenarios act on the published reading only (stuck, -50 bar, `BadSensorFailure`); clearing gives 10 s `UncertainSensorNotAccurate`.

See `docs/opc-ua-model.md` ("Deviations and implementation notes") for where the implementation clarifies or differs from the contract.

## Threading

One thread. `Runner::run` interleaves fixed-rate simulation ticks with `EventLoop::run` (what `UA_Server_run_iterate` does, with
a wait limited to the next tick); OPC UA method callbacks run inside that call, so simulation state needs no locks. The only shared
object is an `std::atomic<bool>` stop flag set by the SIGINT/SIGTERM handler. `opcua_outage` is performed by the same loop:
`UA_Server_run_shutdown` (listener down, clients disconnected, address space kept) and `UA_Server_run_startup` later; the simulation
keeps stepping meanwhile. Restarting the listener was verified with open62541 1.4 (new sessions and subscriptions work afterwards).
If the loop falls behind by more than 10 ticks it skips ticks and logs a warning.

## Security notes

* `secure`: only `SecurityPolicy#Basic256Sha256` / `SignAndEncrypt`; application URI `urn:seatrace:simulator` (must match the
  certificate SAN); client certificates must be in `SIM_TRUSTED_CLIENT_CERTS` (self-signed certificates are trusted by listing them).
  Anonymous sessions are read-only; username/password is accepted only for the one control account (constant-time comparison).
* `none`: unsecured endpoint, username/password in clear text. Development only.
* Clients cannot add, delete or write nodes. X.509 user tokens are not offered.
* `scripts/gen-dev-certs.sh` (idempotent, `PKI_DIR` or `<repo>/pki`, `FORCE=1` to regenerate) creates RSA 2048 / SHA-256 self-signed
  certificates `pki/simulator/{cert,key}.{der,pem}` and `pki/backend/{cert,key}.{der,pem}` (private keys mode 600; `pki/` is git-ignored).
  Development use only.

## Docker

```sh
docker build -f simulator/Dockerfile -t seatrace-simulator .     # context = repo root
```
Runtime image: binary in `/usr/local/bin`, `/etc/seatrace/fleet.json` (default `SIM_CONFIG`), `/opt/seatrace/gen-dev-certs.sh`,
non-root user `sim` (10002), `EXPOSE 4840`, bash TCP-connect `HEALTHCHECK`.

## Python client snippet (asyncua, secure mode with user/password)

```python
from asyncua import Client, ua
from asyncua.crypto.security_policies import SecurityPolicyBasic256Sha256

c = Client("opc.tcp://simulator:4840/seatrace/simulator")
c.application_uri = "urn:seatrace:backend"            # must match the client certificate SAN
await c.set_security(SecurityPolicyBasic256Sha256,
                     certificate="pki/backend/cert.pem", private_key="pki/backend/key.pem",
                     server_certificate="pki/simulator/cert.der",
                     mode=ua.MessageSecurityMode.SignAndEncrypt)
c.set_user("control"); c.set_password("change-me")
async with c:
    ns = await c.get_namespace_index("urn:seatrace:simulator")
    sim = await c.nodes.objects.get_child([f"{ns}:SeaTrace", f"{ns}:Simulator"])
    await sim.call_method(f"{ns}:ActivateScenario", "VES-001", "engine_overheat",
                          ua.Variant(0, ua.VariantType.UInt32))
    dv = await c.get_node(f"ns={ns};s=VES-001.GEN1.PowerOutput").read_data_value(raise_on_bad_status=False)
```
