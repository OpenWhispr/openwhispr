export const CLEANUP_LEVELS = ["none", "light", "medium", "high"] as const;

export type CleanupLevel = (typeof CLEANUP_LEVELS)[number];

const CLEANUP_LEVEL_SET = new Set<string>(CLEANUP_LEVELS);

// Existing installs only have the legacy on/off setting. Medium preserves the
// established cleanup prompt; disabled users migrate to None without behavior change.
export function normalizeCleanupLevel(
  value: string | null | undefined,
  cleanupEnabled = true
): CleanupLevel {
  if (value && CLEANUP_LEVEL_SET.has(value)) return value as CleanupLevel;
  return cleanupEnabled ? "medium" : "none";
}

export function getCleanupLevelForEnabled(
  enabled: boolean,
  currentLevel: CleanupLevel
): CleanupLevel {
  if (!enabled) return "none";
  return currentLevel === "none" ? "medium" : currentLevel;
}

const LEVEL_INSTRUCTIONS: Record<Exclude<CleanupLevel, "none" | "medium">, string> = {
  light:
    "CLEANUP LEVEL: LIGHT\nMake only conservative edits: remove filler words and fix clear grammar, spelling, capitalization, and punctuation errors. Preserve the speaker's wording, length, order, and structure. Do not rephrase for style or concision.",
  high: "CLEANUP LEVEL: HIGH\nRewrite for brevity and polish while preserving every fact, instruction, proper noun, technical term, and the speaker's intended tone. Remove redundancy, tighten phrasing, and improve structure. Never add new information or answer the transcript.",
};

export function applyCleanupLevel(prompt: string, level: CleanupLevel): string {
  if (level === "none" || level === "medium") return prompt;
  return `${prompt}\n\n${LEVEL_INSTRUCTIONS[level]}`;
}

export function getCleanupPromptOverride(
  customPrompt: string,
  level: CleanupLevel,
  defaultPrompt: string
): string | undefined {
  if (level === "none") return undefined;
  if (customPrompt) return customPrompt;
  if (level === "light" || level === "high") return applyCleanupLevel(defaultPrompt, level);
  return undefined;
}
