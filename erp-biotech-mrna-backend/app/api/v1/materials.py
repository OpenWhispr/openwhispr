"""
Materials — CRUD + inventory in/out operations.

GET    /api/v1/materials            list (paginated, filterable)
POST   /api/v1/materials            create
GET    /api/v1/materials/{id}       detail with batches
PUT    /api/v1/materials/{id}       update fields
DELETE /api/v1/materials/{id}       soft-delete (sets cur_stock = -1) — admin only
POST   /api/v1/materials/{id}/inbound   stock-in transaction
POST   /api/v1/materials/{id}/outbound  stock-out transaction
GET    /api/v1/materials/{id}/transactions  transaction history
"""
from typing import Literal, Optional

from fastapi import APIRouter, Depends, HTTPException, Query, status
from sqlalchemy import or_
from sqlalchemy.orm import Session

from app.core.audit import log_action
from app.core.deps import get_current_user, require_role
from app.database import get_db
from app.models.batch import Batch
from app.models.material import Material
from app.models.transaction import Transaction
from app.models.user import User
from app.schemas.material import MaterialCreate, MaterialDetail, MaterialListItem, MaterialUpdate
from app.schemas.transaction import TransactionCreate, TransactionRead

router = APIRouter(prefix="/materials", tags=["materials"])


# ── helpers ──────────────────────────────────────────────────────────────────

def _get_or_404(mat_id: str, db: Session) -> Material:
    m = db.get(Material, mat_id)
    if m is None:
        raise HTTPException(status_code=404, detail=f"Material {mat_id!r} not found")
    return m


def _next_id(db: Session) -> str:
    from sqlalchemy import func
    row = db.query(func.max(Material.id)).scalar()
    if row is None:
        return "MAT-0001"
    try:
        num = int(row.split("-")[1]) + 1
    except (IndexError, ValueError):
        num = 1
    return f"MAT-{num:04d}"


# ── list ─────────────────────────────────────────────────────────────────────

@router.get("", response_model=dict)
def list_materials(
    q: Optional[str] = Query(None, description="Search name_cn / name_en / id / sku"),
    category: Optional[str] = Query(None),
    status: Optional[Literal["ok", "warn", "crit"]] = Query(None),
    cond: Optional[str] = Query(None),
    supplier: Optional[str] = Query(None),
    page: int = Query(1, ge=1),
    page_size: int = Query(20, ge=1, le=200),
    db: Session = Depends(get_db),
    _: User = Depends(get_current_user),
):
    q_obj = db.query(Material)

    if q:
        like = f"%{q}%"
        q_obj = q_obj.filter(
            or_(
                Material.name_cn.ilike(like),
                Material.name_en.ilike(like),
                Material.id.ilike(like),
                Material.sku.ilike(like),
            )
        )
    if category:
        q_obj = q_obj.filter(Material.category == category)
    if cond:
        q_obj = q_obj.filter(Material.cond == cond)
    if supplier:
        q_obj = q_obj.filter(Material.supplier == supplier)

    total = q_obj.count()
    items = q_obj.offset((page - 1) * page_size).limit(page_size).all()

    # Status filter applied in Python (computed property)
    if status:
        items = [m for m in items if m.status == status]

    return {
        "total": total,
        "page": page,
        "page_size": page_size,
        "items": [MaterialListItem.model_validate(m) for m in items],
    }


# ── create ───────────────────────────────────────────────────────────────────

@router.post("", response_model=MaterialDetail, status_code=status.HTTP_201_CREATED)
def create_material(
    body: MaterialCreate,
    db: Session = Depends(get_db),
    current_user: User = Depends(require_role("admin", "manager")),
):
    mat_id = body.id or _next_id(db)
    if db.get(Material, mat_id):
        raise HTTPException(status_code=409, detail=f"Material {mat_id!r} already exists")
    m = Material(**body.model_dump())
    m.id = mat_id
    db.add(m)
    log_action(db, "CREATE", "material", mat_id, current_user.username,
               f"created {body.name_cn} ({body.name_en})")
    db.commit()

    db.refresh(m)
    return m


# ── detail ───────────────────────────────────────────────────────────────────

@router.get("/{mat_id}", response_model=MaterialDetail)
def get_material(
    mat_id: str,
    db: Session = Depends(get_db),
    _: User = Depends(get_current_user),
):
    return _get_or_404(mat_id, db)


# ── update ───────────────────────────────────────────────────────────────────

@router.put("/{mat_id}", response_model=MaterialDetail)
def update_material(
    mat_id: str,
    body: MaterialUpdate,
    db: Session = Depends(get_db),
    current_user: User = Depends(require_role("admin", "manager")),
):
    m = _get_or_404(mat_id, db)
    changes = {k: v for k, v in body.model_dump(exclude_none=True).items()}
    for field, value in changes.items():
        setattr(m, field, value)
    log_action(db, "UPDATE", "material", mat_id, current_user.username,
               "updated " + ", ".join(f"{k}={v}" for k, v in changes.items()))
    db.commit()
    db.refresh(m)
    return m


# ── delete ───────────────────────────────────────────────────────────────────

@router.delete("/{mat_id}", status_code=status.HTTP_204_NO_CONTENT)
def delete_material(
    mat_id: str,
    db: Session = Depends(get_db),
    current_user: User = Depends(require_role("admin")),
):
    m = _get_or_404(mat_id, db)
    log_action(db, "DELETE", "material", mat_id, current_user.username,
               f"deleted {m.name_cn} ({mat_id})")
    db.delete(m)
    db.commit()


# ── inbound ──────────────────────────────────────────────────────────────────

@router.post("/{mat_id}/inbound", response_model=TransactionRead, status_code=status.HTTP_201_CREATED)
def inbound(
    mat_id: str,
    body: TransactionCreate,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    m = _get_or_404(mat_id, db)
    if body.tx_type != "in":
        raise HTTPException(status_code=422, detail="tx_type must be 'in' for inbound")

    m.cur_stock += body.qty

    # Upsert batch if lot_no provided
    if body.lot_no:
        batch = db.query(Batch).filter_by(material_id=mat_id, lot_no=body.lot_no).first()
        if batch:
            batch.qty += body.qty
        else:
            db.add(Batch(material_id=mat_id, lot_no=body.lot_no, qty=body.qty))

    tx = Transaction(
        material_id=mat_id,
        tx_type="in",
        qty=body.qty,
        tx_date=body.tx_date,
        lot_no=body.lot_no,
        operator=body.operator or current_user.username,
        note=body.note,
    )
    db.add(tx)
    log_action(db, "INBOUND", "material", mat_id, current_user.username,
               f"入库 {body.qty} {m.unit}, lot={body.lot_no or '-'}, note={body.note or '-'}")
    db.commit()
    db.refresh(tx)
    return tx


# ── outbound ─────────────────────────────────────────────────────────────────

@router.post("/{mat_id}/outbound", response_model=TransactionRead, status_code=status.HTTP_201_CREATED)
def outbound(
    mat_id: str,
    body: TransactionCreate,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    m = _get_or_404(mat_id, db)
    if body.tx_type != "out":
        raise HTTPException(status_code=422, detail="tx_type must be 'out' for outbound")
    if m.cur_stock < body.qty:
        raise HTTPException(status_code=400, detail="Insufficient stock")

    m.cur_stock -= body.qty

    if body.lot_no:
        batch = db.query(Batch).filter_by(material_id=mat_id, lot_no=body.lot_no).first()
        if batch:
            batch.qty = max(0, batch.qty - body.qty)

    tx = Transaction(
        material_id=mat_id,
        tx_type="out",
        qty=body.qty,
        tx_date=body.tx_date,
        lot_no=body.lot_no,
        operator=body.operator or current_user.username,
        note=body.note,
    )
    db.add(tx)
    log_action(db, "OUTBOUND", "material", mat_id, current_user.username,
               f"出库 {body.qty} {m.unit}, lot={body.lot_no or '-'}, note={body.note or '-'}")
    db.commit()
    db.refresh(tx)
    return tx


# ── transaction history ───────────────────────────────────────────────────────

@router.get("/{mat_id}/transactions", response_model=list[TransactionRead])
def get_transactions(
    mat_id: str,
    limit: int = Query(50, ge=1, le=500),
    db: Session = Depends(get_db),
    _: User = Depends(get_current_user),
):
    _get_or_404(mat_id, db)
    txs = (
        db.query(Transaction)
        .filter_by(material_id=mat_id)
        .order_by(Transaction.tx_date.desc(), Transaction.id.desc())
        .limit(limit)
        .all()
    )
    return txs
