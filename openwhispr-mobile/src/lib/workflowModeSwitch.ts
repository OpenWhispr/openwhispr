import { createWorkflowModeSwitch } from './workflowModeSwitchCore';
export type { ModeSwitchResult } from './workflowModeSwitchCore';

export const { switchWorkflowMode, pickLocalModel } = createWorkflowModeSwitch();
