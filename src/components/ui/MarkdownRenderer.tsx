import Markdown from "react-markdown";
import { cn } from "../lib/utils";

interface MarkdownRendererProps {
  content: string;
  className?: string;
}

export function MarkdownRenderer({ content, className }: MarkdownRendererProps) {
  return (
    <div dir="auto" className={cn("prose prose-sm max-w-none", className)}>
      <Markdown
        components={{
          h1: ({ children }) => (
            <h1 className="text-lg font-bold mb-2 mt-3 first:mt-0">{children}</h1>
          ),
          h2: ({ children }) => (
            <h2 className="text-base font-semibold mb-2 mt-3 first:mt-0">{children}</h2>
          ),
          h3: ({ children }) => (
            <h3 className="text-sm font-semibold mb-1.5 mt-2 first:mt-0">{children}</h3>
          ),
          p: ({ children }) => <p className="mb-2 last:mb-0">{children}</p>,
          ul: ({ children }) => <ul className="list-disc ps-4 mb-2 space-y-1">{children}</ul>,
          ol: ({ children }) => <ol className="list-decimal ps-4 mb-2 space-y-1">{children}</ol>,
          li: ({ children }) => <li className="ps-1">{children}</li>,
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
            <code dir="ltr" className="bg-black/10 px-1 py-0.5 rounded text-xs font-mono">
              {children}
            </code>
          ),
          pre: ({ children }) => (
            <pre dir="ltr" className="bg-black/10 p-2 rounded overflow-x-auto text-xs mb-2">
              {children}
            </pre>
          ),
          strong: ({ children }) => <strong className="font-semibold">{children}</strong>,
          em: ({ children }) => <em className="italic">{children}</em>,
          blockquote: ({ children }) => (
            <blockquote className="border-s-2 border-current/30 ps-3 italic my-2">
              {children}
            </blockquote>
          ),
          hr: () => <hr className="border-current/20 my-3" />,
        }}
      >
        {content}
      </Markdown>
    </div>
  );
}

export default MarkdownRenderer;
