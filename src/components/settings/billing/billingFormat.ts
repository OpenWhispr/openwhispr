/** A billing date in the reader's locale; a string that isn't a date is shown as it came. */
export function formatBillingDate(iso: string, language: string | undefined): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  return date.toLocaleDateString(language, { month: "short", day: "numeric", year: "numeric" });
}

/**
 * Model params are strings: ISO dates reach t() in the reader's locale, and a day count or a
 * count reaches it as a number `count`, which picks the key's plural form.
 */
export function translationParams(
  params: Record<string, string> | undefined,
  formatDate: (iso: string) => string
): Record<string, string | number> | undefined {
  if (!params) return undefined;
  const result: Record<string, string | number> = { ...params };
  if (params.date) result.date = formatDate(params.date);
  if (params.days !== undefined) result.count = Number(params.days);
  if (params.count !== undefined) result.count = Number(params.count);
  return result;
}
