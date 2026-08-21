// Calendar events store all-day starts as date-only `YYYY-MM-DD` (Google's
// `start.date`). The ECMAScript parser reads that form as UTC midnight, which
// is still the previous local calendar day west of UTC, so date-only values
// must be parsed as local dates.
export function parseEventDate(value: string): Date | null {
  if (typeof value !== "string" || !value) return null;
  const dateOnly = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  const parsed = dateOnly
    ? new Date(Number(dateOnly[1]), Number(dateOnly[2]) - 1, Number(dateOnly[3]))
    : new Date(value);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

export function normalizeDbDate(dateStr: string): Date {
  const hasExplicitZone = /(?:Z|[+-]\d{2}:?\d{2})$/i.test(dateStr);
  const source = hasExplicitZone ? dateStr : `${dateStr}Z`;
  return new Date(source);
}

export function formatShortDate(dateStr: string): string {
  const date = normalizeDbDate(dateStr);
  if (Number.isNaN(date.getTime())) return "";
  return date.toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

export function formatRelativeTime(
  dateStr: string,
  t: (key: string, options?: Record<string, unknown>) => string
): string {
  const date = normalizeDbDate(dateStr);
  if (Number.isNaN(date.getTime())) return "";
  const diff = Date.now() - date.getTime();
  const minutes = Math.floor(diff / 60000);
  const hours = Math.floor(diff / 3600000);
  const days = Math.floor(diff / 86400000);
  if (minutes < 1) return t("notes.list.timeNow");
  if (minutes < 60) return t("notes.list.minutesAgo", { count: minutes });
  if (hours < 24) return t("notes.list.hoursAgo", { count: hours });
  if (days < 7) return t("notes.list.daysAgo", { count: days });
  return formatShortDate(dateStr);
}

export function formatDateGroup(date: Date | string, t: (key: string) => string): string {
  const d = typeof date === "string" ? normalizeDbDate(date) : date;
  const now = new Date();
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const yesterday = new Date(today);
  yesterday.setDate(yesterday.getDate() - 1);
  const target = new Date(d.getFullYear(), d.getMonth(), d.getDate());

  if (target.getTime() === today.getTime()) return t("controlPanel.history.dateGroups.today");
  if (target.getTime() === yesterday.getTime())
    return t("controlPanel.history.dateGroups.yesterday");
  return d.toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" });
}
