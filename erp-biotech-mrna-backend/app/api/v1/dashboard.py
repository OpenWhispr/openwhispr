"""
Dashboard — summary stats + alert list (mirrors the HTML Step 5 dashboard).

GET /api/v1/dashboard/stats
GET /api/v1/dashboard/alerts
"""
from datetime import date

from fastapi import APIRouter, Depends
from sqlalchemy.orm import Session

from app.core.deps import get_current_user
from app.database import get_db
from app.models.batch import Batch
from app.models.material import Material
from app.models.transaction import Transaction
from app.models.user import User

router = APIRouter(prefix="/dashboard", tags=["dashboard"])


@router.get("/stats")
def get_stats(
    db: Session = Depends(get_db),
    _: User = Depends(get_current_user),
):
    materials = db.query(Material).all()
    total = len(materials)
    crit_count = sum(1 for m in materials if m.status == "crit")
    warn_count = sum(1 for m in materials if m.status == "warn")
    ok_count = total - crit_count - warn_count

    today = date.today()
    batches = db.query(Batch).all()
    expiring_30 = sum(
        1 for b in batches
        if b.exp_date and 0 < (b.exp_date - today).days <= 30
    )
    expired = sum(1 for b in batches if b.exp_date and b.exp_date < today)

    # Supplier diversity
    suppliers = {m.supplier for m in materials if m.supplier != "—"}

    return {
        "total_materials": total,
        "crit_count": crit_count,
        "warn_count": warn_count,
        "ok_count": ok_count,
        "expiring_30d": expiring_30,
        "expired_batches": expired,
        "supplier_count": len(suppliers),
        "total_batches": len(batches),
    }


@router.get("/alerts")
def get_alerts(
    db: Session = Depends(get_db),
    _: User = Depends(get_current_user),
):
    """
    Returns a prioritised alert list combining:
    - Zero-stock materials  (sev: crit)
    - Below-safe-stock materials (sev: low)
    - Expired batches (sev: over)
    - Batches expiring within 90 days (sev: exp)
    """
    materials = {m.id: m for m in db.query(Material).all()}
    today = date.today()
    alerts = []

    for mat_id, m in materials.items():
        safe = m.safe_stock or 0

        if m.cur_stock <= 0:
            alerts.append({
                "id": mat_id,
                "sev": "crit",
                "sev_label": "零库存",
                "name_cn": m.name_cn,
                "name_en": m.name_en,
                "sku": m.sku,
                "cur_stock": m.cur_stock,
                "safe_stock": safe,
                "unit": m.unit,
                "pct": 0,
                "msg": f"缺口 {safe} {m.unit}",
                "supplier": m.supplier,
                "filter": "crit",
            })
        elif safe > 0 and m.cur_stock < safe:
            pct = round(m.cur_stock / safe * 100)
            alerts.append({
                "id": mat_id,
                "sev": "low",
                "sev_label": "低库存",
                "name_cn": m.name_cn,
                "name_en": m.name_en,
                "sku": m.sku,
                "cur_stock": m.cur_stock,
                "safe_stock": safe,
                "unit": m.unit,
                "pct": pct,
                "msg": f"缺口 {safe - m.cur_stock} {m.unit}",
                "supplier": m.supplier,
                "filter": "low",
            })

        for b in m.batches:
            if b.exp_date is None:
                continue
            days = (b.exp_date - today).days
            if days <= 0:
                alerts.append({
                    "id": mat_id,
                    "sev": "over",
                    "sev_label": "已过效期",
                    "name_cn": m.name_cn,
                    "name_en": m.name_en,
                    "sku": m.sku,
                    "cur_stock": m.cur_stock,
                    "safe_stock": safe,
                    "unit": m.unit,
                    "pct": round(m.cur_stock / safe * 100) if safe else 100,
                    "msg": f"批次 {b.lot_no} · 已过期 {abs(days)} 天",
                    "supplier": m.supplier,
                    "filter": "exp",
                    "batch": b.lot_no,
                })
            elif days <= 90:
                alerts.append({
                    "id": mat_id,
                    "sev": "exp",
                    "sev_label": "临近效期",
                    "name_cn": m.name_cn,
                    "name_en": m.name_en,
                    "sku": m.sku,
                    "cur_stock": m.cur_stock,
                    "safe_stock": safe,
                    "unit": m.unit,
                    "pct": round(m.cur_stock / safe * 100) if safe else 100,
                    "msg": f"批次 {b.lot_no} · 剩余 {days} 天",
                    "supplier": m.supplier,
                    "filter": "exp",
                    "batch": b.lot_no,
                })

    # Sort: crit > over > low > exp, then by days ascending inside exp
    sev_order = {"crit": 0, "over": 1, "low": 2, "exp": 3}
    alerts.sort(key=lambda a: sev_order.get(a["sev"], 9))
    return alerts
