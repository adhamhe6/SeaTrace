"""Idempotent seeding of fleet metadata, sensor catalogue, default alarm rules and demo accounts."""

from __future__ import annotations

import logging

from sqlalchemy import select
from sqlalchemy.dialects.postgresql import insert
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from app.config import Settings
from app.db import models as m
from app.domain.enums import Role
from app.domain.seed_catalog import DEFAULT_RULES, FLEET
from app.security import hash_password, needs_rehash, verify_password

log = logging.getLogger(__name__)


async def seed_reference_data(session: AsyncSession) -> None:
    """Insert missing vessels/equipment/sensors/rules. Existing rows keep operator tuning (rules)."""
    for v in FLEET:
        vessel_id = await session.scalar(
            insert(m.Vessel)
            .values(code=v.code, name=v.name, vessel_type=v.vessel_type, is_simulated=True)
            .on_conflict_do_update(
                index_elements=["code"], set_={"name": v.name, "vessel_type": v.vessel_type}
            )
            .returning(m.Vessel.id)
        )
        for e in v.equipment:
            equipment_id = await session.scalar(
                insert(m.Equipment)
                .values(vessel_id=vessel_id, code=e.code, name=e.name, equipment_type=e.type.value)
                .on_conflict_do_update(
                    constraint="uq_equipment_vessel_code",
                    set_={"name": e.name, "equipment_type": e.type.value},
                )
                .returning(m.Equipment.id)
            )
            for s in e.sensors:
                values = {
                    "equipment_id": equipment_id,
                    "key": s.key,
                    "name": s.name,
                    "unit": s.unit,
                    "plausible_min": s.plausible_min,
                    "plausible_max": s.plausible_max,
                    "nominal_min": s.nominal_min,
                    "nominal_max": s.nominal_max,
                    "flatline_check": s.flatline_check,
                }
                await session.execute(
                    insert(m.Sensor)
                    .values(**values)
                    .on_conflict_do_update(
                        constraint="uq_sensors_equipment_key",
                        set_={
                            k: v_ for k, v_ in values.items() if k not in ("equipment_id", "key")
                        },
                    )
                )
    for r in DEFAULT_RULES:
        await session.execute(
            insert(m.AlarmRule)
            .values(
                code=r.code,
                name=r.name,
                description=r.description,
                kind=r.kind.value,
                equipment_type=r.equipment_type.value if r.equipment_type else None,
                measurement_key=r.measurement_key,
                comparison=r.comparison.value,
                threshold=r.threshold,
                clear_threshold=r.clear_threshold,
                activate_after_s=r.activate_after_s,
                clear_after_s=r.clear_after_s,
                severity=r.severity.value,
                enabled=True,
            )
            .on_conflict_do_nothing(index_elements=["code"])
        )


async def seed_demo_users(session: AsyncSession, settings: Settings) -> list[str]:
    """Create/refresh demo accounts from environment variables. Returns the usernames touched."""
    touched: list[str] = []
    for username, password, role in (
        (settings.demo_operator_username, settings.demo_operator_password, Role.OPERATOR),
        (settings.demo_viewer_username, settings.demo_viewer_password, Role.VIEWER),
    ):
        if not password:
            continue
        user = await session.scalar(select(m.User).where(m.User.username == username))
        if user is None:
            session.add(
                m.User(
                    username=username,
                    password_hash=hash_password(password),
                    role=role.value,
                    is_active=True,
                )
            )
        elif (
            not verify_password(password, user.password_hash)
            or needs_rehash(user.password_hash)
            or user.role != role.value
        ):
            user.password_hash = hash_password(password)
            user.role = role.value
            user.is_active = True
        touched.append(username)
    return touched


async def run_seed(sessionmaker: async_sessionmaker[AsyncSession], settings: Settings) -> None:
    async with sessionmaker() as session, session.begin():
        await seed_reference_data(session)
        users = await seed_demo_users(session, settings)
    log.info("seed complete", extra={"demo_users": users})
