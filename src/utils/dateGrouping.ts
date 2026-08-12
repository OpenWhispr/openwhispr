import { normalizeDbDate } from "./dateFormatting.ts";

export interface DateGroup<T> {
  label: string;
  items: T[];
}

/**
 * Buckets newest-first items into Today / Yesterday / Previous 7 days / Older
 * groups, preserving item order within each group.
 */
export function groupItemsByDate<T>(
  items: T[],
  getDate: (item: T) => string,
  t: (key: string) => string
): Array<DateGroup<T>> {
  if (items.length === 0) return [];

  const now = new Date();
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const yesterday = new Date(today);
  yesterday.setDate(yesterday.getDate() - 1);
  const weekAgo = new Date(today);
  weekAgo.setDate(weekAgo.getDate() - 7);

  const groups: Array<DateGroup<T>> = [];
  let current: DateGroup<T> | null = null;

  for (const item of items) {
    const date = normalizeDbDate(getDate(item));
    const target = new Date(date.getFullYear(), date.getMonth(), date.getDate());

    let label: string;
    if (target.getTime() >= today.getTime()) {
      label = t("chat.today");
    } else if (target.getTime() >= yesterday.getTime()) {
      label = t("chat.yesterday");
    } else if (target.getTime() >= weekAgo.getTime()) {
      label = t("chat.previousWeek");
    } else {
      label = t("chat.older");
    }

    if (!current || current.label !== label) {
      current = { label, items: [] };
      groups.push(current);
    }
    current.items.push(item);
  }

  return groups;
}
