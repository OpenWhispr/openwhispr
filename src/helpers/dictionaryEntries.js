const fs = require("fs");
const os = require("os");
const path = require("path");

const DEFAULT_KIND = "manual";
const DEFAULT_SOURCE = "manual";

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
  buildOtterGlossaryEntries,
  loadOtterGlossaryEntries,
};
