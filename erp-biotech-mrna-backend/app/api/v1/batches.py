"""
Batches — cross-material batch queries.

GET  /api/v1/batches           all batches (filterable by expiry / status)
GET  /api/v1/batches/{id}      single batch
PUT  /api/v1/batches/{id}      update lot metadata
DELETE /api/v1/batches/{id}    remove batch record
"""
from typing import Literal, Optional

from fastapi import APIRouter, Depends, HTTPException, Query, status
from sqlalchemy.orm import Session

from app.core.deps import get_current_user, require_role
from app.database import get_db
from app.models.batch import Batch
from app.models.user import User
from app.schemas.batch import BatchRead, BatchUpdate

router = APIRouter(prefix="/batches", tags=["batches"])


def _get_or_404(batch_id: int, db: Session) -> Batch:
    b = db.get(Batch, batch_id)
    if b is None:
        raise HTTPException(status_code=404, detail=f"Batch {batch_id} not found")
    return b


@router.get("", response_model=list[BatchRead])
def list_batches(
    material_id: Optional[str] = Query(None),
    status: Optional[Literal["ok", "warn", "crit", "over"]] = Query(None),
    expiring_within_days: Optional[int] = Query(None, ge=0),
    limit: int = Query(200, ge=1, le=1000),
    db: Session = Depends(get_db),
    _: User = Depends(get_current_user),
):
    q = db.query(Batch)
    if material_id:
        q = q.filter(Batch.material_id == material_id)

    batches = q.order_by(Batch.exp_date).limit(limit).all()

    if status:
        batches = [b for b in batches if b.status == status]
    if expiring_within_days is not None:
        batches = [b for b in batches if b.days_remaining is not None and 0 <= b.days_remaining <= expiring_within_days]

    return batches


@router.get("/{batch_id}", response_model=BatchRead)
def get_batch(
    batch_id: int,
    db: Session = Depends(get_db),
    _: User = Depends(get_current_user),
):
    return _get_or_404(batch_id, db)


@router.put("/{batch_id}", response_model=BatchRead)
def update_batch(
    batch_id: int,
    body: BatchUpdate,
    db: Session = Depends(get_db),
    _: User = Depends(require_role("admin", "manager")),
):
    b = _get_or_404(batch_id, db)
    for field, value in body.model_dump(exclude_none=True).items():
        setattr(b, field, value)
    db.commit()
    db.refresh(b)
    return b


@router.delete("/{batch_id}", status_code=status.HTTP_204_NO_CONTENT)
def delete_batch(
    batch_id: int,
    db: Session = Depends(get_db),
    _: User = Depends(require_role("admin", "manager")),
):
    b = _get_or_404(batch_id, db)
    db.delete(b)
    db.commit()
