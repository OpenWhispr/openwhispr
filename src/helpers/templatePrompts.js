// Turns a note template or action into the system prompt (and, for a summary
// action, the input) that the model receives. Pure, so the live canary and
// the tests can build the exact request the app sends.

import {
  BASE_SYSTEM_PROMPT,
  CHAT_ACTION_PREAMBLE,
  MEETING_INPUT_PREAMBLE,
  MEETING_SYSTEM_PROMPT,
  NOTE_INPUT_PREAMBLE,
  SECTIONED_NOTES_FOOTER,
  SECTIONED_NOTES_FORMAT,
  SECTIONED_NOTES_INSTRUCTIONS,
  STANDALONE_PROMPT_KEYS,
  SUMMARY_ACTION_SYSTEM_PROMPT,
} from "./builtinActions.js";

/** Trimmed sections that have a heading; anything that is not a list is no sections. */
export function normalizeSections(value) {
  if (!Array.isArray(value)) return [];
  return value
    .map((section) => ({
      heading: String(section?.heading ?? "")
        .trim()
        .replace(/^#+\s*/, ""),
      instruction: String(section?.instruction ?? "").trim(),
    }))
    .filter((section) => section.heading);
}

/**
 * A template with sections is compiled around the shared notes rules. One with
 * only a prompt keeps the request it always had: standalone built-ins get the
 * material preamble, everything else the generic system prompt.
 */
export function compileTemplatePrompt(template, { isMeetingNote = false } = {}) {
  const preamble = isMeetingNote ? MEETING_INPUT_PREAMBLE : NOTE_INPUT_PREAMBLE;
  const sections = normalizeSections(template.sections);
  if (sections.length > 0) {
    const context = (template.prompt ?? "").trim();
    return (
      preamble +
      [
        SECTIONED_NOTES_INSTRUCTIONS,
        context &&
          `TEMPLATE INSTRUCTIONS (follow these where they differ from the format below):\n${context}`,
        SECTIONED_NOTES_FORMAT,
        ...sections.map(({ heading, instruction }) =>
          instruction ? `## ${heading}\n${instruction}` : `## ${heading}`
        ),
        SECTIONED_NOTES_FOOTER,
      ]
        .filter(Boolean)
        .join("\n\n")
    );
  }
  if (template.translation_key && STANDALONE_PROMPT_KEYS.has(template.translation_key)) {
    return preamble + template.prompt;
  }
  return (isMeetingNote ? MEETING_SYSTEM_PROMPT : BASE_SYSTEM_PROMPT) + template.prompt;
}

export function compileSummaryActionPrompt(action) {
  return SUMMARY_ACTION_SYSTEM_PROMPT + action.prompt;
}

export function compileChatActionPrompt(action) {
  return CHAT_ACTION_PREAMBLE + action.prompt;
}

/**
 * What a summary action rewrites: the current summary, with the user's notes and
 * the meeting context for accuracy. The transcript stays out, so the request
 * always fits and is never split into parts.
 */
export function buildSummaryActionInput({ summary, notes, meetingContext }) {
  return [`## Current Summary\n${summary}`, notes.trim() && `## My Notes\n${notes}`, meetingContext]
    .filter(Boolean)
    .join("\n\n");
}
