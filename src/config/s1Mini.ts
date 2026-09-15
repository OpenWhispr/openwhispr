// https://huggingface.co/superwhisper/s1-mini
export const S1_MINI_SYSTEM_PROMPT =
  "You are a text normalizer for speech-to-text transcripts. The input begins " +
  "with a control line specifying the styling, structure, and context settings; " +
  "clean the transcript to match those settings and output only the cleaned text.";

export const S1_MINI_OPTIONS = {
  styling: ["casual", "semi-casual", "semi-formal", "formal"],
  structure: ["prose", "lists"],
  context: ["general", "email"],
} as const;

export type S1MiniOptions = {
  [K in keyof typeof S1_MINI_OPTIONS]: (typeof S1_MINI_OPTIONS)[K][number];
};

export const S1_MINI_DEFAULTS: S1MiniOptions = {
  styling: "semi-formal",
  structure: "prose",
  context: "general",
};

export function isS1MiniModel(model: string): boolean {
  return /(?:^|[/\\])s1-mini(?:$|[-_.:])/i.test(model.trim());
}

export function normalizeS1MiniOptions(value: Partial<S1MiniOptions> = {}): S1MiniOptions {
  return Object.fromEntries(
    Object.entries(S1_MINI_OPTIONS).map(([key, values]) => [
      key,
      (values as readonly unknown[]).includes(value[key as keyof S1MiniOptions])
        ? value[key as keyof S1MiniOptions]
        : S1_MINI_DEFAULTS[key as keyof S1MiniOptions],
    ])
  ) as S1MiniOptions;
}

export function formatS1MiniTranscript(text: string, options: Partial<S1MiniOptions>): string {
  const { styling, structure, context } = normalizeS1MiniOptions(options);
  return `[Styling: ${styling}] [Structure: ${structure}] [Context: ${context}]\n${text}`;
}
