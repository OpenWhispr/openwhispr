// A streaming reply is rendered as "settled" markdown (everything before a
// safe paragraph break, re-rendered only when that boundary moves) plus the
// current tail, which is the only part touched per token. settled and tail
// are parsed as two INDEPENDENT documents (by two separate MarkdownRenderer
// calls), so a boundary that lands inside a list, a fenced code block, or a
// blockquote produces genuinely wrong rendered output, not just an
// animation imperfection: a list item split from its siblings starts its
// own fresh <ol> (mis-numbered — MarkdownRenderer's <ol> doesn't forward a
// `start` prop), an unterminated fence's next line renders as a stray
// plain-text paragraph instead of code, and a loose list can settle some
// items loose and leave the newest one tight. Fix round 1, finding 2.
//
// This is a text-level safety check, not a markdown parser: a candidate
// boundary is rejected only when the block immediately before it looks
// like it could still be continuing (a list item, a blockquote line, or an
// unterminated fenced code block anywhere in the candidate). On rejection,
// the search retries the next EARLIER "\n\n", so an in-progress list/quote/
// fence of any length stays whole in the tail until something else proves
// it has ended, and settles as one unit rather than splitting a boundary
// through the middle of it.
export function splitStreamingMarkdown(content: string): { settled: string; tail: string } {
  let boundary = content.lastIndexOf("\n\n");
  while (boundary !== -1) {
    const end = boundary + 2;
    const candidateSettled = content.slice(0, end);
    const candidateTail = content.slice(end);
    if (isSafeSettledBoundary(candidateSettled, candidateTail)) {
      return { settled: candidateSettled, tail: candidateTail };
    }
    boundary = content.lastIndexOf("\n\n", boundary - 1);
  }
  return { settled: "", tail: content };
}

// A list item's own text always looks list-shaped — that includes the
// LAST item of an already-complete list, which is exactly the boundary we
// DO want to allow. So the question isn't "does settled's last block look
// like a list/quote item" (true for both an in-progress AND a finished
// list) — it's "does the tail's own first line ALSO look like a list/quote
// item", which only holds while the SAME construct keeps going. A fenced
// code block doesn't have this ambiguity: an unterminated fence is
// unambiguous on its own, so it's checked directly against the candidate
// settled text.
function isSafeSettledBoundary(candidateSettled: string, candidateTail: string): boolean {
  if (hasUnterminatedFence(candidateSettled)) return false;
  const lastBlockOfSettled = lastParagraphBlock(candidateSettled);
  if (!looksLikeListOrQuote(lastBlockOfSettled)) return true;
  // Fix round 2, finding: an empty tail is NOT proof the list/quote ended —
  // useChatStreaming calls setMessages with the full accumulated content on
  // every chunk, so a render landing exactly at "\n\n" (between finishing
  // one loose-list item and the next one starting) is routine, not a
  // completion signal. Treating it as safe made the settled prefix
  // NON-MONOTONIC: it would settle the item alone here, then un-settle it
  // (detaching and re-rendering the already-displayed <p>, and re-marking
  // its words data-rise) the instant the next item's marker arrived —
  // exactly the twitching-settled-text failure this task exists to
  // prevent. Only genuinely new, non-list/quote-shaped content in the tail
  // proves the construct is done; nothing yet is not that proof.
  if (candidateTail === "") return false;
  return !looksLikeListOrQuote(candidateTail);
}

function looksLikeListOrQuote(text: string): boolean {
  return /^[ \t]{0,3}([-*+]|\d+[.)])\s+/.test(text) || /^[ \t]{0,3}>/.test(text);
}

// Counts fence-opening/closing lines (``` or ~~~, optionally indented up to
// 3 spaces per CommonMark) anywhere in `text`. An odd count means the last
// fence opened has no matching close yet within this text.
function hasUnterminatedFence(text: string): boolean {
  const fenceLines = text.match(/^ {0,3}(`{3,}|~{3,})/gm);
  return Boolean(fenceLines && fenceLines.length % 2 === 1);
}

// The text of the last "\n\n"-delimited block in a candidate settled prefix
// (which always itself ends in "\n\n" by construction — see the trailing
// slice(0, -2) below, which excludes that trailing boundary from counting
// as a separator when locating the block's own start).
function lastParagraphBlock(candidateSettled: string): string {
  const withoutTrailingBoundary = candidateSettled.slice(0, -2);
  const idx = withoutTrailingBoundary.lastIndexOf("\n\n");
  return idx === -1 ? withoutTrailingBoundary : withoutTrailingBoundary.slice(idx + 2);
}

export function countWords(text: string): number {
  const trimmed = text.trim();
  return trimmed ? trimmed.split(/\s+/).length : 0;
}
