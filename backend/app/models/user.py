import uuid
from datetime import datetime, timezone

from sqlalchemy import Boolean, DateTime, Integer, String
from sqlalchemy.orm import Mapped, mapped_column, relationship

from app.database.session import Base


class User(Base):
    __tablename__ = "users"

    id: Mapped[str] = mapped_column(String, primary_key=True, default=lambda: str(uuid.uuid4()))
    username: Mapped[str] = mapped_column(String(30), unique=True, index=True, nullable=False)
    email: Mapped[str] = mapped_column(String(255), unique=True, index=True, nullable=False)
    hashed_password: Mapped[str | None] = mapped_column(String, nullable=True)
    google_id: Mapped[str | None] = mapped_column(String, unique=True, nullable=True)
    avatar_url: Mapped[str | None] = mapped_column(String, nullable=True)
    is_active: Mapped[bool] = mapped_column(Boolean, default=True)
    is_admin: Mapped[bool] = mapped_column(Boolean, default=False)
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), default=lambda: datetime.now(timezone.utc)
    )

    # Aggregate usage counters (kept in sync by MetricsService for O(1) reads)
    total_compiles: Mapped[int] = mapped_column(Integer, default=0, nullable=False)
    total_compile_errors: Mapped[int] = mapped_column(Integer, default=0, nullable=False)
    total_runs: Mapped[int] = mapped_column(Integer, default=0, nullable=False)
    last_active_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    # ISO-3166 alpha-2 country codes from CF-IPCountry. Country only (no city / IP).
    signup_country: Mapped[str | None] = mapped_column(String(2), nullable=True, index=True)
    last_country: Mapped[str | None] = mapped_column(String(2), nullable=True, index=True)

    # Subscription state. Self-hosters never set these — defaults are safe
    # (no paid features unlock). Production velxio.dev syncs them from an
    # external billing system (Odoo) via webhook + periodic resync.
    is_paid_subscriber: Mapped[bool] = mapped_column(Boolean, default=False, nullable=False)
    subscription_status: Mapped[str | None] = mapped_column(String(20), nullable=True)
    subscription_period_end: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    odoo_partner_id: Mapped[int | None] = mapped_column(Integer, nullable=True, index=True)

    projects: Mapped[list["Project"]] = relationship("Project", back_populates="owner", lazy="select")  # noqa: F821
