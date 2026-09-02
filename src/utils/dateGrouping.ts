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

  const bucketOrder = [
    t("chat.today"),
    t("chat.yesterday"),
    t("chat.previousWeek"),
    t("chat.older"),
  ];
  const bucketMap = new Map<string, T[]>();
  for (const label of bucketOrder) {
    bucketMap.set(label, []);
  }

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

    bucketMap.get(label)!.push(item);
  }

  const groups: Array<DateGroup<T>> = [];
  for (const label of bucketOrder) {
    const bucketItems = bucketMap.get(label)!;
    if (bucketItems.length > 0) {
      groups.push({ label, items: bucketItems });
    }
  }

  return groups;
}
