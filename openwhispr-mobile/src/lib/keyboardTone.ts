import type { KeyboardTone, ProcessingMode } from '@/types';

export const KEYBOARD_TONES: { value: KeyboardTone; label: string; description: string }[] = [
  { value: 'default', label: 'Default', description: 'Standard cleanup, no tone change' },
  { value: 'formal', label: 'Formal', description: 'Professional and polished' },
  { value: 'casual', label: 'Casual', description: 'Relaxed and conversational' },
  { value: 'very_casual', label: 'Very Casual', description: 'Loose and informal' },
  { value: 'excited', label: 'Excited', description: 'Energetic and enthusiastic' },
];

export const DEFAULT_KEYBOARD_TONE: KeyboardTone = 'default';

// Tone is only meaningful when the cloud cleanup step runs. Private mode never
// sends text to an LLM, and cleanup-off skips the rewrite entirely.
export function isToneApplicable(
  mode: ProcessingMode,
  cleanupEnabled: boolean | undefined,
): boolean {
  return mode === 'cloud' && (cleanupEnabled ?? true);
}

export function toneLabel(value: KeyboardTone): string {
  return KEYBOARD_TONES.find((tone) => tone.value === value)?.label ?? 'Default';
}
