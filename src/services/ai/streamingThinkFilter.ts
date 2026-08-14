const OPEN_TAG = "<think>";
const CLOSE_TAG = "</think>";

// Filters <think> blocks out of streamed chat deltas, keeping state across
// chunks. Depth is a counter, not a boolean: with nested blocks the first
// </think> only closes the inner block, so treating it as the end of
// suppression leaks the rest of the outer block (the streaming twin of
// issue #1617). Mirrors stripThinkingTags semantics for the non-streamed
// path: nested pairs collapse, an unterminated block suppresses to the end,
// and a close tag with no open block passes through.
export function createStreamingThinkFilter(): (chunk: string) => string {
  let depth = 0;

  return (chunk: string): string => {
    let visible = "";
    let cursor = 0;

    while (cursor < chunk.length) {
      const open = chunk.indexOf(OPEN_TAG, cursor);

      if (depth === 0) {
        if (open === -1) {
          visible += chunk.slice(cursor);
          break;
        }
        visible += chunk.slice(cursor, open);
        depth = 1;
        cursor = open + OPEN_TAG.length;
        continue;
      }

      const close = chunk.indexOf(CLOSE_TAG, cursor);
      if (close !== -1 && (open === -1 || close < open)) {
        depth -= 1;
        cursor = close + CLOSE_TAG.length;
      } else if (open !== -1) {
        depth += 1;
        cursor = open + OPEN_TAG.length;
      } else {
        // No more tags in this chunk; the rest is reasoning text.
        break;
      }
    }

    return visible;
  };
}
