import {
  createContext,
  useContext,
  useId,
  type ComponentProps,
  type ReactElement,
  type ReactNode,
} from "react";
import Markdown, { type Components, type ExtraProps } from "react-markdown";
import remarkGfm from "remark-gfm";

interface MarkdownRendererProps {
  content: string;
  className?: string;
  /** Leaves out a leading "---" header block, as a SKILL.md carries. */
  hideFrontmatter?: boolean;
  /** Shown after each code block, given the block's code. */
  codeBlockActions?: (code: string) => ReactNode;
}

// A byte-order mark, then "---" on the first line, closed by "---" or "..." on its own line.
const LEADING_FRONTMATTER = /^\uFEFF?---\r?\n[\s\S]*?\r?\n(?:---|\.\.\.)[ \t]*(?:\r?\n|$)/;

const FootnotePrefixContext = createContext("");
const InsideLinkContext = createContext(false);
// Through a context, so markdownComponents stays one constant and keeps DOM state.
const CodeBlockActionsContext = createContext<((code: string) => ReactNode) | null>(null);

type HastNode = { type: string; value?: string; children?: HastNode[] };

const hastText = (node: HastNode): string =>
  node.type === "text" ? (node.value ?? "") : (node.children ?? []).map(hastText).join("");

function MarkdownLink({ node: _node, ...props }: ComponentProps<"a"> & ExtraProps): ReactElement {
  const prefix = useContext(FootnotePrefixContext);
  return (
    <InsideLinkContext value={true}>
      <a
        {...props}
        aria-describedby={
          props["aria-describedby"] === "footnote-label"
            ? `${prefix}footnote-label`
            : props["aria-describedby"]
        }
        target={props.href?.startsWith("#") ? undefined : "_blank"}
        rel="noopener noreferrer"
        className="text-link underline decoration-link/30 hover:decoration-link/60 transition-colors wrap-break-word"
      />
    </InsideLinkContext>
  );
}

// Replies can be steered by prompt injections in notes, calendar events or web
// results the agent read. An <img> would fetch its URL as soon as the reply
// renders, leaking whatever the injection packed into it, so images only ever
// render as a link the user has to click. Inside another link, a nested link
// would take the click, and a relative URL resolves against the file:// page
// (on Windows, `//host/x` is a network share), so those render as text. Only a
// link to the image itself may be labelled with its URL.
function MarkdownImage({
  src,
  alt,
  title,
}: ComponentProps<"img"> & ExtraProps): ReactElement | null {
  const insideLink = useContext(InsideLinkContext);
  const label = alt?.trim();
  if (!src || insideLink || !/^https?:\/\//i.test(src)) return label ? <>{label}</> : null;
  return (
    <MarkdownLink href={src} title={title}>
      {label || src}
    </MarkdownLink>
  );
}

interface MarkdownNode {
  type: string;
  value?: string;
  children?: MarkdownNode[];
}

const BREAK_TAG = /^<br\s*\/?>$/i;

// A GFM table row is a single line, so models break lines inside a cell with
// <br>. Raw HTML renders as escaped text, so only a bare <br> tag is turned
// into a Markdown line break; every other tag, and a <br> with attributes,
// stays literal.
function remarkBreakTags(): (tree: MarkdownNode) => void {
  const visit = (node: MarkdownNode): void => {
    node.children?.forEach((child, index, siblings) => {
      if (child.type === "html" && BREAK_TAG.test(child.value ?? "")) {
        siblings[index] = { type: "break" };
      } else {
        visit(child);
      }
    });
  };
  return visit;
}

// Stable component types preserve DOM state, including table scroll positions.
const markdownComponents: Components = {
  h1: ({ children }): ReactElement => (
    <h1 className="text-lg font-bold mb-2 mt-3 first:mt-0">{children}</h1>
  ),
  h2: function MarkdownHeading({ children, id, className }): ReactElement {
    const prefix = useContext(FootnotePrefixContext);
    return (
      <h2
        id={id === "footnote-label" ? `${prefix}footnote-label` : id}
        className={className ?? "text-base font-semibold mb-2 mt-3 first:mt-0"}
      >
        {children}
      </h2>
    );
  },
  h3: ({ children }): ReactElement => (
    <h3 className="text-sm font-semibold mb-1.5 mt-2 first:mt-0">{children}</h3>
  ),
  p: ({ children }): ReactElement => <p className="mb-2 last:mb-0">{children}</p>,
  ul: ({ children }): ReactElement => <ul className="list-disc ps-4 mb-2 space-y-1">{children}</ul>,
  ol: ({ children }): ReactElement => (
    <ol className="list-decimal ps-4 mb-2 space-y-1">{children}</ol>
  ),
  li: ({ children, id }): ReactElement => (
    <li id={id} className="ps-1">
      {children}
    </li>
  ),
  a: MarkdownLink,
  img: MarkdownImage,
  code: ({ children }): ReactElement => (
    <code dir="ltr" className="bg-black/10 px-1 py-0.5 rounded text-xs font-mono">
      {children}
    </code>
  ),
  pre: function MarkdownCodeBlock({ children, node }): ReactElement {
    const actions = useContext(CodeBlockActionsContext);
    const block = (
      <pre dir="ltr" className="bg-black/10 p-2 rounded overflow-x-auto text-xs mb-2">
        {children}
      </pre>
    );
    if (!actions || !node) return block;
    // mdast-util-to-hast ends every code block with a newline the code itself doesn't have.
    const code = hastText(node as HastNode).replace(/\n$/, "");
    return (
      <>
        {block}
        {actions(code)}
      </>
    );
  },
  strong: ({ children }): ReactElement => <strong className="font-semibold">{children}</strong>,
  em: ({ children }): ReactElement => <em className="italic">{children}</em>,
  blockquote: ({ children }): ReactElement => (
    <blockquote className="border-s-2 border-current/30 ps-3 italic my-2">{children}</blockquote>
  ),
  hr: (): ReactElement => <hr className="border-current/20 my-3" />,
  table: ({ children }): ReactElement => (
    <div className="overflow-x-auto mb-2">
      <table className="w-full text-xs border-collapse">{children}</table>
    </div>
  ),
  thead: ({ children }): ReactElement => (
    <thead className="border-b border-current/20">{children}</thead>
  ),
  tr: ({ children }): ReactElement => (
    <tr className="border-b border-current/10 last:border-0">{children}</tr>
  ),
  // style carries the GFM column alignment (:--, :-:, --:).
  th: ({ children, style }): ReactElement => (
    <th style={style} className="px-2 py-1.5 text-start font-semibold align-top">
      {children}
    </th>
  ),
  td: ({ children, style }): ReactElement => (
    <td style={style} className="px-2 py-1.5 align-top">
      {children}
    </td>
  ),
};

export function MarkdownRenderer({
  content,
  className,
  hideFrontmatter,
  codeBlockActions,
}: MarkdownRendererProps): ReactElement {
  const footnotePrefix = `user-content-${useId()}-`;
  return (
    <div dir="auto" className={className}>
      <FootnotePrefixContext value={footnotePrefix}>
        <CodeBlockActionsContext value={codeBlockActions ?? null}>
          <Markdown
            remarkPlugins={[remarkGfm, remarkBreakTags]}
            remarkRehypeOptions={{ clobberPrefix: footnotePrefix }}
            components={markdownComponents}
          >
            {hideFrontmatter ? content.replace(LEADING_FRONTMATTER, "") : content}
          </Markdown>
        </CodeBlockActionsContext>
      </FootnotePrefixContext>
    </div>
  );
}

export default MarkdownRenderer;
