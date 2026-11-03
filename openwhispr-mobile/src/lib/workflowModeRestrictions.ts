import type { InferenceMode } from '@/types';
import type { MobileInferenceScope } from './mobileProviders';

export interface WorkflowModeRestrictions {
  lockedModes: Partial<Record<MobileInferenceScope, InferenceMode[]>>;
  lockedReason: string;
}
export const workflowModeRestrictions: WorkflowModeRestrictions = {
  lockedModes: {},
  lockedReason: 'Off while Local Mode is on. Change Dictation in AI Models to turn it off.',
};
