import type { PermissionGuideId, PermissionGuideProgress } from "../../types/permissionGuide";

export function isPermissionGuideId(value: unknown): value is PermissionGuideId {
  return (
    typeof value === "string" &&
    ["microphone", "accessibility", "system-audio", "screen-context"].includes(value)
  );
}

export function parsePermissionGuideProgress(value: unknown): PermissionGuideProgress | null {
  if (!value || typeof value !== "object" || !("current" in value)) return null;
  if (!isPermissionGuideId(value.current)) return null;
  return { current: value.current };
}
