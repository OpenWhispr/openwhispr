from datetime import date, datetime

from sqlalchemy import Date, DateTime, Float, ForeignKey, Integer, String, Text, func
from sqlalchemy.orm import Mapped, mapped_column, relationship

from app.database import Base


class Transaction(Base):
    __tablename__ = "transactions"

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    material_id: Mapped[str] = mapped_column(String(20), ForeignKey("materials.id", ondelete="CASCADE"))
    tx_type: Mapped[str] = mapped_column(String(4))        # "in" | "out"
    qty: Mapped[float] = mapped_column(Float)
    tx_date: Mapped[date] = mapped_column(Date)
    lot_no: Mapped[str | None] = mapped_column(String(60), nullable=True)
    operator: Mapped[str | None] = mapped_column(String(60), nullable=True)
    note: Mapped[str | None] = mapped_column(Text, nullable=True)
    created_at: Mapped[datetime] = mapped_column(DateTime, server_default=func.now())

    material: Mapped["Material"] = relationship("Material", back_populates="transactions")
