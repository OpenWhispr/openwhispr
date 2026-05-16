"""
User management — admin only.

GET    /api/v1/users          list all users
POST   /api/v1/users          create user
PUT    /api/v1/users/{id}     update role / full_name / password / is_active
DELETE /api/v1/users/{id}     deactivate (soft delete)
"""
from typing import Optional

from fastapi import APIRouter, Depends, HTTPException, status
from pydantic import BaseModel
from sqlalchemy.orm import Session

from app.core.audit import log_action
from app.core.deps import get_current_user, require_role
from app.core.security import hash_password
from app.database import get_db
from app.models.user import User

router = APIRouter(prefix="/users", tags=["users"])

VALID_ROLES = {"admin", "manager", "operator", "viewer"}


# ── schemas ───────────────────────────────────────────────────────────────────

class UserRead(BaseModel):
    class Config:
        from_attributes = True

    id: int
    username: str
    full_name: str
    role: str
    is_active: bool


class UserCreate(BaseModel):
    username: str
    full_name: str = ""
    role: str = "operator"
    password: str


class UserUpdate(BaseModel):
    full_name: Optional[str] = None
    role: Optional[str] = None
    password: Optional[str] = None
    is_active: Optional[bool] = None


# ── list ──────────────────────────────────────────────────────────────────────

@router.get("", response_model=list[UserRead])
def list_users(
    db: Session = Depends(get_db),
    _: User = Depends(require_role("admin", "manager")),
):
    return db.query(User).order_by(User.id).all()


# ── create ────────────────────────────────────────────────────────────────────

@router.post("", response_model=UserRead, status_code=status.HTTP_201_CREATED)
def create_user(
    body: UserCreate,
    db: Session = Depends(get_db),
    current_user: User = Depends(require_role("admin")),
):
    if body.role not in VALID_ROLES:
        raise HTTPException(status_code=422, detail=f"role must be one of {sorted(VALID_ROLES)}")
    if db.query(User).filter_by(username=body.username).first():
        raise HTTPException(status_code=409, detail=f"Username {body.username!r} already exists")
    u = User(
        username=body.username,
        full_name=body.full_name,
        role=body.role,
        hashed_password=hash_password(body.password),
    )
    db.add(u)
    log_action(db, "CREATE", "user", body.username, current_user.username,
               f"created user {body.username!r} role={body.role}")
    db.commit()
    db.refresh(u)
    return u


# ── update ────────────────────────────────────────────────────────────────────

@router.put("/{user_id}", response_model=UserRead)
def update_user(
    user_id: int,
    body: UserUpdate,
    db: Session = Depends(get_db),
    current_user: User = Depends(require_role("admin")),
):
    u = db.get(User, user_id)
    if u is None:
        raise HTTPException(status_code=404, detail="User not found")
    if body.role and body.role not in VALID_ROLES:
        raise HTTPException(status_code=422, detail=f"role must be one of {sorted(VALID_ROLES)}")

    changes = []
    if body.full_name is not None:
        u.full_name = body.full_name
        changes.append(f"full_name={body.full_name!r}")
    if body.role is not None:
        u.role = body.role
        changes.append(f"role={body.role!r}")
    if body.password is not None:
        u.hashed_password = hash_password(body.password)
        changes.append("password=***")
    if body.is_active is not None:
        u.is_active = body.is_active
        changes.append(f"is_active={body.is_active}")

    log_action(db, "UPDATE", "user", u.username, current_user.username,
               "updated " + ", ".join(changes))
    db.commit()
    db.refresh(u)
    return u


# ── deactivate ────────────────────────────────────────────────────────────────

@router.delete("/{user_id}", status_code=status.HTTP_204_NO_CONTENT)
def deactivate_user(
    user_id: int,
    db: Session = Depends(get_db),
    current_user: User = Depends(require_role("admin")),
):
    u = db.get(User, user_id)
    if u is None:
        raise HTTPException(status_code=404, detail="User not found")
    if u.id == current_user.id:
        raise HTTPException(status_code=400, detail="Cannot deactivate yourself")
    u.is_active = False
    log_action(db, "DELETE", "user", u.username, current_user.username,
               f"deactivated user {u.username!r}")
    db.commit()
