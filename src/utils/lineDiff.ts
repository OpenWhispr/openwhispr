export interface DiffLine {
  kind: " " | "+" | "-";
  text: string;
}

/** A run of unchanged lines left out of a folded diff. */
export interface FoldedLines {
  kind: "fold";
  count: number;
}

// The table below grows with both line counts; past this, whole blocks are shown instead.
const MAX_DIFF_LINES = 2_000;

function toLines(text: string): string[] {
  const lines = text.split(/\r?\n/);
  if (lines[lines.length - 1] === "") lines.pop();
  return lines;
}

const unchanged = (lines: string[]): DiffLine[] => lines.map((text) => ({ kind: " ", text }));

// The changes between two runs of lines that differ at both ends.
function diffMiddle(removed: string[], added: string[]): DiffLine[] {
  if (removed.length > MAX_DIFF_LINES || added.length > MAX_DIFF_LINES) {
    return [
      ...removed.map((text): DiffLine => ({ kind: "-", text })),
      ...added.map((text): DiffLine => ({ kind: "+", text })),
    ];
  }

  // common[i * width + j]: the longest run of lines removed[i…] and added[j…] share.
  const width = added.length + 1;
  const common = new Uint16Array((removed.length + 1) * width);
  for (let i = removed.length - 1; i >= 0; i -= 1) {
    for (let j = added.length - 1; j >= 0; j -= 1) {
      common[i * width + j] =
        removed[i] === added[j]
          ? common[(i + 1) * width + j + 1] + 1
          : Math.max(common[(i + 1) * width + j], common[i * width + j + 1]);
    }
  }

  const diff: DiffLine[] = [];
  let i = 0;
  let j = 0;
  while (i < removed.length && j < added.length) {
    if (removed[i] === added[j]) {
      diff.push({ kind: " ", text: removed[i] });
      i += 1;
      j += 1;
    } else if (common[(i + 1) * width + j] >= common[i * width + j + 1]) {
      diff.push({ kind: "-", text: removed[i] });
      i += 1;
    } else {
      diff.push({ kind: "+", text: added[j] });
      j += 1;
    }
  }
  for (; i < removed.length; i += 1) diff.push({ kind: "-", text: removed[i] });
  for (; j < added.length; j += 1) diff.push({ kind: "+", text: added[j] });
  return diff;
}

/** The line-by-line changes from `before` to `after`, in order, removals before additions. */
export function lineDiff(before: string, after: string): DiffLine[] {
  const removed = toLines(before);
  const added = toLines(after);
  // Lines both ends share need no table, so a small change to a long file stays cheap.
  let start = 0;
  while (start < removed.length && start < added.length && removed[start] === added[start]) {
    start += 1;
  }
  let end = 0;
  while (
    end < removed.length - start &&
    end < added.length - start &&
    removed[removed.length - 1 - end] === added[added.length - 1 - end]
  ) {
    end += 1;
  }
  return [
    ...unchanged(removed.slice(0, start)),
    ...diffMiddle(
      removed.slice(start, removed.length - end),
      added.slice(start, added.length - end)
    ),
    ...unchanged(removed.slice(removed.length - end)),
  ];
}

/** The diff with long unchanged runs folded, keeping `context` lines beside each change. */
export function foldUnchanged(diff: DiffLine[], context = 2): Array<DiffLine | FoldedLines> {
  const folded: Array<DiffLine | FoldedLines> = [];
  let index = 0;
  while (index < diff.length) {
    if (diff[index].kind !== " ") {
      folded.push(diff[index]);
      index += 1;
      continue;
    }
    let runEnd = index;
    while (runEnd < diff.length && diff[runEnd].kind === " ") runEnd += 1;
    const keepBefore = index === 0 ? 0 : context;
    const keepAfter = runEnd === diff.length ? 0 : context;
    const hidden = runEnd - index - keepBefore - keepAfter;
    // Folding a line or two would take as much room as showing them.
    if (hidden > 1) {
      folded.push(...diff.slice(index, index + keepBefore));
      folded.push({ kind: "fold", count: hidden });
      folded.push(...diff.slice(runEnd - keepAfter, runEnd));
    } else {
      folded.push(...diff.slice(index, runEnd));
    }
    index = runEnd;
  }
  return folded;
}
