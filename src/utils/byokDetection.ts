import { useSettingsStore } from "../stores/settingsStore";

export const hasStoredByokKey = () => {
  const s = useSettingsStore.getState();
  return !!(
    s.openaiApiKey ||
    s.groqApiKey ||
    s.mistralApiKey ||
    s.openrouterApiKey ||
    s.customTranscriptionApiKey
  );
};
