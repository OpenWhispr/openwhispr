import type { DictionaryEntry, DictionaryPromptSelection } from "../types/dictionary";

const DEFAULT_KIND: DictionaryEntry["kind"] = "manual";
const DEFAULT_SOURCE: DictionaryEntry["source"] = "manual";

const KIND_SCORES: Record<DictionaryEntry["kind"], number> = {
  manual: 520,
  person: 420,
  technical: 320,
  project: 260,
  organization: 220,
  legacy: 140,
};

const SOURCE_SCORES: Record<DictionaryEntry["source"], number> = {
  manual: 140,
  auto_learn: 120,
  otter_glossary: 60,
  legacy: 20,
};

const DEFAULT_PROMPT_BUDGET = 900;
const PROMPT_BUDGETS: Record<string, number> = {
  groq: 896,
  openai: 900,
  mistral: 900,
  deepgram: 900,
  assemblyai: 900,
  "openwhispr-cloud": 900,
  "local-whisper": 1600,
  reasoning: 1200,
};

function toBoolean(value: unknown, fallback = true): boolean {
  if (typeof value === "boolean") return value;
  if (typeof value === "number") return value !== 0;
  return fallback;
}

export function normalizeDictionaryTerm(term: string): string {
  return term.replace(/\s+/g, " ").trim();
}

export function sanitizeDictionaryEntry(entry: Partial<DictionaryEntry>): DictionaryEntry | null {
  const term = normalizeDictionaryTerm(entry.term ?? "");
  if (!term) return null;

  return {
    id: entry.id,
    term,
    normalizedTerm: term.toLowerCase(),
    kind: entry.kind ?? DEFAULT_KIND,
    source: entry.source ?? DEFAULT_SOURCE,
    priority: Number.isFinite(entry.priority) ? Number(entry.priority) : 100,
    pinned: toBoolean(entry.pinned, false),
    enabled: toBoolean(entry.enabled, true),
    createdAt: entry.createdAt,
    updatedAt: entry.updatedAt,
  };
}

function getSelectionScore(entry: DictionaryEntry, agentName?: string | null): number {
  let score = entry.priority + KIND_SCORES[entry.kind] + SOURCE_SCORES[entry.source];

  if (entry.pinned) score += 10_000;

  const normalizedAgentName = normalizeDictionaryTerm(agentName ?? "").toLowerCase();
  if (normalizedAgentName && entry.normalizedTerm === normalizedAgentName) {
    score += 20_000;
  }

  if (entry.term.length <= 24) score += 15;

  return score;
}

function mergeDictionaryEntries(
  currentEntry: DictionaryEntry,
  nextEntry: DictionaryEntry
): DictionaryEntry {
  const currentScore = getSelectionScore(currentEntry);
  const nextScore = getSelectionScore(nextEntry);
  const winner = nextScore >= currentScore ? nextEntry : currentEntry;
  const loser = winner === nextEntry ? currentEntry : nextEntry;

  return {
    ...winner,
    term: winner.term.length >= loser.term.length ? winner.term : loser.term,
    normalizedTerm: winner.normalizedTerm ?? loser.normalizedTerm,
    priority: Math.max(currentEntry.priority, nextEntry.priority),
    pinned: currentEntry.pinned || nextEntry.pinned,
    enabled: currentEntry.enabled || nextEntry.enabled,
    createdAt: currentEntry.createdAt ?? nextEntry.createdAt,
    updatedAt: nextEntry.updatedAt ?? currentEntry.updatedAt,
  };
}

export function dedupeDictionaryEntries(entries: Partial<DictionaryEntry>[]): DictionaryEntry[] {
  const byTerm = new Map<string, DictionaryEntry>();

  for (const rawEntry of entries) {
    const entry = sanitizeDictionaryEntry(rawEntry);
    if (!entry) continue;

    const existing = byTerm.get(entry.normalizedTerm!);
    if (!existing) {
      byTerm.set(entry.normalizedTerm!, entry);
      continue;
    }

    byTerm.set(entry.normalizedTerm!, mergeDictionaryEntries(existing, entry));
  }

  return Array.from(byTerm.values());
}

export function getDictionaryTerms(entries: Partial<DictionaryEntry>[]): string[] {
  return dedupeDictionaryEntries(entries)
    .filter((entry) => entry.enabled)
    .map((entry) => entry.term);
}

export function createDictionaryEntriesFromWords(
  words: string[],
  existingEntries: Partial<DictionaryEntry>[] = []
): DictionaryEntry[] {
  const currentEntries = dedupeDictionaryEntries(existingEntries);
  const currentByTerm = new Map(currentEntries.map((entry) => [entry.normalizedTerm!, entry]));
  const nextEntries: DictionaryEntry[] = [];

  for (const word of words) {
    const term = normalizeDictionaryTerm(word);
    if (!term) continue;

    const normalizedTerm = term.toLowerCase();
    const existing = currentByTerm.get(normalizedTerm);

    nextEntries.push(
      existing
        ? {
            ...existing,
            term,
            normalizedTerm,
            enabled: true,
          }
        : {
            term,
            normalizedTerm,
            kind: "manual",
            source: "manual",
            priority: 100,
            pinned: false,
            enabled: true,
          }
    );
  }

  return dedupeDictionaryEntries(nextEntries);
}

export function getDictionaryPromptBudget(provider?: string | null): number {
  if (!provider) return DEFAULT_PROMPT_BUDGET;
  return PROMPT_BUDGETS[provider] ?? DEFAULT_PROMPT_BUDGET;
}

export function buildDictionaryPrompt(
  entries: Partial<DictionaryEntry>[] | string[],
  options: {
    provider?: string | null;
    maxChars?: number;
    agentName?: string | null;
  } = {}
): DictionaryPromptSelection {
  const normalizedEntries = Array.isArray(entries) && typeof entries[0] === "string"
    ? createDictionaryEntriesFromWords(entries as string[])
    : dedupeDictionaryEntries(entries as Partial<DictionaryEntry>[]);
  const enabledEntries = normalizedEntries.filter((entry) => entry.enabled);
  const maxChars = options.maxChars ?? getDictionaryPromptBudget(options.provider);

  const rankedEntries = [...enabledEntries].sort((left, right) => {
    const scoreDelta =
      getSelectionScore(right, options.agentName) - getSelectionScore(left, options.agentName);
    if (scoreDelta !== 0) return scoreDelta;

    const pinnedDelta = Number(right.pinned) - Number(left.pinned);
    if (pinnedDelta !== 0) return pinnedDelta;

    const priorityDelta = right.priority - left.priority;
    if (priorityDelta !== 0) return priorityDelta;

    return left.term.localeCompare(right.term);
  });

  const selectedEntries: DictionaryEntry[] = [];
  let currentChars = 0;

  for (const entry of rankedEntries) {
    const additionalChars = selectedEntries.length === 0 ? entry.term.length : entry.term.length + 2;
    if (currentChars + additionalChars > maxChars) continue;

    selectedEntries.push(entry);
    currentChars += additionalChars;
  }

  return {
    prompt: selectedEntries.length > 0 ? selectedEntries.map((entry) => entry.term).join(", ") : null,
    totalEntries: normalizedEntries.length,
    enabledEntries: enabledEntries.length,
    selectedEntries,
    droppedEntries: Math.max(0, enabledEntries.length - selectedEntries.length),
    maxChars,
  };
}
