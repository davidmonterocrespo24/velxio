from datetime import datetime

from pydantic import BaseModel, EmailStr, field_validator

from app.utils.slug import is_valid_username


class RegisterRequest(BaseModel):
    username: str
    email: EmailStr
    password: str

    @field_validator("username")
    @classmethod
    def validate_username(cls, v: str) -> str:
        if not is_valid_username(v.lower()):
            raise ValueError(
                "Username must be 3-30 chars, only lowercase letters/numbers/underscores/hyphens, "
                "and not a reserved word."
            )
        return v.lower()

    @field_validator("password")
    @classmethod
    def validate_password(cls, v: str) -> str:
        if len(v) < 8:
            raise ValueError("Password must be at least 8 characters.")
        return v


class LoginRequest(BaseModel):
    email: EmailStr
    password: str


class UserResponse(BaseModel):
    id: str
    username: str
    email: str
    avatar_url: str | None
    is_admin: bool = False
    created_at: datetime

    # Subscription state. Always present in the response shape so the frontend
    # gating logic doesn't have to deal with `undefined`. Self-hosters get
    # the safe defaults (no paid features); production overlays sync these
    # from an external billing system.
    is_paid_subscriber: bool = False
    subscription_status: str | None = None
    subscription_period_end: datetime | None = None

    model_config = {"from_attributes": True}
