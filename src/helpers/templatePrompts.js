// Turns a note template or action into the input and system prompt the model
// receives. Pure, so the live canary and the tests can build the exact request
// the app sends.
//
// A template always writes the summary from the note's own material: the user's
// notes, the meeting context and the transcript. An action works from the AI
// summary when the note has one, and from that same material when it doesn't.

import {
  BASE_SYSTEM_PROMPT,
  CHAT_ACTION_ON_MATERIAL_PREAMBLE,
  CHAT_ACTION_ON_SUMMARY_PREAMBLE,
  MEETING_INPUT_PREAMBLE,
  MEETING_SYSTEM_PROMPT,
  NOTE_INPUT_PREAMBLE,
  SECTIONED_NOTES_FOOTER,
  SECTIONED_NOTES_FORMAT,
  SECTIONED_NOTES_INSTRUCTIONS,
  STANDALONE_PROMPT_KEYS,
  SUMMARY_ACTION_FROM_MATERIAL_PROMPT,
  SUMMARY_ACTION_SYSTEM_PROMPT,
} from "./builtinActions.js";

/**
 * Trimmed sections whose heading has text besides Markdown heading marks ("#"s
 * followed by a space); a non-list is no sections.
 */
export function normalizeSections(value) {
  if (!Array.isArray(value)) return [];
  return value
    .map((section) => ({
      heading: String(section?.heading ?? "")
        .trim()
        .replace(/^(?:#+(?:\s+|$))+/, ""),
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

export function compileSummaryActionPrompt(action, { fromSummary, isMeetingNote = false }) {
  if (fromSummary) return SUMMARY_ACTION_SYSTEM_PROMPT + action.prompt;
  const preamble = isMeetingNote ? MEETING_INPUT_PREAMBLE : NOTE_INPUT_PREAMBLE;
  return preamble + SUMMARY_ACTION_FROM_MATERIAL_PROMPT + action.prompt;
}

export function compileChatActionPrompt(action, { fromSummary }) {
  return (
    (fromSummary ? CHAT_ACTION_ON_SUMMARY_PREAMBLE : CHAT_ACTION_ON_MATERIAL_PREAMBLE) +
    action.prompt
  );
}

/**
 * What a template or a summary action reads. With a summary to work from, an
 * action gets it plus the user's notes and the meeting context for accuracy;
 * the transcript stays out, so the request always fits and is never split.
 * Otherwise the run reads the note's material, also returned in pieces so a
 * recording too long for a local model can be split along its transcript.
 */
export function buildNoteRunInput(action, { summary, notes, meetingContext, transcript }) {
  const join = (parts) => parts.filter(Boolean).join("\n\n");
  const hasNotes = notes.trim().length > 0;
  if (action.kind === "action" && summary?.trim()) {
    return {
      input: join([
        `## Current Summary\n${summary}`,
        hasNotes && `## My Notes\n${notes}`,
        meetingContext,
      ]),
      fromSummary: true,
    };
  }
  return {
    input: join([
      hasNotes && notes,
      meetingContext,
      transcript && `## Meeting Transcript\n${transcript}`,
    ]),
    fromSummary: false,
    material: { notes: hasNotes ? notes : "", meetingContext, transcript },
  };
}
