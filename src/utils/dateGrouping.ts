import { normalizeDbDate } from "./dateFormatting.ts";

export interface DateGroup<T> {
  label: string;
  items: T[];
}

/**
 * Buckets items into Today / Yesterday / Previous 7 days / Older, in that
 * order, preserving item order within each group. The input is not assumed to
 * be sorted: `updated_at` mixes CURRENT_TIMESTAMP and ISO strings, so SQLite's
 * string ORDER BY can interleave days, and an edited note keeps its old slot
 * in the store.
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

  const labels = [t("chat.today"), t("chat.yesterday"), t("chat.previousWeek"), t("chat.older")];
  const buckets: T[][] = labels.map(() => []);
  for (const item of items) {
    const date = normalizeDbDate(getDate(item));
    const target = new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime();
    const index =
      target >= today.getTime()
        ? 0
        : target >= yesterday.getTime()
          ? 1
          : target >= weekAgo.getTime()
            ? 2
            : 3;
    buckets[index].push(item);
  }

  return labels.flatMap((label, index) =>
    buckets[index].length > 0 ? [{ label, items: buckets[index] }] : []
  );
}
