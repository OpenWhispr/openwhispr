export type DictationMode = "transcription" | "agent";

export interface HotkeyBinding {
  id: string;
  hotkey: string;
  language: string;
  activationMode: "tap" | "push";
  dictationMode: DictationMode;
}
