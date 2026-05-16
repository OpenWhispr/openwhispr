"""
Transactions — global ledger view.

GET /api/v1/transactions   filterable by material, type, date range
"""
from datetime import date
from typing import Literal, Optional

from fastapi import APIRouter, Depends, Query
from sqlalchemy.orm import Session

from app.core.deps import get_current_user
from app.database import get_db
from app.models.transaction import Transaction
from app.models.user import User
from app.schemas.transaction import TransactionRead

router = APIRouter(prefix="/transactions", tags=["transactions"])


@router.get("", response_model=list[TransactionRead])
def list_transactions(
    material_id: Optional[str] = Query(None),
    tx_type: Optional[Literal["in", "out"]] = Query(None),
    date_from: Optional[date] = Query(None),
    date_to: Optional[date] = Query(None),
    page: int = Query(1, ge=1),
    page_size: int = Query(50, ge=1, le=500),
    db: Session = Depends(get_db),
    _: User = Depends(get_current_user),
):
    q = db.query(Transaction)
    if material_id:
        q = q.filter(Transaction.material_id == material_id)
    if tx_type:
        q = q.filter(Transaction.tx_type == tx_type)
    if date_from:
        q = q.filter(Transaction.tx_date >= date_from)
    if date_to:
        q = q.filter(Transaction.tx_date <= date_to)

    return (
        q.order_by(Transaction.tx_date.desc(), Transaction.id.desc())
        .offset((page - 1) * page_size)
        .limit(page_size)
        .all()
    )
