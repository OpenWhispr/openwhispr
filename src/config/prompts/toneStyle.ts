import type { DictationTone, DictationToneStyle, ToneAppCategory } from "../toneStyle";

// Verbatim copies of TONE_INSTRUCTIONS, APP_CATEGORY_INSTRUCTIONS and
// TONE_PRIORITY_INSTRUCTION in openwhispr-api's lib/prompts.ts, which Cloud
// cleanup appends for the same `tone` and `appCategory`; change both together.
// English in every locale, as on the server.
const TONE_INSTRUCTIONS: Record<DictationTone, string> = {
  formal:
    "Apply this tone: formal and polished. Use complete sentences with standard capitalization and full punctuation, spell out contractions (I will, do not), and leave out slang, filler, texting shorthand, emoji and em dashes. Restyle only; do not add or remove information.",
  casual:
    "Apply this tone: casual and friendly, like a quick note to a colleague. Use contractions (I'll, it's, don't) and everyday wording, standard capitalization and light punctuation with no semicolons or em dashes; a final period can be dropped. Restyle only; do not add or remove information.",
  very_casual:
    'Apply this tone: very casual, like texting a friend. Write in all lowercase and keep punctuation light: a question still ends with a question mark, but drop the final period and never use em dashes. Use texting shorthand only where it stands for the exact words, such as "u" for you or "lmk" for let me know. Restyle only; do not add or remove information.',
  excited:
    "Apply this tone: upbeat and enthusiastic. Use standard capitalization and warm, energetic wording, and end positive or friendly sentences with an exclamation mark, without overdoing it. Use commas or periods, never semicolons or em dashes, and no emoji. Restyle only; do not add or remove information.",
};

const APP_CATEGORY_INSTRUCTIONS: Partial<Record<ToneAppCategory, string>> = {
  personal: "The text is a personal chat message.",
  work: "The text is a work chat message.",
  email:
    "The text is an email. Keep a dictated greeting, paragraphs and sign-off on their own lines, and never add a greeting or sign-off that was not dictated.",
};

const TONE_PRIORITY_INSTRUCTION =
  "This tone overrides any instruction to keep the speaker's tone, voice, style, wording or formality; it never changes meaning or intent. Every other cleanup rule still applies.";

// Appended last, after the language and dictionary suffixes, as the server does.
export function appendToneStyleSuffix(prompt: string, toneStyle?: DictationToneStyle | null) {
  if (!toneStyle) return prompt;
  const instruction = [
    APP_CATEGORY_INSTRUCTIONS[toneStyle.appCategory],
    TONE_INSTRUCTIONS[toneStyle.tone],
    TONE_PRIORITY_INSTRUCTION,
  ]
    .filter(Boolean)
    .join(" ");
  return `${prompt}\n\n${instruction}`;
}
