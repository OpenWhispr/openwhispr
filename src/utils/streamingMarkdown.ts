// A streaming reply is rendered as "settled" markdown (everything before the
// last paragraph break, re-rendered only when that boundary moves) plus the
// current paragraph, which is the only part touched per token.
export function splitStreamingMarkdown(content: string): { settled: string; tail: string } {
  const boundary = content.lastIndexOf("\n\n");
  if (boundary === -1) return { settled: "", tail: content };
  const end = boundary + 2;
  return { settled: content.slice(0, end), tail: content.slice(end) };
}

export function countWords(text: string): number {
  const trimmed = text.trim();
  return trimmed ? trimmed.split(/\s+/).length : 0;
}
