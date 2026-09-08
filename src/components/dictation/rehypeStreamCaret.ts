// Puts the streaming caret INSIDE the last block of the tail, at the end of
// the text, instead of after the markdown container.
//
// Josh, testing on the rig 2026-09-08: "A cursor hangs below the end of every
// sentence, almost like a line break." That is exactly what it was. The caret
// is a <span>, but it was rendered as a SIBLING of the block-level element
// holding the reply — and an inline box after a block box starts a new line,
// every time. It reads as a stray line break under the text the model is
// still writing. (Pre-existing, not introduced by the motion work: the same
// sibling caret sits in the same place at the merge base. The per-word rise
// only made the streaming legible enough to notice it.)
//
// A caret cannot be placed by CSS here — there is no selector for "the end of
// the last text run inside whatever block happens to be last" — so it is
// appended to the parsed tree instead, after rehypeWordRise has run, where the
// document structure is actually known.
interface HastNode {
  type: string;
  tagName?: string;
  value?: string;
  properties?: Record<string, unknown>;
  children?: HastNode[];
}

// Elements that hold other blocks rather than text: the caret belongs at the
// end of the deepest thing that actually contains the words, so a reply
// ending mid-list puts it after the last list item's text, not after the
// whole list.
const CONTAINERS = new Set([
  "ul",
  "ol",
  "li",
  "blockquote",
  "table",
  "thead",
  "tbody",
  "tr",
  "td",
  "th",
]);

// Never inside code: a caret span injected into <pre><code> would render as
// markup inside the user's code sample. A reply currently streaming a fenced
// block gets the caret appended at the top level instead — on its own line,
// under the block, which is both correct for a code fence and identical to
// the behaviour everything had before this plugin existed. Strictly no worse
// than the status quo for that case; better for every other.
const NEVER = new Set(["pre", "code"]);

const lastElementChild = (node: HastNode): HastNode | null => {
  const children = node.children ?? [];
  for (let i = children.length - 1; i >= 0; i -= 1) {
    if (children[i].type === "element") return children[i];
  }
  return null;
};

/**
 * The deepest block whose own last element child is not another container —
 * i.e. the one holding the final run of text. Returns the tree root itself
 * when the reply is currently inside a code block (the caret then renders
 * after it, on its own line, as it always did), and null only when there is
 * no element to attach to at all — an empty tail, where the caller's own
 * block-level fallback caret takes over.
 */
export function findCaretHost(tree: HastNode): HastNode | null {
  let node = tree;
  for (;;) {
    const last = lastElementChild(node);
    if (!last) break;
    if (NEVER.has(last.tagName ?? "")) return tree;
    node = last;
    if (!CONTAINERS.has(last.tagName ?? "")) break;
  }
  return node === tree ? null : node;
}

export function rehypeStreamCaret({ className }: { className: string }) {
  return (tree: HastNode) => {
    const host = findCaretHost(tree);
    if (!host) return;
    (host.children ??= []).push({
      type: "element",
      tagName: "span",
      properties: {
        className: [className],
        "data-stream-caret": "true",
        "aria-hidden": "true",
      },
      children: [],
    });
  };
}
