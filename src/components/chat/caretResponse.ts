import { CARET_RESPONSE_PREFIXES } from "../../config/prompts/registry";

interface CaretResponse {
  content: string;
  disposition: "answer" | "question" | null;
}

// Models without ask_user identify clarification explicitly; punctuation also
// belongs in ready-to-send drafts, so it cannot decide whether to paste one.
export function readCaretResponse(text: string): CaretResponse {
  const trimmed = text.trimStart();
  const disposition = trimmed.startsWith(CARET_RESPONSE_PREFIXES.answer)
    ? "answer"
    : trimmed.startsWith(CARET_RESPONSE_PREFIXES.question)
      ? "question"
      : null;
  if (disposition) {
    let content = trimmed.slice(CARET_RESPONSE_PREFIXES[disposition].length).trimStart();
    let repeatedPrefix = false;
    for (const prefix of Object.values(CARET_RESPONSE_PREFIXES)) {
      if (!content.includes(prefix)) continue;
      content = content.replaceAll(prefix, "");
      repeatedPrefix = true;
    }
    // A model may revise its disposition. Hide even a split prefix on a new
    // line, and require one unambiguous disposition before inserting anything.
    const lastLineStart = content.lastIndexOf("\n") + 1;
    const lastLine = content.slice(lastLineStart).trimStart();
    const partialPrefix =
      Boolean(lastLine) &&
      Object.values(CARET_RESPONSE_PREFIXES).some((prefix) => prefix.startsWith(lastLine));
    if (partialPrefix) content = content.slice(0, lastLineStart);
    return {
      content: content.trimStart(),
      disposition: repeatedPrefix || partialPrefix ? null : disposition,
    };
  }
  // A prefix may arrive over several chunks. Keep it out of partial flushes
  // and stopped replies as well as the completed, persisted answer.
  if (Object.values(CARET_RESPONSE_PREFIXES).some((prefix) => prefix.startsWith(trimmed))) {
    return { content: "", disposition: null };
  }
  return { content: text, disposition: null };
}
