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

function toUpcomingGroupDate(date: Date | string | null | undefined): Date | null {
  if (date instanceof Date) {
    return Number.isNaN(date.getTime()) ? null : date;
  }
  if (typeof date !== "string") return null;
  const trimmed = date.trim();
  if (!trimmed) return null;

  // Google all-day events are date-only (`YYYY-MM-DD`). `new Date("YYYY-MM-DD")`
  // is UTC midnight, which is still the previous local day west of UTC.
  const dateOnly = /^(\d{4})-(\d{2})-(\d{2})$/.exec(trimmed);
  if (dateOnly) {
    const parsed = new Date(Number(dateOnly[1]), Number(dateOnly[2]) - 1, Number(dateOnly[3]));
    return Number.isNaN(parsed.getTime()) ? null : parsed;
  }

  const parsed = new Date(trimmed);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

export function formatUpcomingDateGroup(
  date: Date | string | null | undefined,
  t: (key: string) => string
): string {
  const d = toUpcomingGroupDate(date);
  if (!d) return "";
  const now = new Date();
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const tomorrow = new Date(today);
  tomorrow.setDate(tomorrow.getDate() + 1);
  const target = new Date(d.getFullYear(), d.getMonth(), d.getDate());

  if (target.getTime() === today.getTime()) return t("controlPanel.history.dateGroups.today");
  if (target.getTime() === tomorrow.getTime()) return t("upcoming.tomorrow");
  return d.toLocaleDateString(undefined, { weekday: "long", month: "short", day: "numeric" });
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
