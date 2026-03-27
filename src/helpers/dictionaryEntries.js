const fs = require("fs");
const os = require("os");
const path = require("path");

const DEFAULT_KIND = "manual";
const DEFAULT_SOURCE = "manual";
const DEFAULT_PROMPT_BUDGET = 900;

const KIND_SCORES = {
  manual: 520,
  person: 420,
  technical: 320,
  project: 260,
  organization: 220,
  legacy: 140,
};

const SOURCE_SCORES = {
  manual: 140,
  auto_learn: 120,
  otter_glossary: 60,
  legacy: 20,
};

const PROMPT_BUDGETS = {
  groq: 896,
  openai: 900,
  mistral: 900,
  deepgram: 900,
  assemblyai: 900,
  "openwhispr-cloud": 900,
  "local-whisper": 1600,
  reasoning: 1200,
};

const GLOSSARY_BLOCKLIST = new Set([
  "My bank accounts",
  "Bank accounts",
  "SJN Ventures bank accounts",
]);

function normalizeDictionaryTerm(term) {
  return String(term || "")
    .replace(/\s+/g, " ")
    .trim();
}

function sanitizeDictionaryEntry(entry) {
  const term = normalizeDictionaryTerm(entry?.term);
  if (!term) return null;

  return {
    id: entry?.id,
    term,
    normalizedTerm: term.toLowerCase(),
    kind: entry?.kind || DEFAULT_KIND,
    source: entry?.source || DEFAULT_SOURCE,
    priority: Number.isFinite(entry?.priority) ? Number(entry.priority) : 100,
    pinned: Boolean(entry?.pinned),
    enabled: entry?.enabled !== false,
    createdAt: entry?.createdAt,
    updatedAt: entry?.updatedAt,
  };
}

function mergeEntries(currentEntry, nextEntry) {
  const nextWins =
    Number(Boolean(nextEntry.pinned)) > Number(Boolean(currentEntry.pinned)) ||
    nextEntry.priority > currentEntry.priority;
  const winner = nextWins ? nextEntry : currentEntry;
  const loser = nextWins ? currentEntry : nextEntry;

  return {
    ...winner,
    term: winner.term.length >= loser.term.length ? winner.term : loser.term,
    normalizedTerm: winner.normalizedTerm || loser.normalizedTerm,
    priority: Math.max(currentEntry.priority, nextEntry.priority),
    pinned: currentEntry.pinned || nextEntry.pinned,
    enabled: currentEntry.enabled || nextEntry.enabled,
    createdAt: currentEntry.createdAt || nextEntry.createdAt,
    updatedAt: nextEntry.updatedAt || currentEntry.updatedAt,
  };
}

function getSelectionScore(entry, agentName = null) {
  let score =
    (Number.isFinite(entry.priority) ? Number(entry.priority) : 100) +
    (KIND_SCORES[entry.kind] || 0) +
    (SOURCE_SCORES[entry.source] || 0);

  if (entry.pinned) score += 10_000;

  const normalizedAgentName = normalizeDictionaryTerm(agentName || "").toLowerCase();
  if (normalizedAgentName && entry.normalizedTerm === normalizedAgentName) {
    score += 20_000;
  }

  if (entry.term.length <= 24) score += 15;

  return score;
}

function dedupeDictionaryEntries(entries) {
  const byTerm = new Map();

  for (const rawEntry of entries || []) {
    const entry = sanitizeDictionaryEntry(rawEntry);
    if (!entry) continue;

    const existing = byTerm.get(entry.normalizedTerm);
    if (!existing) {
      byTerm.set(entry.normalizedTerm, entry);
      continue;
    }

    byTerm.set(entry.normalizedTerm, mergeEntries(existing, entry));
  }

  return Array.from(byTerm.values());
}

function getDictionaryWords(entries) {
  return dedupeDictionaryEntries(entries)
    .filter((entry) => entry.enabled)
    .map((entry) => entry.term);
}

function createDictionaryEntriesFromWords(words, existingEntries = []) {
  const currentEntries = dedupeDictionaryEntries(existingEntries);
  const currentByTerm = new Map(currentEntries.map((entry) => [entry.normalizedTerm, entry]));
  const nextEntries = [];

  for (const word of words || []) {
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

function mergeDictionaryEntries(existingEntries, incomingEntries) {
  return dedupeDictionaryEntries([...(existingEntries || []), ...(incomingEntries || [])]);
}

function getDictionaryPromptBudget(provider) {
  if (!provider) return DEFAULT_PROMPT_BUDGET;
  return PROMPT_BUDGETS[provider] || DEFAULT_PROMPT_BUDGET;
}

function buildDictionaryPrompt(entries, options = {}) {
  const normalizedEntries =
    Array.isArray(entries) && typeof entries[0] === "string"
      ? createDictionaryEntriesFromWords(entries)
      : dedupeDictionaryEntries(entries || []);
  const enabledEntries = normalizedEntries.filter((entry) => entry.enabled);
  const maxChars =
    options.maxChars ?? getDictionaryPromptBudget(options.provider);

  const rankedEntries = [...enabledEntries].sort((left, right) => {
    const scoreDelta =
      getSelectionScore(right, options.agentName) - getSelectionScore(left, options.agentName);
    if (scoreDelta !== 0) return scoreDelta;

    const pinnedDelta = Number(Boolean(right.pinned)) - Number(Boolean(left.pinned));
    if (pinnedDelta !== 0) return pinnedDelta;

    const priorityDelta = (right.priority || 0) - (left.priority || 0);
    if (priorityDelta !== 0) return priorityDelta;

    return left.term.localeCompare(right.term);
  });

  const selectedEntries = [];
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

function shouldSkipGlossaryTerm(term, kind) {
  if (!term) return true;
  if (GLOSSARY_BLOCKLIST.has(term)) return true;
  if (!/[A-Za-z]/.test(term)) return true;
  if (term.length > 80) return true;
  if (kind === "person" && term.split(/\s+/).length > 5) return true;
  if (kind === "person" && /\b(account|accounts|grant|meeting|project)\b/i.test(term)) return true;
  return false;
}

function buildOtterGlossaryEntries(glossary) {
  const entries = [];

  const people = glossary?.people || {};
  for (const value of Object.values(people)) {
    const displayName = normalizeDictionaryTerm(value?.display_name);
    if (!shouldSkipGlossaryTerm(displayName, "person")) {
      entries.push({
        term: displayName,
        kind: "person",
        source: "otter_glossary",
        priority: 85,
      });
    }

    for (const alias of value?.aliases || []) {
      const term = normalizeDictionaryTerm(alias);
      if (!shouldSkipGlossaryTerm(term, "person")) {
        entries.push({
          term,
          kind: "person",
          source: "otter_glossary",
          priority: 72,
        });
      }
    }
  }

  const organizations = glossary?.organizations || {};
  for (const value of Object.values(organizations)) {
    const term = normalizeDictionaryTerm(value?.correct);
    if (!shouldSkipGlossaryTerm(term, "organization")) {
      entries.push({
        term,
        kind: "organization",
        source: "otter_glossary",
        priority: 55,
      });
    }
  }

  const projects = glossary?.projects || {};
  for (const value of Object.values(projects)) {
    const term = normalizeDictionaryTerm(value?.name);
    if (!shouldSkipGlossaryTerm(term, "project")) {
      entries.push({
        term,
        kind: "project",
        source: "otter_glossary",
        priority: 62,
      });
    }
  }

  const technicalTerms = glossary?.technical_terms || {};
  for (const value of Object.values(technicalTerms)) {
    const term = normalizeDictionaryTerm(value?.correct);
    if (!shouldSkipGlossaryTerm(term, "technical")) {
      entries.push({
        term,
        kind: "technical",
        source: "otter_glossary",
        priority: 58,
      });
    }
  }

  return dedupeDictionaryEntries(entries);
}

function loadOtterGlossaryEntries() {
  const glossaryPath = path.join(os.homedir(), ".claude", "data", "otter", "domain-glossary.json");
  if (!fs.existsSync(glossaryPath)) {
    throw new Error(`Otter glossary not found at ${glossaryPath}`);
  }

  const glossary = JSON.parse(fs.readFileSync(glossaryPath, "utf8"));
  return buildOtterGlossaryEntries(glossary);
}

module.exports = {
  normalizeDictionaryTerm,
  sanitizeDictionaryEntry,
  dedupeDictionaryEntries,
  getDictionaryWords,
  createDictionaryEntriesFromWords,
  mergeDictionaryEntries,
  getDictionaryPromptBudget,
  buildDictionaryPrompt,
  buildOtterGlossaryEntries,
  loadOtterGlossaryEntries,
};
