import {
  getEffectiveCleanupModel,
  isCloudCleanupMode,
  useSettingsStore,
} from "../../stores/settingsStore";

// Tone & Style only changes what cleanup writes, so its entry points turn
// cleanup on and check that it can run.
export function turnOnDictationCleanup() {
  useSettingsStore.getState().updateCleanupSettings({ useCleanupModel: true });
}

// Turning cleanup on doesn't give it a model; Cloud needs none.
export function dictationCleanupHasModel() {
  return !!getEffectiveCleanupModel() || isCloudCleanupMode();
}
