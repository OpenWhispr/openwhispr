from datetime import date, datetime

from sqlalchemy import Date, DateTime, Float, ForeignKey, Integer, String, func
from sqlalchemy.orm import Mapped, mapped_column, relationship

from app.database import Base


class Batch(Base):
    __tablename__ = "batches"

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    material_id: Mapped[str] = mapped_column(String(20), ForeignKey("materials.id", ondelete="CASCADE"))
    lot_no: Mapped[str] = mapped_column(String(60))
    mfg_date: Mapped[date | None] = mapped_column(Date, nullable=True)
    exp_date: Mapped[date | None] = mapped_column(Date, nullable=True)
    qty: Mapped[float] = mapped_column(Float, default=0)
    created_at: Mapped[datetime] = mapped_column(DateTime, server_default=func.now())

    material: Mapped["Material"] = relationship("Material", back_populates="batches")

    @property
    def days_remaining(self) -> int | None:
        if self.exp_date is None:
            return None
        return (self.exp_date - date.today()).days

    @property
    def status(self) -> str:
        d = self.days_remaining
        if d is None:
            return "ok"
        if d <= 0:
            return "over"
        if d <= 30:
            return "crit"
        if d <= 90:
            return "warn"
        return "ok"
