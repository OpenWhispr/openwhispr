import { createWorkflowModeSwitch } from './workflowModeSwitchCore';
import {
  androidWorkflowSwitchPolicy,
  createAndroidPrivateModeToggle,
} from '../android/workflowSwitch';
export type { ModeSwitchResult } from './workflowModeSwitchCore';

export const { switchWorkflowMode, pickLocalModel } = createWorkflowModeSwitch(
  androidWorkflowSwitchPolicy,
);

export const setPrivateMode = createAndroidPrivateModeToggle(switchWorkflowMode);
