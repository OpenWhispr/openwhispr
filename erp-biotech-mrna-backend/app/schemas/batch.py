from datetime import date
from typing import Optional

from pydantic import BaseModel, ConfigDict


class BatchBase(BaseModel):
    lot_no: str
    mfg_date: Optional[date] = None
    exp_date: Optional[date] = None
    qty: float = 0


class BatchCreate(BatchBase):
    pass


class BatchUpdate(BaseModel):
    lot_no: Optional[str] = None
    mfg_date: Optional[date] = None
    exp_date: Optional[date] = None
    qty: Optional[float] = None


class BatchRead(BatchBase):
    model_config = ConfigDict(from_attributes=True)

    id: int
    material_id: str
    days_remaining: Optional[int] = None
    status: str
