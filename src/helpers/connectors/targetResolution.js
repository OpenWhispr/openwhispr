const MAX_CANDIDATES = 5;

// Case, accents, spaces and punctuation don't tell apart the names people
// say aloud: "Eng Backend", "eng-backend" and "eng_backend" are one name.
function normalizeName(value) {
  return String(value ?? "")
    .normalize("NFKD")
    .replace(/\p{M}/gu, "")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]/gu, "");
}

function distinctById(candidates) {
  const byId = new Map();
  for (const candidate of candidates) {
    if (!byId.has(candidate.id)) byId.set(candidate.id, candidate);
  }
  return [...byId.values()];
}

// Stages run in order and the first stage with any match decides: an exact
// name never loses to a longer one that merely starts the same way, and two
// matches at the same stage are always ambiguous, never guessed. exactOnly
// is for incomplete candidate lists, where a looser match elsewhere could
// have been missed.
function resolveTarget(query, candidates, { exactOnly = false } = {}) {
  const raw = String(query ?? "").trim();
  const normalized = normalizeName(raw);
  if (!normalized) return { status: "none" };

  const stages = [
    (name) => name === raw,
    (name) => normalizeName(name) === normalized,
    (name) => normalizeName(name).startsWith(normalized),
  ];
  for (const matches of exactOnly ? stages.slice(0, 1) : stages) {
    const found = distinctById(
      candidates.filter((candidate) =>
        candidate.names.some((name) => Boolean(name) && matches(name))
      )
    );
    if (found.length === 1) return { status: "match", candidate: found[0] };
    if (found.length > 1)
      return { status: "ambiguous", candidates: found.slice(0, MAX_CANDIDATES) };
  }
  return { status: "none" };
}

module.exports = { resolveTarget, normalizeName, MAX_CANDIDATES };
