import {
  TONE_APP_CATEGORIES,
  type DictationTone,
  type DictationToneStyle,
  type ToneAppCategory,
  type ToneStyles,
} from "../toneStyle";

// What each tone does. Cleanup wraps it into the exact TONE_INSTRUCTIONS
// sentences of openwhispr-api's lib/prompts.ts (with APP_CATEGORY_INSTRUCTIONS
// and TONE_PRIORITY_INSTRUCTION copied verbatim below), which Cloud cleanup
// appends for the same `tone` and `appCategory`; change both together. The
// chat's writing-style block lists the rules as they are. English in every
// locale, as on the server.
const TONE_RULES: Record<DictationTone, string> = {
  formal:
    "formal and polished. Use complete sentences with standard capitalization and full punctuation, spell out informal contractions (in English: I will, do not) but keep any the language's grammar requires, and leave out slang, filler, texting shorthand, emoji and em dashes.",
  casual:
    "casual and friendly, like a quick note to a colleague. Use the language's everyday contractions (in English: I'll, it's, don't) and everyday wording, standard capitalization and light punctuation with no semicolons or em dashes; a final period can be dropped.",
  very_casual:
    'very casual, like texting a friend. Write in all lowercase and keep punctuation light: a question still ends with a question mark, but drop the final period and never use em dashes. Use texting shorthand common in the output language only where it stands for the exact words (in English: "u" for you, "lmk" for let me know).',
  excited:
    "upbeat and enthusiastic. Use standard capitalization and warm, energetic wording, and end positive or friendly sentences with an exclamation mark, without overdoing it. Use commas or periods, never semicolons or em dashes, and no emoji.",
};

const toneInstruction = (tone: DictationTone) =>
  `Apply this tone: ${TONE_RULES[tone]} Restyle only; do not add or remove information.`;

const APP_CATEGORY_INSTRUCTIONS: Partial<Record<ToneAppCategory, string>> = {
  personal: "The text is a personal chat message.",
  work: "The text is a work chat message.",
  email:
    "The text is an email. Keep a dictated greeting, paragraphs and sign-off on their own lines, and never add a greeting or sign-off that was not dictated.",
};

const TONE_PRIORITY_INSTRUCTION =
  "This tone overrides any instruction to keep the speaker's tone, voice, style, wording or formality, and it sets capitalization and punctuation; names, acronyms and dictionary terms keep their exact spelling and capitalization. It never changes meaning or intent. Every other cleanup rule still applies.";

// Appended last, after the language and dictionary suffixes, as the server does.
export function appendToneStyleSuffix(prompt: string, toneStyle?: DictationToneStyle | null) {
  if (!toneStyle) return prompt;
  const instruction = [
    APP_CATEGORY_INSTRUCTIONS[toneStyle.appCategory],
    toneInstruction(toneStyle.tone),
    TONE_PRIORITY_INSTRUCTION,
  ]
    .filter(Boolean)
    .join(" ");
  return `${prompt}\n\n${instruction}`;
}

const WRITING_KINDS: Record<
  ToneAppCategory,
  { label: string; examples: string; style: string; destination: string }
> = {
  personal: {
    label: "Personal messages",
    examples: "texts, WhatsApp, iMessage, Telegram, Instagram",
    style: "personal message",
    destination: "a personal messaging app",
  },
  work: {
    label: "Work messages",
    examples: "Slack, Teams, Google Chat, LinkedIn",
    style: "work message",
    destination: "a work chat app",
  },
  email: {
    label: "Emails",
    examples: "any email, including an email_draft body",
    style: "email",
    destination: "an email app",
  },
  other: {
    label: "Everything else",
    examples: "posts, notes, documents, issues and comments",
    style: "general writing",
    destination: "an app other than chat or email",
  },
};

// Cleanup's priority sentence keeps these exact under any tone; the chat and
// selection edits use the rules without it, so they say it themselves.
const KEEP_NAMES =
  "Names, acronyms and dictionary terms keep their exact spelling and capitalization.";

// IDEs and terminals count as "other", so a rewrite there is often code.
const KEEP_CODE =
  "A tone applies to prose only: code and commands, with their strings and comments, are never restyled.";

const WRITING_STYLE_RULES = `${KEEP_NAMES} ${KEEP_CODE} Never sign or add a name to a personal or work message. Never use em dashes in text written as the user's own words. A tone the user asks for always wins.`;

function writingKindList(tones: ToneStyles): string[] {
  return TONE_APP_CATEGORIES.map(
    (category) =>
      `- ${WRITING_KINDS[category].label} (${WRITING_KINDS[category].examples}): ${TONE_RULES[tones[category]]}`
  );
}

/**
 * The chat's guide to writing in the user's own tone. With `destination`, the
 * kind of app the assistant will type its answer into, that app's style is the
 * one for the reply; text written through a tool still goes by its own kind.
 * Otherwise the model works out which kind of text a request is for from the
 * request, the recipient and the tool, and picks its style.
 */
export function buildWritingStyleBlock(
  tones: ToneStyles,
  destination?: ToneAppCategory | null
): string {
  if (destination) {
    const kind = WRITING_KINDS[destination];
    return [
      `WRITING STYLE: Your reply will be typed at the user's cursor in ${kind.destination}, as their own words. Write the reply as only the text that goes there (no subject line or label), in the user's ${kind.style} style: ${TONE_RULES[tones[destination]]}`,
      "That style is for the reply only. Text you write through a tool (an email_draft body, a message you send) takes the user's style for its own kind:",
      ...writingKindList(tones),
      WRITING_STYLE_RULES,
    ].join("\n");
  }
  return [
    "WRITING STYLE: When you write something the user will send or keep as their own words (a message, email, reply, post, comment or note), write it the way they write that kind of text. Work out which kind it is from the request, the recipient and the tool you use, and use only that kind's style:",
    ...writingKindList(tones),
    `${WRITING_STYLE_RULES} Your own answers, explanations and summaries keep your usual voice.`,
  ].join("\n");
}

// For an in-place edit of selected text: only a rewrite the user asked for
// without a tone takes the style of the app the selection is in.
export function selectionEditToneSentence(toneStyle: DictationToneStyle): string {
  return `If the instruction asks you to rewrite, reword or draft the text and names no tone, write it in the user's ${WRITING_KINDS[toneStyle.appCategory].style} style: ${TONE_RULES[toneStyle.tone]} ${KEEP_NAMES} ${KEEP_CODE}`;
}
