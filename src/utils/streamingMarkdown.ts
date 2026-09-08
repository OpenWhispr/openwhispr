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
//
// Fix round 3, finding 1: that heuristic alone is necessarily incomplete —
// EVERY tail shape that momentarily fails looksLikeListOrQuote (not just an
// empty tail, fixed in round 2, but a bare/partial marker like "-", "*",
// "3", or "3.") licenses the identical wrongful split one character later.
// Two rounds of patching one observed shape at a time each bought exactly
// one more input. Rather than continue enumerating tail shapes, this now
// enforces the actual invariant the task promises directly: the settled
// prefix must never get SHORTER as content grows. `previousSettledLength`
// is the floor from the last call for THIS SAME growing message (the
// caller — AssistantPanel.tsx — owns that state and is responsible for
// resetting it to 0 when a new reply starts; see the comment there). The
// natural, markdown-aware boundary computed below still decides where to
// ADVANCE the boundary; only retreat below the floor is now impossible.
export function splitStreamingMarkdown(
  content: string,
  previousSettledLength = 0
): { settled: string; tail: string } {
  const end = Math.max(computeNaturalBoundary(content), previousSettledLength);
  // No explicit clamp against content.length: JS's own slice semantics
  // already treat an end past the string's length as "the whole string"
  // (content.slice(0, tooFar) === content, content.slice(tooFar) === ""),
  // which is exactly the safe behavior wanted if a caller ever fails to
  // reset the floor for a new, shorter reply — everything settles rather
  // than throwing or slicing negative.
  return { settled: content.slice(0, end), tail: content.slice(end) };
}

// The markdown-aware heuristic alone, unaware of any previous call: the
// furthest-forward index into `content` that is safe to settle up to,
// searching backward from the last "\n\n" and deferring to progressively
// earlier ones until a safe one is found (or none exists, returning 0).
function computeNaturalBoundary(content: string): number {
  let boundary = content.lastIndexOf("\n\n");
  while (boundary !== -1) {
    const end = boundary + 2;
    const candidateSettled = content.slice(0, end);
    const candidateTail = content.slice(end);
    if (isSafeSettledBoundary(candidateSettled, candidateTail)) return end;
    boundary = content.lastIndexOf("\n\n", boundary - 1);
  }
  return 0;
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
