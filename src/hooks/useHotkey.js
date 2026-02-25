import { useSettingsStore } from "../stores/settingsStore";
import { getDefaultHotkey } from "../utils/hotkeys";

export const useHotkey = () => {
  const hotkey = useSettingsStore((s) => s.dictationKey) || getDefaultHotkey();
  const setHotkey = useSettingsStore((s) => s.setDictationKey);

  return {
    hotkey,
    setHotkey,
  };
};
