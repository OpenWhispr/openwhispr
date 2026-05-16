from datetime import date, datetime
from typing import Literal, Optional

from pydantic import BaseModel, ConfigDict, field_validator


class TransactionCreate(BaseModel):
    tx_type: Literal["in", "out"]
    qty: float
    tx_date: date
    lot_no: Optional[str] = None
    operator: Optional[str] = None
    note: Optional[str] = None

    @field_validator("qty")
    @classmethod
    def qty_positive(cls, v: float) -> float:
        if v <= 0:
            raise ValueError("qty must be positive")
        return v


class TransactionRead(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: int
    material_id: str
    tx_type: str
    qty: float
    tx_date: date
    lot_no: Optional[str] = None
    operator: Optional[str] = None
    note: Optional[str] = None
    created_at: datetime
