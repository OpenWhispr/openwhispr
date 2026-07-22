export function normalizeDbDate(dateStr: string): Date {
  const source = dateStr.endsWith("Z") ? dateStr : `${dateStr}Z`;
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

export function formatUpcomingDateGroup(date: Date | string, t: (key: string) => string): string {
  const d = typeof date === "string" ? new Date(date) : date;
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
  const d = typeof date === "string" ? new Date(date) : date;
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
