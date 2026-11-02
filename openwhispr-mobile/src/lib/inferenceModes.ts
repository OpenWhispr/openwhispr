import { createInferenceModes } from './inferenceModesCore';
export type { ModeDescriptor, InferenceScope, CloudAccess } from './inferenceModesCore';

export const {
  getInferenceModes,
  MODE_LABELS,
  localModeDefault,
  localSelection,
  dictationModeConfig,
  workflowSaveConfig,
  holdOnDeviceConfig,
  localModeUpgradeConfig,
  noteChatSplitConfig,
  notesLocalModeSplitConfig,
} = createInferenceModes();
