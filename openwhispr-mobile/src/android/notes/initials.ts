/** "SK" from "Sam Kim", "PR" from "priya@…". */
export function initialsOf(nameOrEmail: string | null | undefined): string {
  const text = (nameOrEmail ?? '')
    .split('@')[0]
    .replace(/[._-]+/g, ' ')
    .trim();
  const words = text.split(/\s+/).filter(Boolean);
  if (words.length === 0) return '?';
  const first = words[0][0] ?? '';
  const second = words.length > 1 ? (words[words.length - 1][0] ?? '') : (words[0][1] ?? '');
  return (first + second).toUpperCase();
}
