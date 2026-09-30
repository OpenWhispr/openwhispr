export type LanguageCode = string;

export type Language = {
  code: LanguageCode;
  label: string;
  flag: string;
};

export const DEFAULT_LANGUAGE: LanguageCode = 'auto';

export const LANGUAGES: Language[] = [
  { code: 'auto', label: 'Auto-detect', flag: '🌐' },
  { code: 'af', label: 'Afrikaans', flag: '🇿🇦' },
  { code: 'ar', label: 'Arabic', flag: '🇸🇦' },
  { code: 'hy', label: 'Armenian', flag: '🇦🇲' },
  { code: 'az', label: 'Azerbaijani', flag: '🇦🇿' },
  { code: 'be', label: 'Belarusian', flag: '🇧🇾' },
  { code: 'bs', label: 'Bosnian', flag: '🇧🇦' },
  { code: 'bg', label: 'Bulgarian', flag: '🇧🇬' },
  { code: 'ca', label: 'Catalan', flag: '🇪🇸' },
  { code: 'zh-CN', label: 'Chinese (Simplified)', flag: '🇨🇳' },
  { code: 'zh-TW', label: 'Chinese (Traditional)', flag: '🇹🇼' },
  { code: 'hr', label: 'Croatian', flag: '🇭🇷' },
  { code: 'cs', label: 'Czech', flag: '🇨🇿' },
  { code: 'da', label: 'Danish', flag: '🇩🇰' },
  { code: 'nl', label: 'Dutch', flag: '🇳🇱' },
  { code: 'en-US', label: 'English (US)', flag: '🇺🇸' },
  { code: 'en-GB', label: 'English (UK)', flag: '🇬🇧' },
  { code: 'et', label: 'Estonian', flag: '🇪🇪' },
  { code: 'fi', label: 'Finnish', flag: '🇫🇮' },
  { code: 'fr', label: 'French', flag: '🇫🇷' },
  { code: 'gl', label: 'Galician', flag: '🇪🇸' },
  { code: 'de', label: 'German', flag: '🇩🇪' },
  { code: 'el', label: 'Greek', flag: '🇬🇷' },
  { code: 'he', label: 'Hebrew', flag: '🇮🇱' },
  { code: 'hi', label: 'Hindi', flag: '🇮🇳' },
  { code: 'hu', label: 'Hungarian', flag: '🇭🇺' },
  { code: 'is', label: 'Icelandic', flag: '🇮🇸' },
  { code: 'id', label: 'Indonesian', flag: '🇮🇩' },
  { code: 'it', label: 'Italian', flag: '🇮🇹' },
  { code: 'ja', label: 'Japanese', flag: '🇯🇵' },
  { code: 'kn', label: 'Kannada', flag: '🇮🇳' },
  { code: 'kk', label: 'Kazakh', flag: '🇰🇿' },
  { code: 'ko', label: 'Korean', flag: '🇰🇷' },
  { code: 'lv', label: 'Latvian', flag: '🇱🇻' },
  { code: 'lt', label: 'Lithuanian', flag: '🇱🇹' },
  { code: 'mk', label: 'Macedonian', flag: '🇲🇰' },
  { code: 'ms', label: 'Malay', flag: '🇲🇾' },
  { code: 'mt', label: 'Maltese', flag: '🇲🇹' },
  { code: 'mr', label: 'Marathi', flag: '🇮🇳' },
  { code: 'mi', label: 'Maori', flag: '🇳🇿' },
  { code: 'ne', label: 'Nepali', flag: '🇳🇵' },
  { code: 'no', label: 'Norwegian', flag: '🇳🇴' },
  { code: 'fa', label: 'Persian', flag: '🇮🇷' },
  { code: 'pl', label: 'Polish', flag: '🇵🇱' },
  { code: 'pt', label: 'Portuguese', flag: '🇵🇹' },
  { code: 'ro', label: 'Romanian', flag: '🇷🇴' },
  { code: 'ru', label: 'Russian', flag: '🇷🇺' },
  { code: 'sr', label: 'Serbian', flag: '🇷🇸' },
  { code: 'sk', label: 'Slovak', flag: '🇸🇰' },
  { code: 'sl', label: 'Slovenian', flag: '🇸🇮' },
  { code: 'es', label: 'Spanish', flag: '🇪🇸' },
  { code: 'sw', label: 'Swahili', flag: '🇰🇪' },
  { code: 'sv', label: 'Swedish', flag: '🇸🇪' },
  { code: 'tl', label: 'Tagalog', flag: '🇵🇭' },
  { code: 'ta', label: 'Tamil', flag: '🇮🇳' },
  { code: 'th', label: 'Thai', flag: '🇹🇭' },
  { code: 'tr', label: 'Turkish', flag: '🇹🇷' },
  { code: 'uk', label: 'Ukrainian', flag: '🇺🇦' },
  { code: 'ur', label: 'Urdu', flag: '🇵🇰' },
  { code: 'vi', label: 'Vietnamese', flag: '🇻🇳' },
  { code: 'cy', label: 'Welsh', flag: '🏴󠁧󠁢󠁷󠁬󠁳󠁿' },
];

const BY_CODE = new Map(LANGUAGES.map((l) => [l.code, l]));

export function getLanguage(code: LanguageCode | undefined): Language {
  if (!code) return LANGUAGES[0];
  return BY_CODE.get(code) ?? LANGUAGES[0];
}

// Whisper / OpenAI want the base ISO-639 code (no region). 'auto' becomes
// undefined so the upstream API auto-detects.
export function toApiLanguage(code: LanguageCode | undefined): string | undefined {
  if (!code || code === 'auto') return undefined;
  return code.split('-')[0];
}
