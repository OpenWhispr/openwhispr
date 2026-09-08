// Rehype plugin for the streaming tail: every word becomes a span so newly
// arrived words can rise in once. Indices run in document order across the
// whole tree, so React keeps earlier spans stable as the tail grows.
//
// `risenWords` is the SOLE source of truth for "which real (HAST) word index
// has already been assigned a rise delay" — it is a caller-owned Map,
// mutated in place, keyed by the index this walk itself assigns (never a
// count derived from the raw markdown string: markdown syntax like "- ",
// "## ", "1. " or "> " tokenizes into extra whitespace-separated words that
// do not exist once rendered, so a count taken from raw text and a count
// taken from this walk can permanently disagree — fix round 1, finding 1).
//
// A word already in the map keeps its ORIGINAL delay forever, rather than
// being recomputed (and thus re-marked "not new") the moment more tokens
// arrive: recomputing from a moving threshold cancels an in-flight CSS
// animation the instant the next render lands, snapping the word to its
// end state mid-rise — fix round 1, finding 3.
//
// WHY THE DELAY IS ANCHORED TO WALL-CLOCK TIME (Josh, 2026-09-08: the
// streaming "lacks a smooth effect flowing left to right and then down each
// line"). A CSS animation-delay is relative to the paint that created the
// span, so a delay only orders words WITHIN one render walk. The previous
// version assigned `newThisWalk * staggerMs` — a counter reset every walk —
// which meant a word arriving in the next chunk started its rise at +0ms
// while a word from the previous chunk was still waiting at +56ms. Words
// then rose OUT OF DOCUMENT ORDER whenever chunks overlapped in time, which
// at real model latency is every chunk: the visible result is a shimmer
// scattered across the paragraph, not a left-to-right sweep.
//
// `clock` fixes that. It is a caller-owned cursor holding the absolute time
// at which the NEXT word may begin rising; each walk anchors its batch at
// `max(now, clock.nextRiseAt)` and writes the cursor forward. Because every
// batch starts where the previous one ended, absolute rise order is exactly
// document order no matter how the chunks land.
//
// `maxLagMs` is what keeps that cursor from running away. A cascade that
// only ever adds staggerMs per word falls further behind the text on every
// chunk (a fast stream delivers words faster than 1/staggerMs), so a reply
// would still be rising long after it finished arriving. Instead the batch
// is spread over whatever remains of a fixed lag window: the stagger shrinks
// to fit, never grows past staggerMs. Dividing the remaining window by the
// FULL new-word count (not count - 1) leaves the cursor exactly at the
// window edge when saturated, so the steady state is "words rise at the rate
// they arrive, in order, a fixed lag behind" rather than a clump at the cap.
// A near-instant reply — every word in one walk — is the same rule seen
// once: a whole-reply left-to-right sweep across the lag window.
interface HastNode {
  type: string;
  tagName?: string;
  value?: string;
  properties?: Record<string, unknown>;
  children?: HastNode[];
}

export interface RiseClock {
  /** Absolute time (same base as `now`) at which the next word may rise. */
  nextRiseAt: number;
}

const SKIP = new Set(["code", "pre"]);
const WORD_SPLIT = /(\s+)/;
const IS_WHITESPACE = /^\s+$/;

// Read-only pre-pass. It must tokenize identically to the assigning walk
// below (same traversal order, same SKIP set, same split) so the indices it
// tests against `risenWords` are the very indices that walk will assign;
// it never mutates, so the tree it counts is the tree that walk then sees.
function countNewWords(tree: HastNode, risenWords: Map<number, number>): number {
  let index = 0;
  let newWords = 0;
  const visit = (node: HastNode) => {
    if (!node.children) return;
    for (const child of node.children) {
      if (child.type === "element") {
        if (!SKIP.has(child.tagName ?? "")) visit(child);
        continue;
      }
      if (child.type !== "text" || !child.value) continue;
      for (const part of child.value.split(WORD_SPLIT)) {
        if (!part || IS_WHITESPACE.test(part)) continue;
        if (!risenWords.has(index)) newWords += 1;
        index += 1;
      }
    }
  };
  visit(tree);
  return newWords;
}

export interface RehypeWordRiseOptions {
  risenWords: Map<number, number>;
  staggerMs: number;
  clock: RiseClock;
  now: number;
  maxLagMs: number;
}

export function rehypeWordRise({
  risenWords,
  staggerMs,
  clock,
  now,
  maxLagMs,
}: RehypeWordRiseOptions) {
  return (tree: HastNode) => {
    const newWords = countNewWords(tree, risenWords);
    // Never start a batch in the past (a cursor left behind by a pause), and
    // never start one beyond the lag window (a cursor left ahead by a burst).
    const windowEnd = now + maxLagMs;
    const start = Math.min(Math.max(now, clock.nextRiseAt), windowEnd);
    const stagger =
      newWords > 0 ? Math.min(staggerMs, Math.max(0, windowEnd - start) / newWords) : staggerMs;

    let index = 0;
    let assigned = 0;
    const visit = (node: HastNode) => {
      if (!node.children) return;
      const next: HastNode[] = [];
      for (const child of node.children) {
        if (child.type === "element") {
          if (!SKIP.has(child.tagName ?? "")) visit(child);
          next.push(child);
          continue;
        }
        if (child.type !== "text" || !child.value) {
          next.push(child);
          continue;
        }
        for (const part of child.value.split(WORD_SPLIT)) {
          if (!part) continue;
          if (IS_WHITESPACE.test(part)) {
            next.push({ type: "text", value: part });
            continue;
          }
          let delay = risenWords.get(index);
          if (delay === undefined) {
            // Relative to THIS walk's paint, which is what animation-delay
            // measures from — the absolute instant is `start + assigned *
            // stagger`, and `now` is this walk's own zero.
            delay = Math.round(start + assigned * stagger - now);
            risenWords.set(index, delay);
            assigned += 1;
          }
          next.push({
            type: "element",
            tagName: "span",
            properties: {
              className: ["assistant-word"],
              "data-word-index": index,
              "data-rise": "true",
              style: `animation-delay: ${delay}ms`,
            },
            children: [{ type: "text", value: part }],
          });
          index += 1;
        }
      }
      node.children = next;
    };
    visit(tree);
    // Only a batch that actually placed words moves the cursor; an unchanged
    // tail (a re-render with no new tokens) must leave the cascade alone.
    if (newWords > 0) clock.nextRiseAt = start + newWords * stagger;
  };
}
