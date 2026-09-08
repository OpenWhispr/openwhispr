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
// end state mid-rise — fix round 1, finding 3. A brand-new word's delay is
// relative to how many OTHER new words have shown up in THIS SAME walk
// (not risenWords.size, which is cumulative across the whole reply so far)
// — a per-walk counter, reset every call. Using the cumulative size instead
// would make a word arriving after, say, 50 already-settled words wait
// 50 * staggerMs before it even starts rising, defeating the "stagger
// within an arriving batch" effect entirely for anything past the first
// few words of a reply.
interface HastNode {
  type: string;
  tagName?: string;
  value?: string;
  properties?: Record<string, unknown>;
  children?: HastNode[];
}

const SKIP = new Set(["code", "pre"]);

export function rehypeWordRise({
  risenWords,
  staggerMs,
}: {
  risenWords: Map<number, number>;
  staggerMs: number;
}) {
  return (tree: HastNode) => {
    let index = 0;
    let newThisWalk = 0;
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
        for (const part of child.value.split(/(\s+)/)) {
          if (!part) continue;
          if (/^\s+$/.test(part)) {
            next.push({ type: "text", value: part });
            continue;
          }
          let delay = risenWords.get(index);
          if (delay === undefined) {
            delay = newThisWalk * staggerMs;
            risenWords.set(index, delay);
            newThisWalk += 1;
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
  };
}
