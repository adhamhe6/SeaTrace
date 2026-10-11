#!/usr/bin/env bash
# Run the whole SeaTrace stack WITHOUT Docker: PostgreSQL (existing server) + C++ simulator + backend.
#
#   scripts/dev-stack.sh start     build the simulator if needed, migrate the DB, start simulator + backend
#   scripts/dev-stack.sh stop
#   scripts/dev-stack.sh status
#   scripts/dev-stack.sh logs      follow the logs
#
# Configuration (environment variables, all optional):
#   DEV_DB_ADMIN_URL   libpq URL of a role that may CREATE DATABASE   (default postgresql://seatrace:seatrace@localhost:5432/postgres)
#   DEV_DB_NAME        database to use                                (default seatrace_dev)
#   BACKEND_PORT       API port                                       (default 8000)
#   DEV_STACK_DIR      where pids/logs/certs live (default .dev-stack) - use different dirs for parallel stacks
#   SIM_PORT           OPC UA port                                    (default 4840)
#   SIM_TICK_MS        simulation tick                                (default 1000)
#   SIM_SECURITY_MODE  none | secure                                  (default none for local dev)
#   OPERATOR_PASSWORD / VIEWER_PASSWORD  demo passwords               (default op-pass-123 / view-pass-123)
set -euo pipefail
cd "$(dirname "$0")/.."
ROOT="$PWD"
RUN_DIR="${DEV_STACK_DIR:-$ROOT/.dev-stack}"
mkdir -p "$RUN_DIR"

ADMIN_URL="${DEV_DB_ADMIN_URL:-postgresql://seatrace:seatrace@localhost:5432/postgres}"
DB_NAME="${DEV_DB_NAME:-seatrace_dev}"
BACKEND_PORT="${BACKEND_PORT:-8000}"
SIM_PORT="${SIM_PORT:-4840}"
SIM_SECURITY_MODE="${SIM_SECURITY_MODE:-none}"
OPERATOR_PASSWORD="${OPERATOR_PASSWORD:-op-pass-123}"
VIEWER_PASSWORD="${VIEWER_PASSWORD:-view-pass-123}"
CONTROL_USER="seatrace-backend"
CONTROL_PASSWORD="dev-control-password"
export UV_NATIVE_TLS="${UV_NATIVE_TLS:-1}"

pid_alive() { [[ -f "$1" ]] && kill -0 "$(cat "$1")" 2>/dev/null; }

stop_one() {
  local name="$1" pidfile="$RUN_DIR/$1.pid"
  if pid_alive "$pidfile"; then
    kill "$(cat "$pidfile")" 2>/dev/null || true
    for _ in $(seq 1 50); do pid_alive "$pidfile" || break; sleep 0.1; done
    pid_alive "$pidfile" && kill -9 "$(cat "$pidfile")" 2>/dev/null || true
    echo "stopped $name"
  fi
  rm -f "$pidfile"
}

wait_http() {
  local url="$1" tries="${2:-60}"
  for _ in $(seq 1 "$tries"); do
    curl -fsS -o /dev/null "$url" 2>/dev/null && return 0
    sleep 0.5
  done
  return 1
}

start() {
  if pid_alive "$RUN_DIR/backend.pid" || pid_alive "$RUN_DIR/simulator.pid"; then
    echo "already running (use 'stop' first)"; exit 1
  fi
  # 1. simulator binary
  local bin="$ROOT/simulator/build/seatrace_simulator"
  if [[ ! -x "$bin" ]]; then
    echo "building simulator..."
    cmake -S simulator -B simulator/build -G Ninja -DCMAKE_BUILD_TYPE=Release >/dev/null
    cmake --build simulator/build
  fi
  # 2. database
  if ! psql "$ADMIN_URL" -tAc "SELECT 1 FROM pg_database WHERE datname='$DB_NAME'" | grep -q 1; then
    psql "$ADMIN_URL" -qc "CREATE DATABASE \"$DB_NAME\""
    echo "created database $DB_NAME"
  fi
  local base="${ADMIN_URL%/*}"            # postgresql://user:pw@host:port
  local db_url="postgresql+asyncpg://${base#postgresql://}/$DB_NAME"
  export SEATRACE_DATABASE_URL="$db_url"
  (cd backend && uv run alembic upgrade head 2>&1 | tail -1) || true
  # 3. simulator
  local sim_env=(SIM_OPCUA_PORT="$SIM_PORT" SIM_TICK_MS="${SIM_TICK_MS:-1000}" SIM_SEED="${SIM_SEED:-42}"
                 SIM_SECURITY_MODE="$SIM_SECURITY_MODE" SIM_CONTROL_USER="$CONTROL_USER"
                 SIM_CONTROL_PASSWORD="$CONTROL_PASSWORD" SIM_CONFIG="$ROOT/simulator/config/fleet.json")
  local backend_sec=(SEATRACE_OPCUA_SECURITY=none)
  if [[ "$SIM_SECURITY_MODE" == "secure" ]]; then
    PKI_DIR="$RUN_DIR/pki" scripts/gen-dev-certs.sh >/dev/null
    sim_env+=(SIM_SERVER_CERT="$RUN_DIR/pki/simulator/cert.der" SIM_SERVER_KEY="$RUN_DIR/pki/simulator/key.der"
              SIM_TRUSTED_CLIENT_CERTS="$RUN_DIR/pki/backend/cert.der")
    backend_sec=(SEATRACE_OPCUA_SECURITY=secure SEATRACE_OPCUA_CLIENT_CERT="$RUN_DIR/pki/backend/cert.pem"
                 SEATRACE_OPCUA_CLIENT_KEY="$RUN_DIR/pki/backend/key.pem" SEATRACE_OPCUA_SERVER_CERT="$RUN_DIR/pki/simulator/cert.pem")
  fi
  env "${sim_env[@]}" setsid nohup "$bin" >"$RUN_DIR/simulator.log" 2>&1 </dev/null &
  echo $! >"$RUN_DIR/simulator.pid"
  # 4. backend
  (cd backend && env "${backend_sec[@]}" \
      SEATRACE_OPCUA_ENDPOINT="opc.tcp://127.0.0.1:$SIM_PORT" SEATRACE_OPCUA_USER="$CONTROL_USER" \
      SEATRACE_OPCUA_PASSWORD="$CONTROL_PASSWORD" SEATRACE_DEMO_OPERATOR_PASSWORD="$OPERATOR_PASSWORD" \
      SEATRACE_DEMO_VIEWER_PASSWORD="$VIEWER_PASSWORD" SEATRACE_CORS_ORIGINS="http://localhost:5173" \
      setsid nohup uv run uvicorn app.main:app_factory --factory --host 127.0.0.1 --port "$BACKEND_PORT" --no-access-log \
      >"$RUN_DIR/backend.log" 2>&1 </dev/null &
      echo $! >"$RUN_DIR/backend.pid")
  if wait_http "http://127.0.0.1:$BACKEND_PORT/api/v1/health/ready" 90; then
    echo "SeaTrace dev stack is up:"
    echo "  API      http://127.0.0.1:$BACKEND_PORT/api/v1/docs"
    echo "  OPC UA   opc.tcp://127.0.0.1:$SIM_PORT   (security: $SIM_SECURITY_MODE)"
    echo "  logins   operator / $OPERATOR_PASSWORD     viewer / $VIEWER_PASSWORD"
    echo "  logs     $RUN_DIR/{simulator,backend}.log"
  else
    echo "backend did not become ready; see $RUN_DIR/backend.log" >&2
    tail -20 "$RUN_DIR/backend.log" >&2 || true
    exit 1
  fi
}

case "${1:-}" in
  start) start ;;
  stop) stop_one backend; stop_one simulator ;;
  status)
    for n in simulator backend; do
      if pid_alive "$RUN_DIR/$n.pid"; then echo "$n: running (pid $(cat "$RUN_DIR/$n.pid"))"; else echo "$n: stopped"; fi
    done ;;
  logs) tail -n 50 -f "$RUN_DIR/simulator.log" "$RUN_DIR/backend.log" ;;
  *) echo "usage: $0 {start|stop|status|logs}" >&2; exit 2 ;;
esac
