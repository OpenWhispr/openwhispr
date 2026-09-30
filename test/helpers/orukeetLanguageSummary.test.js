const test = require("node:test"),
  assert = require("node:assert/strict");
const { summarize } = require("../../scripts/summarize-orukeet-language-routing.cjs");
const event = {
  version: 1,
  eligible: true,
  legacyFallback: false,
  top05Fallback: false,
  candidate030: true,
  candidate010: true,
};
test("unlabeled observations measure disagreements but never claim recall or false positives", () => {
  const r = summarize([{ meta: event, text: "PRIVATE" }]);
  assert.equal(r.eligible, 1);
  assert.equal(r.labeled, 0);
  assert.equal(r.rules.candidate030.disagreesWithLegacy, 1);
  assert.equal(r.rules.candidate030.unsupportedTotal, 0);
  assert.equal(r.rules.candidate030.supportedTotal, 0);
  assert.doesNotMatch(JSON.stringify(r), /PRIVATE/);
});
test("reference annotations supply explicit denominators and incomplete windows stay separate", () => {
  const r = summarize([
    { comparison: event, expectedSupported: false },
    { ...event, expectedSupported: true },
    { ...event, eligible: false },
    { ...event, candidate030: null },
    { text: "private" },
    null,
  ]);
  assert.equal(r.events, 4);
  assert.equal(r.eligible, 2);
  assert.equal(r.labeled, 2);
  assert.equal(r.skipped, 3);
  assert.equal(r.rules.candidate030.unsupportedCaught, 1);
  assert.equal(r.rules.candidate030.unsupportedTotal, 1);
  assert.equal(r.rules.candidate030.supportedDiverted, 1);
  assert.equal(r.rules.candidate030.supportedTotal, 1);
});
