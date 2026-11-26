import { createInferenceModes } from '@/android/lib/inferenceModesCore';
import { createAndroidInferencePolicy } from '../android/inferenceModePolicy';
export type { ModeDescriptor, InferenceScope, CloudAccess } from '@/android/lib/inferenceModesCore';

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
} = createInferenceModes(createAndroidInferencePolicy);
