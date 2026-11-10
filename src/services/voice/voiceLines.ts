// What the call itself says, in the language it speaks. That language is the
// call's own setting, separate from the UI language, and includes Hindi, which
// isn't a UI locale, so these lines live here rather than in the locale files.
// The Hindi lines avoid first-person verbs, which would mark the speaker's gender.

import type { InteractionQuestion } from "../../types/agentInteractions";
import type { SpokenLanguage } from "./types";

export type { SpokenLanguage };
type ToolFiller = "web" | "notes" | "calendar" | "other";

interface VoiceLines {
  fillers: Record<ToolFiller, string>;
  /** Spoken after a reply cut short for speech; the transcript has all of it. */
  moreInChat: string;
  /** Spoken when a card waits on the user that speech can't answer (a connection, a key). */
  onScreen: string;
  /** Spoken when an answer card waits on Send, which speech never presses. */
  onScreenToSend: string;
}

const LINES: Record<SpokenLanguage, VoiceLines> = {
  en: {
    fillers: {
      web: "Let me look that up.",
      notes: "Let me check your notes.",
      calendar: "Let me check your calendar.",
      other: "One moment.",
    },
    moreInChat: "The rest is in the chat.",
    onScreen: "It's on your screen.",
    onScreenToSend: "It's on your screen. Review it, then press Send.",
  },
  hi: {
    fillers: {
      web: "इंटरनेट पर देखते हैं।",
      notes: "आपके नोट्स देखते हैं।",
      calendar: "आपका कैलेंडर देखते हैं।",
      other: "एक पल रुकिए।",
    },
    moreInChat: "बाकी जवाब चैट में है।",
    onScreen: "यह आपकी स्क्रीन पर है।",
    onScreenToSend: "यह आपकी स्क्रीन पर है। देखकर सेंड दबाइए।",
  },
  es: {
    fillers: {
      web: "Déjame buscarlo.",
      notes: "Déjame revisar tus notas.",
      calendar: "Déjame revisar tu calendario.",
      other: "Un momento.",
    },
    moreInChat: "El resto está en el chat.",
    onScreen: "Está en tu pantalla.",
    onScreenToSend: "Está en tu pantalla. Revísalo y haz clic en Enviar.",
  },
  fr: {
    fillers: {
      web: "Je fais une recherche.",
      notes: "Je regarde vos notes.",
      calendar: "Je regarde votre agenda.",
      other: "Un instant.",
    },
    moreInChat: "La suite est dans le chat.",
    onScreen: "C'est à l'écran.",
    onScreenToSend: "C'est à l'écran. Vérifiez-le, puis cliquez sur Envoyer.",
  },
  de: {
    fillers: {
      web: "Ich schaue kurz nach.",
      notes: "Ich sehe in deinen Notizen nach.",
      calendar: "Ich sehe in deinen Kalender.",
      other: "Einen Moment.",
    },
    moreInChat: "Der Rest steht im Chat.",
    onScreen: "Es ist auf deinem Bildschirm.",
    onScreenToSend: "Es ist auf deinem Bildschirm. Prüf es und klick dann auf Senden.",
  },
};

export const SPOKEN_LANGUAGES = Object.keys(LINES) as SpokenLanguage[];

export const isSpokenLanguage = (value: string): value is SpokenLanguage =>
  Object.hasOwn(LINES, value);

/** Every line a call may say while it works, so a session can prepare their audio. */
export function preparedLines(language: SpokenLanguage): string[] {
  const { fillers, moreInChat, onScreen, onScreenToSend } = LINES[language];
  return [...Object.values(fillers), moreInChat, onScreen, onScreenToSend];
}

/** What to say while these tools run, so the wait isn't silent. */
export function toolFiller(toolNames: readonly string[], language: SpokenLanguage): string {
  const { fillers } = LINES[language];
  if (toolNames.includes("web_search")) return fillers.web;
  if (toolNames.some((name) => name === "search_notes" || name === "get_note")) {
    return fillers.notes;
  }
  if (toolNames.some((name) => name.startsWith("get_calendar"))) return fillers.calendar;
  return fillers.other;
}

export const moreInChatLine = (language: SpokenLanguage): string => LINES[language].moreInChat;

export const onScreenLine = (language: SpokenLanguage, awaitsSend = false): string =>
  awaitsSend ? LINES[language].onScreenToSend : LINES[language].onScreen;

// A choice question reads out this many options at most; more are left to the screen.
const MAX_SPOKEN_OPTIONS = 4;

/** A question as the call asks it: its prompt, then its options ("A, B, or C"). */
export function questionLine(
  { prompt, options = [] }: Pick<InteractionQuestion, "prompt" | "options">,
  language: SpokenLanguage
): string {
  if (options.length === 0) return prompt;
  if (options.length > MAX_SPOKEN_OPTIONS) return `${prompt} ${LINES[language].onScreen}`;
  const labels = options.map((option) => option.label);
  return `${prompt} ${new Intl.ListFormat(language, { type: "disjunction" }).format(labels)}.`;
}

// Said alone over a reply, these stop it; any other single word ("okay",
// "please", "yeah") is a backchannel, and the reply goes on.
const STOP_WORDS = new Set(
  [
    "stop",
    "wait",
    "cancel",
    "enough",
    "quiet",
    "no",
    "para",
    "espera",
    "basta",
    "cancela",
    "calla",
    "arrête",
    "arrete",
    "attends",
    "annule",
    "stoppe",
    "non",
    "stopp",
    "warte",
    "halt",
    "abbrechen",
    "nein",
    "रुको",
    "रुकिए",
    "बस",
    "ठहरो",
    "नहीं",
  ].map((word) => word.normalize("NFC"))
);

/**
 * What words said over a reply mean: nothing (a backchannel or noise), stop it,
 * or a new request. A single word is never a request on its own.
 */
export function interruptionKind(text: string): "ignore" | "stop" | "request" {
  const words =
    text
      .normalize("NFC")
      .toLowerCase()
      .match(/[\p{L}\p{M}'’]+/gu) ?? [];
  if (words.length >= 2) return "request";
  return words.length === 1 && STOP_WORDS.has(words[0]) ? "stop" : "ignore";
}

const WORDS: Record<Exclude<SpokenLanguage, "hi">, ReadonlySet<string>> = {
  en: new Set("the and is you to of it that your have for what this are with".split(" ")),
  es: new Set("el la los las que y es un una por para tu con no en del".split(" ")),
  fr: new Set("le la les et est vous de des un une que pour pas je avec dans".split(" ")),
  de: new Set("der die das und ist ich du nicht ein eine zu mit den dem es".split(" ")),
};
const LETTERS: Array<[RegExp, SpokenLanguage]> = [
  [/[ñ¿¡]/i, "es"],
  [/[çœèêàù]/i, "fr"],
  [/[äöüß]/i, "de"],
];

/**
 * The language a reply in Auto is written in, among those the call speaks: by
 * script, telling letters, then common words. Null when nothing tells.
 */
export function detectSpokenLanguage(text: string): SpokenLanguage | null {
  if (/[ऀ-ॿ]/.test(text)) return "hi";
  const scores = new Map<SpokenLanguage, number>();
  for (const [pattern, language] of LETTERS) {
    if (pattern.test(text)) scores.set(language, 2);
  }
  for (const word of text.toLowerCase().match(/\p{L}+/gu) ?? []) {
    for (const [language, words] of Object.entries(WORDS) as Array<
      [SpokenLanguage, ReadonlySet<string>]
    >) {
      if (words.has(word)) scores.set(language, (scores.get(language) ?? 0) + 1);
    }
  }
  let best: SpokenLanguage | null = null;
  let bestScore = 0;
  for (const [language, score] of scores) {
    if (score > bestScore) {
      best = language;
      bestScore = score;
    }
  }
  return best;
}
