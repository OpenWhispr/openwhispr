import { NativeModules, Platform } from 'react-native';
import { AppGroupStorage } from '../../modules/app-group-storage/src';
// Snapshot copy of the desktop language registry — see the note in LanguageStep.tsx.
import registry from '@/config/languageRegistry.json';

interface RegistryEntry {
  code: string;
  label: string;
  whisper?: boolean;
}

const SUPPORTED_CODES = new Set(
  (registry.languages as RegistryEntry[])
    .filter((entry) => entry.whisper)
    .map((entry) => entry.code),
);

/**
 * Best-effort detection of the languages this user actually types/speaks, from installed iOS
 * keyboards and system preferred languages. Seeds onboarding's language selection and lets the
 * Parakeet nudge name the user's likely language. Always returns at least one code.
 */
export function detectPreferredLanguages(): string[] {
  const codes = new Set<string>();

  try {
    if (Platform.OS === 'ios') {
      // Installed iOS keyboard languages — picks up Hebrew, Russian, etc.
      // that the user has added as keyboards even if they're not in the
      // preferred-languages list. iOS returns special tags like 'emoji',
      // 'dictation@en-US', and OpenWhispr's own 'mul' tag; matchSupportedCode
      // returns null for them, so they don't pollute the user's selection.
      for (const tag of AppGroupStorage.getActiveInputModes()) {
        const matched = matchSupportedCode(tag);
        if (matched) codes.add(matched);
      }

      // Preferred system languages (Settings → General → Language & Region).
      const appleLanguages: unknown = NativeModules.SettingsManager?.settings?.AppleLanguages;
      if (Array.isArray(appleLanguages)) {
        for (const tag of appleLanguages) {
          if (typeof tag !== 'string') continue;
          const matched = matchSupportedCode(tag);
          if (matched) codes.add(matched);
        }
      }
    }

    if (codes.size === 0) {
      const tag = Intl.DateTimeFormat().resolvedOptions().locale;
      const matched = tag ? matchSupportedCode(tag) : null;
      if (matched) codes.add(matched);
    }
  } catch {
    // fall through
  }

  if (codes.size === 0) codes.add('en');
  return Array.from(codes);
}

/** Maps a BCP-47 tag to a supported registry code ('en-US' → 'en'), or null for non-languages. */
export function matchSupportedCode(tag: string): string | null {
  if (SUPPORTED_CODES.has(tag)) return tag;
  const base = tag.split('-')[0].toLowerCase();
  if (SUPPORTED_CODES.has(base)) return base;
  for (const code of SUPPORTED_CODES) {
    if (code.toLowerCase().startsWith(`${base}-`)) return code;
  }
  return null;
}
