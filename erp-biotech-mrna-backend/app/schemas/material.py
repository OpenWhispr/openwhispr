from datetime import datetime
from typing import Optional

from pydantic import BaseModel, ConfigDict

from app.schemas.batch import BatchRead


class MaterialBase(BaseModel):
    name_cn: str
    name_en: str
    sku: str = "—"
    spec: str
    unit: str
    cur_stock: float = 0
    safe_stock: float = 0
    price: float = 0
    cond: str = "室温"
    category: str = "其他"
    supplier: str = "—"
    maker: str = "—"
    country: str = "—"
    alert: Optional[str] = None


class MaterialCreate(MaterialBase):
    id: str   # MAT-XXXX supplied by caller or auto-generated


class MaterialUpdate(BaseModel):
    name_cn: Optional[str] = None
    name_en: Optional[str] = None
    sku: Optional[str] = None
    spec: Optional[str] = None
    unit: Optional[str] = None
    cur_stock: Optional[float] = None
    safe_stock: Optional[float] = None
    price: Optional[float] = None
    cond: Optional[str] = None
    category: Optional[str] = None
    supplier: Optional[str] = None
    maker: Optional[str] = None
    country: Optional[str] = None
    alert: Optional[str] = None


class MaterialRead(MaterialBase):
    model_config = ConfigDict(from_attributes=True)

    id: str
    status: str
    created_at: datetime
    updated_at: datetime


class MaterialDetail(MaterialRead):
    batches: list[BatchRead] = []


class MaterialListItem(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: str
    name_cn: str
    name_en: str
    sku: str
    spec: str
    unit: str
    cur_stock: float
    safe_stock: float
    price: float
    cond: str
    category: str
    supplier: str
    country: str
    status: str
