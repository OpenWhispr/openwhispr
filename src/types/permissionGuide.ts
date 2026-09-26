export type PermissionGuideId = "microphone" | "accessibility" | "system-audio" | "screen-context";

export interface PermissionGuideProgress {
  current: PermissionGuideId;
}

export interface PermissionGuideState {
  sessionId: string;
  permission: PermissionGuideId;
  granted: boolean;
  needsRelaunch: boolean;
  busy: boolean;
  error: boolean;
  canDrag?: boolean;
  appIcon?: string;
}

export interface PermissionGuideAction {
  sessionId: string;
  permission: PermissionGuideId;
  action: "check" | "settings" | "close" | "restart";
}
