"""Write the OpenAPI document to a file (default: ../docs/openapi.json) without starting any services."""

from __future__ import annotations

import json
import sys
from pathlib import Path

from app.config import Settings
from app.main import create_app


def main() -> None:
    target = (
        Path(sys.argv[1])
        if len(sys.argv) > 1
        else Path(__file__).parents[2] / "docs" / "openapi.json"
    )
    app = create_app(Settings(opcua_enabled=False, log_level="WARNING"))
    target.write_text(json.dumps(app.openapi(), indent=2, sort_keys=True) + "\n", encoding="utf-8")
    print(f"wrote {target}")


if __name__ == "__main__":
    main()
