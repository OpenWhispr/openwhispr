import type { ComponentProps } from "react";
import Markdown from "react-markdown";
import { cn } from "../lib/utils";

interface MarkdownRendererProps {
  content: string;
  className?: string;
  rehypePlugins?: ComponentProps<typeof Markdown>["rehypePlugins"];
}

// Fix round 3, finding 2: hoisted to module scope, created exactly once —
// NOT inline in the component body (which recreated this whole object,
// with a fresh arrow function per tag, on every render) and NOT
// useMemo(..., []) either (React's own docs are explicit that useMemo is a
// performance hint it may discard, not a referential-identity guarantee;
// this needs the real guarantee). react-markdown uses each entry as the
// React element TYPE for that tag, so a fresh object meant every
// custom-mapped ancestor (p, li, h1-h3, ...) got a new type on every
// render, forcing React to unmount and remount its entire subtree — every
// word span inside it included — regardless of any prop staying the same.
// None of these functions reference MarkdownRenderer's own props (content,
// className, rehypePlugins); each only uses its own per-call parameters
// (children, href) that react-markdown supplies fresh from the AST node
// being rendered — so nothing here can go stale by being hoisted.
const MARKDOWN_COMPONENTS: ComponentProps<typeof Markdown>["components"] = {
  h1: ({ children }) => <h1 className="text-lg font-bold mb-2 mt-3 first:mt-0">{children}</h1>,
  h2: ({ children }) => (
    <h2 className="text-base font-semibold mb-2 mt-3 first:mt-0">{children}</h2>
  ),
  h3: ({ children }) => (
    <h3 className="text-sm font-semibold mb-1.5 mt-2 first:mt-0">{children}</h3>
  ),
  p: ({ children }) => <p className="mb-2 last:mb-0">{children}</p>,
  ul: ({ children }) => <ul className="list-disc pl-4 mb-2 space-y-1">{children}</ul>,
  ol: ({ children }) => <ol className="list-decimal pl-4 mb-2 space-y-1">{children}</ol>,
  li: ({ children }) => <li className="pl-1">{children}</li>,
  a: ({ href, children }) => (
    <a
      href={href}
      target="_blank"
      rel="noopener noreferrer"
      className="text-link underline decoration-link/30 hover:decoration-link/60 transition-colors"
    >
      {children}
    </a>
  ),
  code: ({ children }) => (
    <code className="bg-black/10 px-1 py-0.5 rounded text-xs font-mono">{children}</code>
  ),
  pre: ({ children }) => (
    <pre className="bg-black/10 p-2 rounded overflow-x-auto text-xs mb-2">{children}</pre>
  ),
  strong: ({ children }) => <strong className="font-semibold">{children}</strong>,
  em: ({ children }) => <em className="italic">{children}</em>,
  blockquote: ({ children }) => (
    <blockquote className="border-l-2 border-current/30 pl-3 italic my-2">{children}</blockquote>
  ),
  hr: () => <hr className="border-current/20 my-3" />,
};

export function MarkdownRenderer({ content, className, rehypePlugins }: MarkdownRendererProps) {
  return (
    <div className={cn("prose prose-sm max-w-none", className)}>
      <Markdown rehypePlugins={rehypePlugins} components={MARKDOWN_COMPONENTS}>
        {content}
      </Markdown>
    </div>
  );
}

export default MarkdownRenderer;
