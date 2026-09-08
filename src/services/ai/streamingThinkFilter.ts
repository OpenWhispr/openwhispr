const OPEN_TAG = "<think>";
const CLOSE_TAG = "</think>";
const OPEN_RE = /<think>/gi;
const CLOSE_RE = /<\/think>/gi;
const THINK_TAGS = [OPEN_TAG, CLOSE_TAG] as const;
const MAX_PARTIAL_TAG_LENGTH = CLOSE_TAG.length - 1;

export interface StreamingThinkFilter {
  (chunk: string): string;
  finish: () => string;
}

function indexOfTag(re: RegExp, input: string, from: number): number {
  re.lastIndex = from;
  const match = re.exec(input);
  return match ? match.index : -1;
}

function getPartialTagSuffix(value: string, tags: readonly string[]): string {
  const maxLength = Math.min(value.length, MAX_PARTIAL_TAG_LENGTH);
  for (let length = maxLength; length > 0; length -= 1) {
    const suffix = value.slice(-length);
    if (tags.some((tag) => tag.startsWith(suffix.toLowerCase()))) return suffix;
  }
  return "";
}

// Filters <think> blocks out of streamed chat deltas, keeping state across
// chunks, including tags split between deltas. Tags match case-insensitively
// and an orphan </think> outside a block is dropped (its surrounding text is
// kept), mirroring stripThinkingTags. Depth is a counter because the first
// </think> in a nested block only closes the inner block. finish() preserves
// a trailing tag-like fragment only when it was outside reasoning.
export function createStreamingThinkFilter(): StreamingThinkFilter {
  let depth = 0;
  let pending = "";

  const filter = (chunk: string): string => {
    const input = pending + chunk;
    pending = "";
    let visible = "";
    let cursor = 0;

    while (cursor < input.length) {
      const open = indexOfTag(OPEN_RE, input, cursor);

      if (depth === 0) {
        const close = indexOfTag(CLOSE_RE, input, cursor);
        const next = open === -1 || (close !== -1 && close < open) ? close : open;
        if (next === -1) {
          const remaining = input.slice(cursor);
          pending = getPartialTagSuffix(remaining, THINK_TAGS);
          visible += remaining.slice(0, remaining.length - pending.length);
          break;
        }
        visible += input.slice(cursor, next);
        if (next === open) {
          depth = 1;
          cursor = open + OPEN_TAG.length;
        } else {
          cursor = close + CLOSE_TAG.length;
        }
        continue;
      }

      const close = indexOfTag(CLOSE_RE, input, cursor);
      if (close !== -1 && (open === -1 || close < open)) {
        depth -= 1;
        cursor = close + CLOSE_TAG.length;
      } else if (open !== -1) {
        depth += 1;
        cursor = open + OPEN_TAG.length;
      } else {
        pending = getPartialTagSuffix(input.slice(cursor), THINK_TAGS);
        break;
      }
    }

    return visible;
  };

  filter.finish = (): string => {
    const trailing = depth === 0 ? pending : "";
    depth = 0;
    pending = "";
    return trailing;
  };

  return filter;
}
