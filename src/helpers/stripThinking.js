// Strip <think>...</think> blocks (including unterminated ones) emitted by
// reasoning models. Innermost closed pairs are removed first so nested blocks
// cannot leave a stray </think>, then a trailing unterminated <think> is removed,
// and finally any orphan </think> tags are stripped.
export function stripThinkingTags(text) {
  if (typeof text !== "string") return text;
  const innermostClosed = /<think>(?:(?!<think>)[\s\S])*?<\/think>/i;
  let out = text;
  let next = out.replace(innermostClosed, "");
  while (next !== out) {
    out = next;
    next = out.replace(innermostClosed, "");
  }
  return next
    .replace(/<think>[\s\S]*$/i, "")
    .replace(/<\/think>/gi, "")
    .trim();
}
