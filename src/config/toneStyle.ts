// Tone & Style: the tone dictation cleanup writes in, picked per kind of app.
// Category and tone values are the ones openwhispr-api's /api/reason accepts
// (`appCategory`, `tone`); main's toneAppCategories.js returns the same categories.

export const TONE_APP_CATEGORIES = ["personal", "work", "email", "other"] as const;
export type ToneAppCategory = (typeof TONE_APP_CATEGORIES)[number];

export type DictationTone = "formal" | "casual" | "very_casual" | "excited";

export const TONE_OPTIONS: Record<ToneAppCategory, readonly DictationTone[]> = {
  personal: ["formal", "casual", "very_casual"],
  work: ["formal", "casual", "excited"],
  email: ["formal", "casual", "excited"],
  other: ["formal", "casual", "excited"],
};

export type ToneStyles = Record<ToneAppCategory, DictationTone>;

// The design's preselected picks.
export const DEFAULT_TONE_STYLES: ToneStyles = {
  personal: "casual",
  work: "formal",
  email: "formal",
  other: "formal",
};

// Words dictated before the setup dialog opens by itself on Home.
export const TONE_STYLE_PROMPT_MIN_WORDS = 70;

/** What one dictation's cleanup is told: the app's category and the tone picked for it. */
export interface DictationToneStyle {
  appCategory: ToneAppCategory;
  tone: DictationTone;
}

/** Reads the stored JSON, keeping only tones offered for each category. */
export function normalizeToneStyles(value: string): ToneStyles {
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    parsed = null;
  }
  const stored = (parsed && typeof parsed === "object" ? parsed : {}) as Record<string, unknown>;
  return Object.fromEntries(
    TONE_APP_CATEGORIES.map((category) => {
      const tone = stored[category];
      return [
        category,
        TONE_OPTIONS[category].includes(tone as DictationTone)
          ? tone
          : DEFAULT_TONE_STYLES[category],
      ];
    })
  ) as ToneStyles;
}

export function resolveDictationToneStyle(
  toneStyles: ToneStyles,
  appCategory: ToneAppCategory | null
): DictationToneStyle {
  const category = appCategory ?? "other";
  return { appCategory: category, tone: toneStyles[category] };
}
