#!/usr/bin/env bash
# Create .env with freshly generated random secrets (no placeholder values).
# Usage: scripts/init-env.sh [--force]
set -euo pipefail
cd "$(dirname "$0")/.."

if [[ -f .env && "${1:-}" != "--force" ]]; then
  echo ".env already exists; use --force to overwrite." >&2
  exit 1
fi

rand() { head -c 48 /dev/urandom | base64 | tr -dc 'A-Za-z0-9' | head -c "$1"; }

OPERATOR_PW="$(rand 16)"
VIEWER_PW="$(rand 16)"

# Start from the example, replacing every placeholder.
sed \
  -e "s|^POSTGRES_PASSWORD=.*|POSTGRES_PASSWORD=$(rand 24)|" \
  -e "s|^SEATRACE_SECRET_KEY=.*|SEATRACE_SECRET_KEY=$(rand 48)|" \
  -e "s|^SEATRACE_DEMO_OPERATOR_PASSWORD=.*|SEATRACE_DEMO_OPERATOR_PASSWORD=${OPERATOR_PW}|" \
  -e "s|^SEATRACE_DEMO_VIEWER_PASSWORD=.*|SEATRACE_DEMO_VIEWER_PASSWORD=${VIEWER_PW}|" \
  -e "s|^SIM_CONTROL_PASSWORD=.*|SIM_CONTROL_PASSWORD=$(rand 24)|" \
  .env.example > .env
chmod 600 .env

echo "Wrote .env with generated secrets."
echo "  operator login: operator / ${OPERATOR_PW}"
echo "  viewer login:   viewer   / ${VIEWER_PW}"
