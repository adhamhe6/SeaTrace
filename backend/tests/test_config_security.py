import pytest
from app.config import Settings
from app.domain.enums import Role
from app.security import (
    create_access_token,
    decode_access_token,
    hash_password,
    needs_rehash,
    verify_password,
)
from pydantic import ValidationError

GOOD = "x" * 40


def prod(**kw):
    base = {
        "env": "production",
        "secret_key": GOOD,
        "opcua_security": "secure",
        "cors_origins": ["https://a.example"],
    }
    base.update(kw)
    return Settings(_env_file=None, **base)


def test_production_accepts_safe_configuration():
    assert prod().is_production


@pytest.mark.parametrize(
    "override",
    [
        {"secret_key": "dev-secret-change-me"},
        {"secret_key": "short"},
        {"secret_key": ""},
        {"opcua_security": "none"},
        {"cors_origins": ["*"]},
        {"demo_operator_password": "change-me"},
        {"demo_viewer_password": "change-me-viewer"},
    ],
)
def test_production_refuses_unsafe_defaults(override):
    with pytest.raises(ValidationError):
        prod(**override)


def test_development_accepts_placeholders():
    assert not Settings(_env_file=None, env="development").is_production


def test_cors_origins_parse_from_comma_separated_env(monkeypatch):
    monkeypatch.setenv("SEATRACE_CORS_ORIGINS", "http://a.example, http://b.example")
    assert Settings(_env_file=None).cors_origins == ["http://a.example", "http://b.example"]


def test_password_hashing_uses_argon2_and_salts():
    h1, h2 = hash_password("secret"), hash_password("secret")
    assert h1 != h2 and h1.startswith("$argon2id$")
    assert verify_password("secret", h1) and not verify_password("Secret", h1)
    assert not verify_password("secret", "not-a-hash")
    assert not needs_rehash(h1)


def test_token_roundtrip_and_rejection():
    tok, _ = create_access_token(
        user_id=3, username="op", role=Role.OPERATOR, secret=GOOD, expires_minutes=5
    )
    claims = decode_access_token(tok, GOOD)
    assert claims and (claims.user_id, claims.username, claims.role) == (3, "op", Role.OPERATOR)
    assert decode_access_token(tok, "y" * 40) is None
    assert decode_access_token(tok + "x", GOOD) is None
    assert decode_access_token("", GOOD) is None
    # alg=none forgery must be rejected
    import base64
    import json

    def b64(d):
        return base64.urlsafe_b64encode(json.dumps(d).encode()).rstrip(b"=").decode()

    forged = f"{b64({'alg': 'none', 'typ': 'JWT'})}.{b64({'sub': '1', 'usr': 'x', 'role': 'operator', 'iss': 'seatrace', 'exp': 9999999999})}."
    assert decode_access_token(forged, GOOD) is None
