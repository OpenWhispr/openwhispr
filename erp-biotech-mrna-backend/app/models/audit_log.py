from datetime import datetime

from sqlalchemy import DateTime, Integer, String, Text, func
from sqlalchemy.orm import Mapped, mapped_column

from app.database import Base


class AuditLog(Base):
    __tablename__ = "audit_logs"

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    action: Mapped[str] = mapped_column(String(30))        # CREATE UPDATE DELETE INBOUND OUTBOUND LOGIN
    resource_type: Mapped[str] = mapped_column(String(30)) # material batch transaction user
    resource_id: Mapped[str] = mapped_column(String(60), default="")
    operator: Mapped[str] = mapped_column(String(60), default="")
    detail: Mapped[str] = mapped_column(Text, default="")  # human-readable summary
    created_at: Mapped[datetime] = mapped_column(DateTime, server_default=func.now(), index=True)
