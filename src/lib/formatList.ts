/** Locale-aware "A, B, and C" for names shown in copy. */
export function formatList(language: string, items: string[]): string {
  return new Intl.ListFormat(language, { type: "conjunction" }).format(items);
}
