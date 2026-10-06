export interface EmojiEntry {
  emoji: string;
  label: string;
  group: number;
  /** Emoji spec version that introduced it, e.g. 15.1. */
  version: number;
  tags?: string[];
}

export interface EmojiData {
  emoji: EmojiEntry[];
}

export interface EmojiSection {
  title: string | null;
  items: EmojiEntry[];
}

export type EmojiRow = { kind: "header"; title: string } | { kind: "emoji"; items: EmojiEntry[] };

export interface GridPosition {
  row: number;
  col: number;
}

export type ArrowKey = "ArrowUp" | "ArrowDown" | "ArrowLeft" | "ArrowRight";

export const EMOJI_COLUMNS = 9;
export const RECENT_EMOJI_LIMIT = EMOJI_COLUMNS;
export const FLAGS_GROUP = 9;

// Translation keys under emojiPicker.groups, by emojibase group id. Group 2
// (skin-tone and hair components) is never shown.
export const EMOJI_GROUP_KEYS: Record<number, string> = {
  0: "smileys",
  1: "people",
  3: "animals",
  4: "food",
  5: "travel",
  6: "activities",
  7: "objects",
  8: "symbols",
  9: "flags",
};

// Country flags are regional-indicator pairs and subdivision flags are tag
// sequences; Windows draws both as letters. Other flags (🏁 🏳️‍🌈 🏴‍☠️) render fine.
export function isRegionalFlag(emoji: string): boolean {
  const first = emoji.codePointAt(0) ?? 0;
  return (first >= 0x1f1e6 && first <= 0x1f1ff) || /[\u{E0020}-\u{E007F}]/u.test(emoji);
}

export function isArrowKey(key: string): key is ArrowKey {
  return key === "ArrowUp" || key === "ArrowDown" || key === "ArrowLeft" || key === "ArrowRight";
}

// The grid is a flex row, so its visual order follows the document direction.
export function logicalArrowKey(key: ArrowKey, dir: "ltr" | "rtl"): ArrowKey {
  if (dir !== "rtl") return key;
  if (key === "ArrowLeft") return "ArrowRight";
  if (key === "ArrowRight") return "ArrowLeft";
  return key;
}

export function visibleEmoji(
  entries: EmojiEntry[],
  { maxVersion, hideRegionalFlags }: { maxVersion: number; hideRegionalFlags: boolean }
): EmojiEntry[] {
  return entries.filter(
    (entry) => entry.version <= maxVersion && !(hideRegionalFlags && isRegionalFlag(entry.emoji))
  );
}

export function searchEmoji(entries: EmojiEntry[], query: string): EmojiEntry[] {
  const needle = query.trim().toLowerCase();
  if (!needle) return entries;
  return entries.filter(
    (entry) =>
      entry.label.toLowerCase().includes(needle) ||
      entry.tags?.some((tag) => tag.toLowerCase().includes(needle))
  );
}

export function groupEmoji(
  entries: EmojiEntry[],
  groupNames: Record<number, string>
): EmojiSection[] {
  const byGroup = new Map<number, EmojiEntry[]>();
  for (const entry of entries) {
    const items = byGroup.get(entry.group);
    if (items) items.push(entry);
    else byGroup.set(entry.group, [entry]);
  }
  return [...byGroup]
    .sort(([a], [b]) => a - b)
    .map(([group, items]) => ({ title: groupNames[group], items }));
}

export function buildEmojiRows(sections: EmojiSection[], columns = EMOJI_COLUMNS): EmojiRow[] {
  const rows: EmojiRow[] = [];
  for (const { title, items } of sections) {
    if (items.length === 0) continue;
    if (title) rows.push({ kind: "header", title });
    for (let start = 0; start < items.length; start += columns) {
      rows.push({ kind: "emoji", items: items.slice(start, start + columns) });
    }
  }
  return rows;
}

export function firstEmojiPosition(rows: EmojiRow[]): GridPosition | null {
  const row = rows.findIndex((candidate) => candidate.kind === "emoji");
  return row === -1 ? null : { row, col: 0 };
}

export function emojiAt(rows: EmojiRow[], { row, col }: GridPosition): EmojiEntry | null {
  return itemsIn(rows, row)[col] ?? null;
}

function itemsIn(rows: EmojiRow[], row: number): EmojiEntry[] {
  const target = rows[row];
  return target?.kind === "emoji" ? target.items : [];
}

function nextEmojiRow(rows: EmojiRow[], from: number, step: 1 | -1): number {
  for (let row = from + step; row >= 0 && row < rows.length; row += step) {
    if (rows[row].kind === "emoji") return row;
  }
  return -1;
}

// Left/Right wrap onto the neighbouring row; Up/Down keep the column, clamped to
// shorter rows. Header rows are skipped and the position holds at the grid's edges.
export function moveEmojiPosition(
  rows: EmojiRow[],
  position: GridPosition,
  key: ArrowKey
): GridPosition {
  const step = key === "ArrowUp" || key === "ArrowLeft" ? -1 : 1;
  if (key === "ArrowLeft" || key === "ArrowRight") {
    const col = position.col + step;
    if (col >= 0 && col < itemsIn(rows, position.row).length) return { row: position.row, col };
    const row = nextEmojiRow(rows, position.row, step);
    if (row === -1) return position;
    return { row, col: step === 1 ? 0 : itemsIn(rows, row).length - 1 };
  }
  const row = nextEmojiRow(rows, position.row, step);
  if (row === -1) return position;
  return { row, col: Math.min(position.col, itemsIn(rows, row).length - 1) };
}

export function pushRecentEmoji(
  recent: string[],
  emoji: string,
  limit = RECENT_EMOJI_LIMIT
): string[] {
  return [emoji, ...recent.filter((item) => item !== emoji)].slice(0, limit);
}
