import registry from '@/config/languageRegistry.json';
import { AndroidDictation } from '../../../modules/android-dictation/src';

export type Language = { code: string; label: string; flag: string };
export const LANGUAGES: Language[] = registry.languages.filter((item) => item.code !== 'auto');
export const byCode = new Map(LANGUAGES.map((item) => [item.code, item]));

// The registry mixes plain codes ("pt") with regional ones ("en-US", "zh-TW").
export function matchLanguage(code: string): string | null {
  const [base, region] = code.replaceAll('_', '-').split('-');
  const exact = region ? `${base.toLowerCase()}-${region.toUpperCase()}` : base.toLowerCase();
  if (byCode.has(exact)) return exact;
  if (byCode.has(base.toLowerCase())) return base.toLowerCase();
  return LANGUAGES.find((item) => item.code.startsWith(`${base.toLowerCase()}-`))?.code ?? null;
}

export function initialLanguages(saved: string[] | undefined, preferred?: string): string[] {
  const source = saved?.length ? saved : preferred && preferred !== 'auto' ? [preferred] : [];
  const picked = source.map(matchLanguage).filter((code): code is string => code !== null);
  if (picked.length) return [...new Set(picked)];
  return [matchLanguage(AndroidDictation?.getLocale?.() ?? 'en-US') ?? 'en-US'];
}

/**
 * The one choice Settings › Language shows: what dictation uses now. Settings' own pick when one is
 * saved; else the onboarding list's language when it holds one (sent as the hint); else 'auto'
 * (two or more, or none: dictation works it out). Mirrors getPreferredTranscriptionLanguage.
 */
export function languageChoice(saved: string[] | undefined, preferred?: string): string {
  if (preferred) return preferred;
  const picked = (saved ?? []).map(matchLanguage).filter((code): code is string => code !== null);
  const bases = new Set(picked.map((code) => code.split('-')[0]));
  return bases.size === 1 ? picked[0] : 'auto';
}
