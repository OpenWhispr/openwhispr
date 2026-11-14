import type { KeyboardLetterLayout } from '@/types';

// Keep the values in step with KeyboardLetterLayout in
// plugins/keyboard-extension/ios/KeyboardViewController.swift; a test checks both lists.
export const KEYBOARD_LETTER_LAYOUTS: {
  value: KeyboardLetterLayout;
  label: string;
  description: string;
}[] = [
  { value: 'en', label: 'English', description: 'QWERTY' },
  { value: 'de', label: 'German', description: 'QWERTZ with ü, ö and ä' },
  { value: 'fr_CH', label: 'Swiss French', description: 'QWERTZ with è, é and à' },
];

export const DEFAULT_KEYBOARD_LETTER_LAYOUT: KeyboardLetterLayout = 'en';

const VALID = new Set<string>(KEYBOARD_LETTER_LAYOUTS.map((layout) => layout.value));

export function coerceLetterLayout(value: string | null | undefined): KeyboardLetterLayout {
  return value && VALID.has(value)
    ? (value as KeyboardLetterLayout)
    : DEFAULT_KEYBOARD_LETTER_LAYOUT;
}

export function letterLayoutLabel(value: KeyboardLetterLayout): string {
  return KEYBOARD_LETTER_LAYOUTS.find((layout) => layout.value === value)?.label ?? 'English';
}
