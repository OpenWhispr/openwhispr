// Rule-based checks for cleanup and agent results. Meaning changes are judged
// separately (by a reviewer); these rules catch the deal-breakers that a rule
// can see: a cleanup that answers instead of tidying, echoed instructions, an
// agent that sends something nobody asked for.
const lower = (v) => String(v ?? "").toLowerCase();
// Punctuation and hyphens do not change whether a phrase was kept ("all hands" / "all-hands").
const loose = (v) =>
  lower(v)
    .normalize("NFKC")
    .replace(/[\p{P}\p{S}]/gu, " ")
    .replace(/\s+/g, " ")
    .trim();

export function cleanupRuleCheck(caseObj, output, instructionMarkers = []) {
  const out = lower(output);
  const outLoose = loose(output);
  const inputLoose = loose(caseObj.input);
  const keptAll = caseObj.mustKeep.every((phrase) => outLoose.includes(loose(phrase)));
  // A marker the speaker actually dictated is not an echo.
  const echoedInstructions = instructionMarkers.some(
    (m) => m && !inputLoose.includes(m) && outLoose.includes(m)
  );
  const answered = (caseObj.kind === "instruction" || caseObj.kind === "question") && !keptAll;
  const emptied = !out.trim();
  return { keptAll, answered, echoedInstructions, emptied };
}

// Every sentence of four or more words in the cleanup instructions, examples
// included: a faithful cleanup prints none of them unless the speaker said it.
export function instructionMarkersFrom(systemPrompt) {
  return systemPrompt
    .split(/\n+|(?<=[.!?])\s+/)
    .map((s) => loose(s.replace(/^\s*(?:-\s*|input:\s*|output:\s*)/i, "")))
    .filter((s) => s.split(" ").length >= 4);
}

function matches(matcher, value) {
  if (matcher.equals !== undefined) return lower(value) === lower(matcher.equals);
  if (matcher.includes !== undefined) {
    const needle = lower(matcher.includes);
    return Array.isArray(value)
      ? value.some((v) => lower(v).includes(needle))
      : lower(value).includes(needle);
  }
  if (matcher.isoDate) return typeof value === "string" && !Number.isNaN(Date.parse(value));
  return false;
}

export function agentCheck(task, calls, { sendTools = [], writeTools = new Set() } = {}) {
  const sentUnasked = calls.some(
    (c) => sendTools.includes(c.name) && !task.expect.some((e) => e.tool === c.name)
  );
  if (task.kind === "no-tool")
    return {
      correct: calls.length === 0,
      sentUnasked,
      reason: calls.length ? "called a tool" : null,
    };
  let cursor = 0;
  for (const expected of task.expect) {
    const found = calls.findIndex(
      (c, i) =>
        i >= cursor &&
        c.name === expected.tool &&
        Object.entries(expected.args || {}).every(([k, m]) => matches(m, c.args?.[k]))
    );
    if (found === -1) return { correct: false, sentUnasked, reason: `missing ${expected.tool}` };
    cursor = found + 1;
  }
  const unexpectedWrite = calls.find(
    (c) => writeTools.has(c.name) && !task.expect.some((e) => e.tool === c.name)
  );
  if (unexpectedWrite)
    return { correct: false, sentUnasked, reason: `unasked ${unexpectedWrite.name}` };
  if (task.kind === "draft-only" && sentUnasked)
    return { correct: false, sentUnasked, reason: "sent instead of drafting" };
  return { correct: true, sentUnasked, reason: null };
}
