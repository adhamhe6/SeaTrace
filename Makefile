# Developer shortcuts. Everything here is a thin wrapper around documented commands.
SHELL := /bin/bash
.PHONY: help env up down logs sim-build sim-test backend-test backend-lint frontend-test frontend-build test lint openapi dev-stack smoke

help:           ## list targets
	@grep -E '^[a-z-]+:.*##' $(MAKEFILE_LIST) | sed 's/:.*##/\t/'

env:            ## create .env with random secrets
	scripts/init-env.sh

up:             ## build and start the full Docker Compose stack
	docker compose up --build -d --wait

down:           ## stop the stack (keeps volumes); add `-v` manually to wipe data
	docker compose down

logs:           ## follow container logs
	docker compose logs -f --tail=100

sim-build:      ## configure + build the C++ simulator
	cmake -S simulator -B simulator/build -G Ninja -DCMAKE_BUILD_TYPE=Release && cmake --build simulator/build

sim-test: sim-build  ## C++ unit + OPC UA tests
	ctest --test-dir simulator/build --output-on-failure

backend-test:   ## backend tests (needs PostgreSQL, see docs/testing.md); integration tests need the simulator build
	cd backend && uv run pytest -q

backend-lint:   ## ruff + mypy
	cd backend && uv run ruff check app tests scripts && uv run ruff format --check app tests scripts migrations && uv run mypy

frontend-test:  ## vitest
	cd frontend && npm test

frontend-build: ## type-check + production build
	cd frontend && npm run build

test: sim-test backend-test frontend-test  ## all automated tests (except browser e2e)

lint: backend-lint  ## linters
	cd frontend && npm run lint && npm run format:check

openapi:        ## regenerate docs/openapi.json from the FastAPI app
	cd backend && PYTHONPATH=. uv run python scripts/export_openapi.py

dev-stack:      ## run simulator + backend locally without Docker (scripts/dev-stack.sh)
	scripts/dev-stack.sh start

smoke:          ## black-box smoke test against a running stack
	python3 scripts/smoke_test.py
