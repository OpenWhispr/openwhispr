import { Fragment, type ReactElement } from "react";

interface HighlightMatchProps {
  text: string;
  /** What the person typed; matched case-insensitively and trimmed, as the list was filtered. */
  query: string;
}

// The part of a name or address a search matched, set off with a soft fill rather than a colour,
// so the line still reads as one piece of text.
export function HighlightMatch({ text, query }: HighlightMatchProps): ReactElement {
  const needle = query.trim().toLowerCase();
  if (!needle) return <>{text}</>;

  const haystack = text.toLowerCase();
  const parts: ReactElement[] = [];
  let from = 0;
  let key = 0;
  for (let at = haystack.indexOf(needle); at !== -1; at = haystack.indexOf(needle, from)) {
    if (at > from) parts.push(<Fragment key={key++}>{text.slice(from, at)}</Fragment>);
    from = at + needle.length;
    parts.push(
      <mark key={key++} className="rounded-[3px] bg-foreground/10 text-inherit">
        {text.slice(at, from)}
      </mark>
    );
  }
  // Lowercasing can change a string's length in a few scripts; then the offsets above don't line
  // up with `text`, so it shows plain rather than mark the wrong letters.
  if (haystack.length !== text.length) return <>{text}</>;
  if (from < text.length) parts.push(<Fragment key={key++}>{text.slice(from)}</Fragment>);
  return <>{parts}</>;
}
