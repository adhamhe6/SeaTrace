# Design decisions

## Why a C++ simulator?
Industrial equipment is usually driven by native PLC/embedded software and exposed over OPC UA by native stacks.
Writing the simulated "plant" in C++20 with `open62541` keeps the OPC UA server a *real, separate protocol endpoint*
(not a Python object the backend could cheat by importing), forces explicit ownership/lifetime/threading decisions
(RAII wrappers around the C server, a single-threaded run loop with a lock-free stop flag) and makes the boundary
honest: the backend can only learn what the address space tells it. It also gives deterministic, testable physics
(own Gaussian generator – `std::normal_distribution` is not portable across standard libraries).

## Why OPC UA?
It is the interoperability standard of industrial automation and increasingly of maritime systems. It provides
what this project needs natively and would otherwise have to be invented: typed hierarchical address space,
engineering units, **source timestamps**, **status codes as data quality**, subscriptions with filters, methods for
control, and certificate-based security.

## Why Python/FastAPI for ingestion and APIs?
`asyncua` is a mature async OPC UA client; FastAPI + Pydantic give a typed, self-documenting REST layer and
first-class WebSockets on the same event loop; SQLAlchemy 2 async + Alembic cover persistence and migrations.
Throughput needs (≈20 samples/s) are far below what a single asyncio process handles, so there is no broker or extra
service. The OPC UA client lives *inside* the API process to avoid an extra network hop and a second deployable; it is
isolated behind `OpcUaSupervisor`, so splitting it out later is a mechanical change.

## One process, bounded queue, one transaction
Samples are queued (bounded, drop-oldest + counter) and written in batches. Each batch is one transaction containing
telemetry, state changes, alarm rows and audit rows – so an alarm can never exist without the measurement that caused it.

## Alarm lifecycle
Four states derived from two independent facts (condition active × acknowledged). See [alarm-lifecycle.md](alarm-lifecycle.md).
Hysteresis, persistence and dwell time live in the rule data, not in code. The engine is pure so it can be property-
and scenario-tested without infrastructure; the database adds a partial unique index as a second line of defence.

## Data quality and reconnects
* Quality travels with every value (OPC UA status → `good/uncertain/bad`, backend adds `invalid`, `stuck`; `stale`
  is derived at read time). Invalid values are never replaced by zeros.
* *Source time* (`source_ts`) and *ingestion time* (`ingested_ts`) are separate columns; staleness uses backend receive time
  so clock skew between simulator and backend cannot hide an outage.
* Reconnect = build a brand-new client and one subscription every time; the previous client is always disconnected first.
  Backoff doubles from 1 s to 30 s with ±20 % jitter and resets after a stable connection.

## Security model (proportionate)
Argon2id passwords, HS256 JWT bearer tokens, role checks in backend dependencies (the UI hiding buttons is only a
convenience), login throttling, strict CORS allow-list, uniform error envelope without internals, secrets only from
environment, production start-up refuses placeholder secrets or an unsecured OPC UA link.
OPC UA: Basic256Sha256 SignAndEncrypt with explicit certificate trust in `secure` mode; control methods require a
username/password identity. See the README *Security boundaries* section for what is deliberately development-only.

## Why WebSocket (not SSE)?
Bidirectional keep-alive (`ping/pong`), resume handshake (`resume_from`) and first-message authentication fit a
WebSocket; browsers cannot set an `Authorization` header on `EventSource`, which would force tokens into URLs and logs.

## Why a replay window limit instead of unbounded paging?
Replay needs the whole window in the browser to scrub and play smoothly. The API caps a window at 2 h (≈ 7200 raw
points per series at 1 Hz) and answers larger requests with a precise error, while the general history endpoint offers
keyset pagination and server-side time bucketing for long ranges. Replay itself never interpolates or invents points; gaps
are reported explicitly.

## What is simulated and what would need validation on a real vessel
Simulated: all equipment behaviour, sensor noise, fault physics, operating limits, the OPC UA server, vessels and
names. Needed before any real use: validated equipment models and limits from class-approved documentation, OPC UA
integration with real PLC servers (vendor information models, certificate management/PKI, network segmentation,
unidirectional gateways where required), safety/alarm-management rationalisation by qualified engineers, formal
verification of the alarm logic, cybersecurity assessment (IACS UR E26/E27), long-term data-retention design, and
type approval where applicable. SeaTrace is an independent educational simulation – it must not be connected to
safety-critical onboard equipment.
