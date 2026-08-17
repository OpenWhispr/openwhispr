const OPEN_TAG = "<think>";
const CLOSE_TAG = "</think>";
const OPEN_TAGS = [OPEN_TAG] as const;
const THINK_TAGS = [OPEN_TAG, CLOSE_TAG] as const;
const MAX_PARTIAL_TAG_LENGTH = CLOSE_TAG.length - 1;

export interface StreamingThinkFilter {
  (chunk: string): string;
  finish: () => string;
}

function getPartialTagSuffix(value: string, tags: readonly string[]): string {
  const maxLength = Math.min(value.length, MAX_PARTIAL_TAG_LENGTH);
  for (let length = maxLength; length > 0; length -= 1) {
    const suffix = value.slice(-length);
    if (tags.some((tag) => tag.startsWith(suffix))) return suffix;
  }
  return "";
}

// Filters <think> blocks out of streamed chat deltas, keeping state across
// chunks, including tags split between deltas. Depth is a counter because
// the first </think> in a nested block only closes the inner block. finish()
// preserves a trailing tag-like fragment only when it was outside reasoning.
export function createStreamingThinkFilter(): StreamingThinkFilter {
  let depth = 0;
  let pending = "";

  const filter = (chunk: string): string => {
    const input = pending + chunk;
    pending = "";
    let visible = "";
    let cursor = 0;

    while (cursor < input.length) {
      const open = input.indexOf(OPEN_TAG, cursor);

      if (depth === 0) {
        if (open === -1) {
          const remaining = input.slice(cursor);
          pending = getPartialTagSuffix(remaining, OPEN_TAGS);
          visible += remaining.slice(0, remaining.length - pending.length);
          break;
        }
        visible += input.slice(cursor, open);
        depth = 1;
        cursor = open + OPEN_TAG.length;
        continue;
      }

      const close = input.indexOf(CLOSE_TAG, cursor);
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
