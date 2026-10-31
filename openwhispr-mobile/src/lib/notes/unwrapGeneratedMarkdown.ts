/**
 * Some models wrap their entire Markdown answer as a code sample. Remove only
 * that explicit outer wrapper before saving default generated notes. Never
 * rewrite user edits, custom actions, unlabeled code or an incomplete response.
 */
export function unwrapGeneratedMarkdown(text: string): string {
  const lines = text.trim().split(/\r?\n/);
  const opening = lines[0].match(/^(`{3,}|~{3,})(?:markdown|md)[ \t]*$/i);
  if (!opening) return text;

  const fence = opening[1];
  const closing = new RegExp(`^[ \\t]*${fence[0]}{${fence.length},}[ \\t]*$`);
  // The first matching close must finish the response. This avoids combining
  // separate code samples or dropping prose after a code block.
  const closeIndex = lines.findIndex((line, index) => index > 0 && closing.test(line));
  if (closeIndex !== lines.length - 1) return text;

  const body = lines.slice(1, closeIndex);
  while (body.length && !body[0].trim()) body.shift();
  while (body.length && !body[body.length - 1].trim()) body.pop();
  return body.length ? body.join('\n') : text;
}
