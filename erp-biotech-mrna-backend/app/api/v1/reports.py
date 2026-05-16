"""
Reports — analytical endpoints (mirrors HTML Step 7).

GET /api/v1/reports/summary      high-level totals
GET /api/v1/reports/trends       monthly in/out volumes
GET /api/v1/reports/turnover     per-material turnover rate
GET /api/v1/reports/expiry       batches expiring within N days
GET /api/v1/reports/low-stock    materials below safety threshold
"""
from collections import defaultdict
from datetime import date, timedelta
from typing import Optional

from fastapi import APIRouter, Depends, Query
from sqlalchemy.orm import Session

from app.core.deps import get_current_user
from app.database import get_db
from app.models.batch import Batch
from app.models.material import Material
from app.models.transaction import Transaction
from app.models.user import User

router = APIRouter(prefix="/reports", tags=["reports"])


@router.get("/summary")
def summary(
    db: Session = Depends(get_db),
    _: User = Depends(get_current_user),
):
    materials = db.query(Material).all()
    batches = db.query(Batch).all()
    txs = db.query(Transaction).all()

    total_value = sum(m.cur_stock * m.price for m in materials)
    in_qty = sum(t.qty for t in txs if t.tx_type == "in")
    out_qty = sum(t.qty for t in txs if t.tx_type == "out")

    return {
        "total_materials": len(materials),
        "total_batches": len(batches),
        "total_transactions": len(txs),
        "total_inventory_value": round(total_value, 2),
        "total_in_qty": in_qty,
        "total_out_qty": out_qty,
    }


@router.get("/trends")
def trends(
    months: int = Query(6, ge=1, le=24),
    db: Session = Depends(get_db),
    _: User = Depends(get_current_user),
):
    """Monthly in/out totals for the last N months."""
    start = date.today().replace(day=1) - timedelta(days=30 * (months - 1))
    txs = db.query(Transaction).filter(Transaction.tx_date >= start).all()

    monthly: dict[str, dict] = defaultdict(lambda: {"month": "", "in_qty": 0, "out_qty": 0, "in_count": 0, "out_count": 0})
    for t in txs:
        key = t.tx_date.strftime("%Y-%m")
        monthly[key]["month"] = key
        if t.tx_type == "in":
            monthly[key]["in_qty"] += t.qty
            monthly[key]["in_count"] += 1
        else:
            monthly[key]["out_qty"] += t.qty
            monthly[key]["out_count"] += 1

    return sorted(monthly.values(), key=lambda x: x["month"])


@router.get("/turnover")
def turnover(
    db: Session = Depends(get_db),
    _: User = Depends(get_current_user),
):
    """
    Turnover rate = total out qty / average stock.
    Only returns materials with at least one outbound transaction.
    """
    materials = {m.id: m for m in db.query(Material).all()}
    txs = db.query(Transaction).filter(Transaction.tx_type == "out").all()

    out_by_mat: dict[str, float] = defaultdict(float)
    for t in txs:
        out_by_mat[t.material_id] += t.qty

    result = []
    for mat_id, out_qty in out_by_mat.items():
        m = materials.get(mat_id)
        if m is None:
            continue
        avg_stock = (m.cur_stock + m.safe_stock) / 2 or 1
        rate = round(out_qty / avg_stock, 2)
        result.append({
            "material_id": mat_id,
            "name_cn": m.name_cn,
            "name_en": m.name_en,
            "out_qty": out_qty,
            "cur_stock": m.cur_stock,
            "turnover_rate": rate,
        })

    result.sort(key=lambda x: x["turnover_rate"], reverse=True)
    return result


@router.get("/expiry")
def expiry_report(
    within_days: int = Query(90, ge=0, le=365),
    db: Session = Depends(get_db),
    _: User = Depends(get_current_user),
):
    today = date.today()
    cutoff = today + timedelta(days=within_days)
    batches = (
        db.query(Batch)
        .filter(Batch.exp_date != None, Batch.exp_date <= cutoff)
        .order_by(Batch.exp_date)
        .all()
    )
    return [
        {
            "batch_id": b.id,
            "material_id": b.material_id,
            "name_cn": b.material.name_cn,
            "lot_no": b.lot_no,
            "exp_date": b.exp_date.isoformat() if b.exp_date else None,
            "days_remaining": b.days_remaining,
            "qty": b.qty,
            "unit": b.material.unit,
            "status": b.status,
        }
        for b in batches
    ]


@router.get("/low-stock")
def low_stock(
    db: Session = Depends(get_db),
    _: User = Depends(get_current_user),
):
    materials = db.query(Material).all()
    result = []
    for m in materials:
        if m.safe_stock and m.cur_stock < m.safe_stock:
            gap = m.safe_stock - m.cur_stock
            pct = round(m.cur_stock / m.safe_stock * 100) if m.safe_stock else 100
            result.append({
                "material_id": m.id,
                "name_cn": m.name_cn,
                "name_en": m.name_en,
                "sku": m.sku,
                "cur_stock": m.cur_stock,
                "safe_stock": m.safe_stock,
                "gap": gap,
                "unit": m.unit,
                "pct": pct,
                "supplier": m.supplier,
                "status": m.status,
            })
    result.sort(key=lambda x: x["pct"])
    return result
