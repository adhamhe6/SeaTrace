"""Application configuration (environment-driven; no business logic lives here)."""

from __future__ import annotations

from functools import lru_cache
from typing import Annotated, Literal

from pydantic import Field, field_validator, model_validator
from pydantic_settings import BaseSettings, NoDecode, SettingsConfigDict

# Values shipped in .env.example. They are accepted in development, refused in production.
INSECURE_PLACEHOLDERS = frozenset({"", "change-me", "changeme", "dev-secret-change-me"})


class Settings(BaseSettings):
    model_config = SettingsConfigDict(
        env_prefix="SEATRACE_", env_file=".env", extra="ignore", env_file_encoding="utf-8"
    )

    env: Literal["development", "test", "production"] = "development"
    log_level: str = "INFO"
    log_json: bool = True

    # --- database -----------------------------------------------------------------
    database_url: str = "postgresql+asyncpg://seatrace:seatrace@localhost:5432/seatrace"
    db_pool_size: int = 10
    db_connect_timeout_s: float = 5.0
    db_command_timeout_s: float = 15.0

    # --- security -----------------------------------------------------------------
    secret_key: str = "dev-secret-change-me"  # noqa: S105 - refused in production
    access_token_expire_minutes: int = 480
    cors_origins: Annotated[list[str], NoDecode] = Field(
        default_factory=lambda: ["http://localhost:5173"]
    )
    demo_operator_username: str = "operator"
    demo_operator_password: str | None = None
    demo_viewer_username: str = "viewer"
    demo_viewer_password: str | None = None

    # --- OPC UA client ------------------------------------------------------------
    opcua_enabled: bool = True
    opcua_endpoint: str = "opc.tcp://localhost:4840"
    opcua_security: Literal["none", "secure"] = "none"
    opcua_client_cert: str | None = None  # PEM or DER
    opcua_client_key: str | None = None
    opcua_server_cert: str | None = None
    opcua_application_uri: str = "urn:seatrace:backend"
    opcua_user: str | None = None
    opcua_password: str | None = None
    opcua_request_timeout_s: float = 5.0
    opcua_connect_timeout_s: float = 8.0
    opcua_publish_interval_ms: int = 500
    opcua_keepalive_interval_s: float = 2.0
    opcua_keepalive_failures: int = 2
    opcua_backoff_min_s: float = 1.0
    opcua_backoff_max_s: float = 30.0

    # --- ingestion / data quality ---------------------------------------------------
    ingest_queue_max: int = 20000
    ingest_batch_max: int = 500
    ingest_flush_interval_s: float = 0.25
    ingest_db_retries: int = 5
    ingest_db_retry_delay_s: float = 1.0
    max_future_skew_s: float = 5.0
    stale_after_s: float = 10.0
    flatline_samples: int = 15
    telemetry_retention_days: int = 0  # 0 = keep forever

    # --- API / realtime -------------------------------------------------------------
    history_default_limit: int = 5000
    history_max_limit: int = 20000
    incident_max_window_s: int = 7200
    ws_client_queue_size: int = 1000
    ws_replay_buffer: int = 2000
    ws_auth_timeout_s: float = 5.0
    ws_max_clients: int = 100

    @field_validator("cors_origins", mode="before")
    @classmethod
    def _split_origins(cls, v: object) -> object:
        if isinstance(v, str) and not v.strip().startswith("["):
            return [o.strip() for o in v.split(",") if o.strip()]
        return v

    @property
    def is_production(self) -> bool:
        return self.env == "production"

    @model_validator(mode="after")
    def _refuse_unsafe_production(self) -> Settings:
        if not self.is_production:
            return self
        problems: list[str] = []
        if self.secret_key in INSECURE_PLACEHOLDERS or len(self.secret_key) < 32:
            problems.append("SEATRACE_SECRET_KEY must be set to a random value of >= 32 characters")
        for name in ("demo_operator_password", "demo_viewer_password"):
            pw = getattr(self, name)
            if pw is not None and (pw in INSECURE_PLACEHOLDERS or pw.startswith("change-me")):
                problems.append(f"SEATRACE_{name.upper()} still has a placeholder value")
        if self.opcua_enabled and self.opcua_security != "secure":
            problems.append("SEATRACE_OPCUA_SECURITY must be 'secure' in production")
        if "*" in self.cors_origins:
            problems.append("SEATRACE_CORS_ORIGINS must not contain '*' in production")
        if problems:
            raise ValueError("Unsafe production configuration: " + "; ".join(problems))
        return self


@lru_cache
def get_settings() -> Settings:
    return Settings()
