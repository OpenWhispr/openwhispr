// Rehype plugin for the streaming tail: every word becomes a span so newly
// arrived words can rise in once. Indices run in document order across the
// whole tree, so React keeps earlier spans stable as the tail grows.
interface HastNode {
  type: string;
  tagName?: string;
  value?: string;
  properties?: Record<string, unknown>;
  children?: HastNode[];
}

const SKIP = new Set(["code", "pre"]);

export function rehypeWordRise({
  firstNewWordIndex,
  staggerMs,
}: {
  firstNewWordIndex: number;
  staggerMs: number;
}) {
  return (tree: HastNode) => {
    let index = 0;
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
          const isNew = index >= firstNewWordIndex;
          next.push({
            type: "element",
            tagName: "span",
            properties: {
              className: ["assistant-word"],
              "data-word-index": index,
              ...(isNew
                ? {
                    "data-rise": "true",
                    style: `animation-delay: ${(index - firstNewWordIndex) * staggerMs}ms`,
                  }
                : {}),
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
