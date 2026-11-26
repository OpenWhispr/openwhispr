import { createWorkflowModeSwitch } from '@/android/lib/workflowModeSwitchCore';
import {
  androidWorkflowSwitchPolicy,
  createAndroidPrivateModeToggle,
} from '../android/workflowSwitch';
export type { ModeSwitchResult } from '@/android/lib/workflowModeSwitchCore';

export const { switchWorkflowMode, pickLocalModel } = createWorkflowModeSwitch(
  androidWorkflowSwitchPolicy,
);

export const setPrivateMode = createAndroidPrivateModeToggle(switchWorkflowMode);
