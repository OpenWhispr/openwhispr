import { en as enPrompts, type PromptBundle } from "../../locales/prompts";

// When changing this text, move its old hash to the retired set in
// src/config/retiredPrompts.js and update the current-hash snapshot there.
const DEFAULT_CHAT_AGENT_PROMPT =
  "You are a helpful voice assistant. Respond concisely and conversationally. " +
  "Keep answers brief unless the user asks for detail. " +
  "You may be given a transcription of spoken input, so handle informal phrasing gracefully.";

// Appended per request, not baked into the default: the panel renders markdown.
export const PLAIN_TEXT_RESPONSE_SUFFIX =
  "\n\nOUTPUT FORMAT: Your answer will be inserted as plain text exactly where the user is typing, " +
  "inside another application. Answer with the text itself, ready to insert (asked for a reply, " +
  "write the reply), with no introduction or comment around it, and don't draft or send it " +
  "with a tool. Write plain prose with no markdown: no asterisks, underscores, " +
  "backticks, heading marks, bullet or numbered-list markers, tables, or link syntax. " +
  "Use ordinary sentences and paragraphs. If several items must be listed, put each on its " +
  "own line with no marker.";

export const CARET_RESPONSE_PREFIXES = {
  answer: "__OPENWHISPR_CARET_ANSWER__",
  question: "__OPENWHISPR_CARET_QUESTION__",
} as const;

export const CARET_RESPONSE_DISPOSITION_SUFFIX =
  "\n\nCARET DELIVERY: Start your response with exactly one of these prefixes on its own line, " +
  "followed by your plain-text reply. " +
  `Use ${CARET_RESPONSE_PREFIXES.answer} only for a complete answer ready to insert. ` +
  `Use ${CARET_RESPONSE_PREFIXES.question} if you need clarification from the user or cannot ` +
  "complete the request; the reply will stay in the assistant instead of being inserted. " +
  "A question that belongs in the requested draft is still a complete answer. " +
  "Write nothing before the prefix. The app removes the prefix before showing your reply.";

export const PROMPT_KINDS = {
  cleanup: {
    i18nKey: "cleanupPrompt" as const,
    fallback: enPrompts.cleanupPrompt,
  },
  dictationAgent: {
    i18nKey: "fullPrompt" as const,
    fallback: enPrompts.fullPrompt,
  },
  translate: {
    i18nKey: "translatePrompt" as const,
    fallback: enPrompts.translatePrompt,
  },
  chatAgent: {
    i18nKey: null,
    fallback: DEFAULT_CHAT_AGENT_PROMPT,
  },
} as const satisfies Record<string, { i18nKey: keyof PromptBundle | null; fallback: string }>;

export type PromptKind = keyof typeof PROMPT_KINDS;
export const PROMPT_KIND_LIST = Object.keys(PROMPT_KINDS) as readonly PromptKind[];
