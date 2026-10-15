#!/usr/bin/env node
// Accept exported comparison events as JSONL; output counts, never recordings or text.
const fs = require("node:fs");
function summarize(records) {
  const result = { events: 0, eligible: 0, skipped: 0, labeled: 0, rules: {} };
  for (const name of ["legacyFallback", "top05Fallback", "candidate030", "candidate010"])
    result.rules[name] = {
      fallback: 0,
      disagreesWithLegacy: 0,
      unsupportedCaught: 0,
      unsupportedTotal: 0,
      supportedDiverted: 0,
      supportedTotal: 0,
    };
  for (const record of records) {
    const row =
      record?.metadata?.orukeetLanguageRouting ??
      record?.orukeetLanguageRouting ??
      record?.meta ??
      record?.comparison ??
      record;
    if (
      row?.version !== 1 ||
      typeof row.eligible !== "boolean" ||
      typeof row.legacyFallback !== "boolean"
    ) {
      result.skipped++;
      continue;
    }
    result.events++;
    if (!row.eligible) continue;
    if (
      ![row.top05Fallback, row.candidate030, row.candidate010].every((v) => typeof v === "boolean")
    ) {
      result.skipped++;
      continue;
    }
    result.eligible++;
    // Ground truth must come from a human/reference label, never the detector's top guess.
    const expected = record.expectedSupported;
    if (typeof expected === "boolean") result.labeled++;
    for (const [name, counts] of Object.entries(result.rules)) {
      const fallback = row[name];
      counts.fallback += Number(fallback);
      counts.disagreesWithLegacy += Number(fallback !== row.legacyFallback);
      if (expected === false) {
        counts.unsupportedTotal++;
        counts.unsupportedCaught += Number(fallback);
      }
      if (expected === true) {
        counts.supportedTotal++;
        counts.supportedDiverted += Number(fallback);
      }
    }
  }
  return result;
}
if (require.main === module) {
  if (process.argv.length !== 3) {
    console.error(
      "Usage: node scripts/summarize-orukeet-language-routing.cjs comparison-events.jsonl"
    );
    process.exitCode = 2;
  } else {
    try {
      const rows = fs
        .readFileSync(process.argv[2], "utf8")
        .split(/\r?\n/)
        .filter((s) => s.trim())
        .map(JSON.parse);
      console.log(JSON.stringify(summarize(rows), null, 2));
    } catch {
      console.error("Unable to read comparison events as JSONL");
      process.exitCode = 1;
    }
  }
}
module.exports = { summarize };
