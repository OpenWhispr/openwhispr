import { ANDROID_LOCAL_MODE_LOCKED, PRIVATE_MODE_LOCKED_REASON } from './aiWorkflows.android';
import type { WorkflowModeRestrictions } from './workflowModeRestrictions';

export const workflowModeRestrictions: WorkflowModeRestrictions = {
  lockedModes: ANDROID_LOCAL_MODE_LOCKED,
  lockedReason: PRIVATE_MODE_LOCKED_REASON,
};
