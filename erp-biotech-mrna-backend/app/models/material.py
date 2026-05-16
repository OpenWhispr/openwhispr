from datetime import datetime

from sqlalchemy import DateTime, Float, Integer, String, Text, func
from sqlalchemy.orm import Mapped, mapped_column, relationship

from app.database import Base


class Material(Base):
    __tablename__ = "materials"

    id: Mapped[str] = mapped_column(String(20), primary_key=True)          # MAT-XXXX
    name_cn: Mapped[str] = mapped_column(String(120))
    name_en: Mapped[str] = mapped_column(String(120))
    sku: Mapped[str] = mapped_column(String(60), default="—")
    spec: Mapped[str] = mapped_column(String(40))                           # e.g. 100mL, 500g
    unit: Mapped[str] = mapped_column(String(10))                           # 瓶/桶/袋
    cur_stock: Mapped[float] = mapped_column(Float, default=0)
    safe_stock: Mapped[float] = mapped_column(Float, default=0)
    price: Mapped[float] = mapped_column(Float, default=0)
    cond: Mapped[str] = mapped_column(String(20), default="室温")           # 4°C / 室温 / -20°C / -80°C
    category: Mapped[str] = mapped_column(String(60), default="其他")
    supplier: Mapped[str] = mapped_column(String(80), default="—")
    maker: Mapped[str] = mapped_column(String(160), default="—")
    country: Mapped[str] = mapped_column(String(4), default="—")            # ISO-2
    alert: Mapped[str | None] = mapped_column(Text, nullable=True)
    created_at: Mapped[datetime] = mapped_column(DateTime, server_default=func.now())
    updated_at: Mapped[datetime] = mapped_column(DateTime, server_default=func.now(), onupdate=func.now())

    batches: Mapped[list["Batch"]] = relationship(
        "Batch", back_populates="material", cascade="all, delete-orphan", order_by="Batch.exp_date"
    )
    transactions: Mapped[list["Transaction"]] = relationship(
        "Transaction", back_populates="material", cascade="all, delete-orphan", order_by="Transaction.tx_date.desc()"
    )

    @property
    def status(self) -> str:
        if self.cur_stock <= 0:
            return "crit"
        ratio = self.cur_stock / self.safe_stock if self.safe_stock else 1
        if ratio < 0.5:
            return "crit"
        if ratio < 1.0:
            return "warn"
        return "ok"
