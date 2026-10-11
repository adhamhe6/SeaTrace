# SeaTrace web UI

React 19 + TypeScript (strict) + Vite single-page application. It only ever talks to the SeaTrace backend over
**same-origin** relative URLs: REST under `/api/v1/...` and the WebSocket at `ws(s)://<host>/api/v1/ws`. It contains
no mock or hard-coded data: every number on screen comes from the API or the WebSocket. All vessels and telemetry are
simulated; the UI says so on every page.

## Quick start

```bash
cd frontend
npm ci
npm run dev            # http://localhost:5173, proxies /api (incl. WebSocket upgrade) to http://localhost:8000
```

Run the backend and the simulator with `scripts/dev-stack.sh start` (demo logins come from the environment, see the
backend README). `SEATRACE_BACKEND_URL` overrides the proxy target for `npm run dev` / `npm run preview`.

| Script                                   | Purpose                                                                     |
| ---------------------------------------- | --------------------------------------------------------------------------- |
| `npm run build`                          | `tsc -b && vite build` (output in `dist/`)                                  |
| `npm run preview`                        | Serve the production build locally (same CSP header as nginx)               |
| `npm run lint` / `format` / `typecheck`  | ESLint flat config (typescript-eslint strict, react-hooks, jsx-a11y), Prettier, tsc |
| `npm test` / `npm run test:coverage`     | Vitest + React Testing Library (jsdom)                                      |
| `npm run e2e`                            | Playwright against a running stack (see below)                              |
| `npm run gen:api`                        | Regenerate `src/api/schema.d.ts` from `docs/openapi.json`                   |

## Structure

```
src/
  api/        client.ts (typed ApiError, timeouts, 401 hook), hooks.ts (TanStack Query hooks), schema.d.ts (generated)
  auth/       auth store (sessionStorage), login page, route guard
  realtime/   LiveClient (WebSocket protocol), applyMessage (cache patching), RealtimeProvider, live store
  lib/        formatting, domain descriptors (severity/health/quality/alarm lifecycle), settings, helpers
  ui/         small design system (Button, Badge, Card, DataTable, Tabs, Dialog, Toast, Tooltip, ...) + chart/
  layout/     app shell, top bar, navigation, error boundary
  pages/      Fleet, Vessel, Alarms, AlarmDetail, Replay, Simulator, About, NotFound
  features/   alarms/ vessel/ replay/ simulator/ (page-specific components and pure logic)
  test/       test-only fixtures (API-shaped, typed against the schema), fetch stub, render helpers
e2e/          Playwright specs
```

## Design decisions

- **Server state** lives in TanStack Query; small zustand stores hold auth, settings (theme, UTC/local) and live
  connection state. Types for every request/response come from the generated OpenAPI schema.
- **Design system**: plain CSS with design tokens (`styles/tokens.css`), dark navy default and a light theme that
  follows `prefers-color-scheme` until the user toggles it (persisted in `localStorage`). System fonts only: nothing is
  loaded from a CDN, so the app works air-gapped and under a strict CSP. Severity, health and quality are always shown
  as icon + text, never colour alone. Tabular numerals for measurements, monospaced timestamps.
- **Time**: all timestamps are UTC by default and explicitly labelled; a top-bar toggle switches to the browser's
  zone (labelled with its offset). Custom replay/filter ranges are entered and interpreted as UTC.
- **Accessibility**: skip link, landmarks, focus management on route change and in dialogs (focus trap, Escape,
  focus return), polite live region for new critical alarms and toasts (errors use an assertive region), tabs with
  roving tabindex, `aria-disabled` operator controls that stay focusable so the reason ("Operator role required") is
  reachable, visible focus rings, `prefers-reduced-motion` respected.
- **Role gating**: operator-only actions (acknowledge, activate/clear/reset scenarios) are disabled for viewers with a
  visible tooltip. The backend enforces the roles independently; a 403 is handled with a toast.

### Authentication and the XSS trade-off

`POST /api/v1/auth/login` returns a bearer JWT. It is kept in **`sessionStorage`** (`seatrace.auth`) so it survives a
reload of the tab but is dropped when the browser session ends and is never written to `localStorage`. The trade-off:
any script running in the page origin (XSS) can read `sessionStorage`, whereas an `HttpOnly` cookie could not be read
but would require CSRF protection and a different backend contract. Mitigations here: no third-party scripts, a strict
Content-Security-Policy (`default-src 'self'`, no inline scripts, `frame-ancestors 'none'`), React's escaping (no
`dangerouslySetInnerHTML`; the chart tooltip HTML is escaped), and short-lived tokens. On `401` the session is cleared and the
user is redirected to `/login?next=<route>`; the WebSocket authenticates with a first `auth` message (the token is never
put in a URL). `next` is only honoured for same-origin absolute paths.

### Real-time layer

`LiveClient` (`src/realtime/wsClient.ts`, fully unit-tested with a fake socket and fake timers) implements the protocol in
`backend/app/api/routers/ws.py`: wait for `hello`, send `auth` with `resume_from`, handle `ready` (a `resync_required`
invalidates every query), process sequenced messages (duplicates ignored), ping every 20 s, treat 45 s of silence as a dead
connection, reconnect with exponential backoff + jitter (1 s to 30 s, reset after a stable connection), `4401` signs out,
`1013` reconnects without `resume_from` and forces a resync. Messages patch the query cache (`telemetry` -> latest
readings and live chart buffers; `alarm` -> alarm caches, counters and a highlight; `equipment_state`; `source_status`;
`scenario`). While the channel is not open the UI shows "Live updates paused" and every data hook falls back to polling
every 5 s; while it is open aggregates are refreshed only as a 30 s safety net. Reading ages are recomputed locally every
second from `ingested_ts` (using a server-clock offset learned from `server_time` fields), so values visibly go stale
even when no message arrives.

### Incident replay

`/replay` accepts `?alarm=ID[&before=&after=]` or `?vessel=&equipment=&from=&to=` (UTC ISO). The server window is parsed
once into a model (`features/replay/model.ts`). The cursor is a `PlaybackStore` advanced by `requestAnimationFrame` in
**data time** (speed x real time, 0.5x to 30x) and published as an external store, so the synchronized cursor line is
moved on each chart without re-rendering React. The "State at cursor" panel shows, per measurement, the *last stored
sample at or before the cursor* with its own timestamp and age relative to the cursor; nothing is interpolated, gaps and
empty windows are stated explicitly. Alarm state at the cursor is reconstructed from the in-window transitions (the first
transition's `from_state` gives the state before it). Charts are ECharts (tree-shaken, canvas) with LTTB sampling for drawing
only; the data panel always uses the full-resolution arrays. Keyboard: `Space` play/pause, `Left`/`Right` previous/next stored sample.

## Docker / nginx

`Dockerfile` is a two-stage build (`node:22-alpine` builds, `nginx:1.27-alpine` serves). `nginx.conf` serves the SPA with
history fallback, proxies `/api/` to `http://backend:8000` with WebSocket upgrade headers and a 1 h read timeout,
exposes `/healthz`, sets a CSP (`default-src 'self'; connect-src 'self' ws: wss:; img-src 'self' data:; style-src 'self'
'unsafe-inline'; frame-ancestors 'none'` plus `object-src 'none'`, `base-uri`, `form-action`), `X-Content-Type-Options`,
`Referrer-Policy`, gzip, immutable caching for `/assets/*` and no caching for `index.html`. The `backend` host name must
resolve when nginx starts (docker compose service name).

## Tests

- Vitest + React Testing Library; fixtures in `src/test/fixtures.ts` are typed against the generated schema. Fetch is
  stubbed in tests only (`src/test/mockApi.ts`); the application contains no mock data. Charts are replaced by an inert
  stub because jsdom has no canvas.
- Playwright (`e2e/smoke.spec.ts`) runs against the real stack. Required environment: `E2E_OPERATOR_USER`,
  `E2E_OPERATOR_PASSWORD`, `E2E_VIEWER_USER`, `E2E_VIEWER_PASSWORD`; `BASE_URL` (default `http://localhost:5173`);
  optional `PLAYWRIGHT_CHROMIUM_EXECUTABLE` (otherwise the pre-installed Chromium under `/opt/pw-browsers` is used).
  The operator workflow activates `engine_overheat` for VES-001, waits (up to 3 min) for an alarm, acknowledges it,
  checks the history, replays it, and clears the scenario.

```bash
scripts/dev-stack.sh start
cd frontend && npm run dev &   # or npm run build && npm run preview, then BASE_URL=http://localhost:4173
E2E_OPERATOR_USER=operator E2E_OPERATOR_PASSWORD=... E2E_VIEWER_USER=viewer E2E_VIEWER_PASSWORD=... npm run e2e
```
