// Corti is the only STT engine — whisper.cpp was removed.
// This hook is kept as a no-op stub so existing call sites compile until they
// can be deleted.

export interface UseWhisperReturn {
  whisperInstalled: boolean;
  checkingWhisper: boolean;
  checkWhisperInstallation: () => Promise<void>;
}

export const useWhisper = (): UseWhisperReturn => ({
  whisperInstalled: false,
  checkingWhisper: false,
  checkWhisperInstallation: async () => {},
});
