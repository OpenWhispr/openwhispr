import { Fragment, createElement, useMemo, type ReactElement, type ReactNode } from "react";

interface ReleaseNotesProps {
  html: string;
  className?: string;
}

// electron-updater hands over the GitHub release body as HTML, and this window
// has window.electronAPI, so the notes never go through innerHTML, where an
// attribute such as onerror would run. DOMParser builds an inert document (no
// scripts, no image loads), which is rebuilt as React elements: only these tags,
// with no attributes but a link's http(s) href. Any other element keeps its text.
const ALLOWED_TAGS = new Set([
  "p",
  "ul",
  "ol",
  "li",
  "strong",
  "em",
  "code",
  "h1",
  "h2",
  "h3",
  "h4",
  "br",
]);
// Their text is code, not prose.
const DROPPED_TAGS = new Set(["script", "style"]);

function webUrl(value: string | null): string | null {
  if (!value) return null;
  try {
    const url = new URL(value);
    return url.protocol === "https:" || url.protocol === "http:" ? url.href : null;
  } catch {
    return null;
  }
}

function ExternalLink({ href, children }: { href: string; children: ReactNode }): ReactElement {
  return (
    <a href={href} target="_blank" rel="noopener noreferrer">
      {children}
    </a>
  );
}

// An <img> would fetch its URL as soon as the notes render, so an image only
// ever becomes a link the user has to click, or the text of the link around it.
function renderImage(image: Element, key: number, insideLink: boolean): ReactNode {
  const src = webUrl(image.getAttribute("src"));
  const label = image.getAttribute("alt") || src;
  if (!src || insideLink) return label;
  return (
    <ExternalLink key={key} href={src}>
      {label}
    </ExternalLink>
  );
}

function renderNode(node: ChildNode, key: number, insideLink: boolean): ReactNode {
  if (node.nodeType === Node.TEXT_NODE) return node.textContent;
  if (node.nodeType !== Node.ELEMENT_NODE) return null;

  const element = node as Element;
  const tag = element.localName;
  if (DROPPED_TAGS.has(tag)) return null;
  if (tag === "img") return renderImage(element, key, insideLink);

  const href = tag === "a" && !insideLink ? webUrl(element.getAttribute("href")) : null;
  const children = renderNodes(element.childNodes, insideLink || href !== null);
  if (href) {
    return (
      <ExternalLink key={key} href={href}>
        {children}
      </ExternalLink>
    );
  }
  if (!ALLOWED_TAGS.has(tag)) return <Fragment key={key}>{children}</Fragment>;
  return createElement(tag, { key }, ...children);
}

function renderNodes(nodes: NodeListOf<ChildNode>, insideLink: boolean): ReactNode[] {
  return Array.from(nodes, (node, index) => renderNode(node, index, insideLink));
}

export function ReleaseNotes({ html, className }: ReleaseNotesProps): ReactElement {
  const notes = useMemo(
    () => renderNodes(new DOMParser().parseFromString(html, "text/html").body.childNodes, false),
    [html]
  );
  return <div className={className}>{notes}</div>;
}
