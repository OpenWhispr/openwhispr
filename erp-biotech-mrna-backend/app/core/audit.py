from sqlalchemy.orm import Session

from app.models.audit_log import AuditLog


def log_action(
    db: Session,
    action: str,
    resource_type: str,
    resource_id: str,
    operator: str,
    detail: str = "",
) -> None:
    db.add(AuditLog(
        action=action,
        resource_type=resource_type,
        resource_id=str(resource_id),
        operator=operator,
        detail=detail,
    ))
    # Caller is responsible for db.commit()
