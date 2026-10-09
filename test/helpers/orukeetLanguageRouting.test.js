const test = require("node:test");
const assert = require("node:assert/strict");
const load = () => import("../../src/helpers/dictationStreamingRouting.js");
const final = {
  success: true,
  language: "hi",
  languageConfidence: 0.55,
  languageSupportedScore: 0.02,
  languageAudioSeconds: 6,
};

test("shadow retains the current policy while comparing both supported-score cutoffs", async () => {
  const { evaluateOrukeetLanguageRouting: run } = await load();
  const result = run({ language: "auto", final, mode: "shadow" });
  assert.equal(result.fallback, false);
  assert.equal(result.comparison.legacyFallback, false);
  assert.equal(result.comparison.top05Fallback, true);
  assert.equal(result.comparison.candidate030, true);
  assert.equal(result.comparison.candidate010, true);
});

test("only explicit modes enable group-score fallback", async () => {
  const { evaluateOrukeetLanguageRouting: run } = await load();
  for (const mode of [undefined, null, "off", "", "enabled", true, { mode: "supported-0.30" }]) {
    assert.deepEqual(run({ language: "auto", final, mode }), { fallback: false, comparison: null });
  }
  for (const mode of ["supported-0.30", "supported-0.10"])
    assert.equal(run({ language: "auto", final, mode }).fallback, true);
});

test("exact boundaries, zero, one and separate cutoffs retain their meaning", async () => {
  const { evaluateOrukeetLanguageRouting: run } = await load();
  for (const [score, a, b] of [
    [0, true, true],
    [0.1, true, true],
    [0.100001, true, false],
    [0.3, true, false],
    [0.300001, false, false],
    [1, false, false],
  ]) {
    assert.equal(
      run({ final: { ...final, languageSupportedScore: score }, mode: "supported-0.30" }).fallback,
      a
    );
    assert.equal(
      run({ final: { ...final, languageSupportedScore: score }, mode: "supported-0.10" }).fallback,
      b
    );
  }
});

test("group evidence can override an uncertain supported top label or absent top label", async () => {
  const { evaluateOrukeetLanguageRouting: run } = await load();
  for (const language of ["en", null])
    assert.equal(
      run({
        final: { ...final, language, languageConfidence: language?.length ? 0.3 : null },
        mode: "supported-0.30",
      }).fallback,
      true
    );
});

test("explicit user languages always preserve existing routing", async () => {
  const { evaluateOrukeetLanguageRouting: run } = await load();
  for (const language of ["en", "en-US", "hi"]) {
    const r = run({ language, final, mode: "supported-0.30" });
    assert.equal(r.fallback, false);
    assert.equal(r.comparison.eligible, false);
  }
});

test("short, invalid or absent evidence retains the old decision", async () => {
  const { evaluateOrukeetLanguageRouting: run, shouldRetranscribeOrukeetLanguage: legacy } =
    await load();
  const cases = [null, undefined, { ...final, success: false }];
  for (const languageAudioSeconds of [undefined, null, NaN, Infinity, -1, 0, 3, 5.999])
    cases.push({ ...final, languageConfidence: 0.95, languageAudioSeconds });
  for (const languageSupportedScore of [undefined, null, NaN, Infinity, -0.01, 1.01, true, "0.02"])
    cases.push({ ...final, languageConfidence: 0.95, languageSupportedScore });
  for (const f of cases) {
    const r = run({ final: f, mode: "supported-0.30" });
    assert.equal(r.fallback, legacy({ final: f }));
    assert.equal(r.comparison.eligible, false);
  }
});

test("rolling back to off immediately restores the current decision", async () => {
  const { evaluateOrukeetLanguageRouting: run } = await load();
  assert.equal(run({ final, mode: "supported-0.30" }).fallback, true);
  assert.deepEqual(run({ final, mode: "off" }), { fallback: false, comparison: null });
});

test("comparison logs contain only the allowlisted metadata, including on malformed input", async () => {
  const { evaluateOrukeetLanguageRouting: run } = await load();
  const r = run({
    language: "auto",
    mode: "shadow",
    final: {
      ...final,
      text: "PRIVATE TRANSCRIPT",
      rawText: "PRIVATE",
      token: "SECRET",
      accountId: "PERSON",
      audio: Buffer.from("VOICE"),
    },
  });
  assert.deepEqual(
    Object.keys(r.comparison).sort(),
    [
      "version",
      "mode",
      "auto",
      "eligible",
      "analyzedSeconds",
      "topLanguage",
      "topScore",
      "supportedScore",
      "legacyFallback",
      "top05Fallback",
      "candidate030",
      "candidate010",
      "selectedFallback",
    ].sort()
  );
  assert.doesNotMatch(JSON.stringify(r), /PRIVATE|SECRET|PERSON|VOICE/);
  const bad = run({
    final: {
      ...final,
      language: "PRIVATE TRANSCRIPT",
      languageConfidence: "SECRET",
      languageSupportedScore: NaN,
      languageAudioSeconds: "VOICE",
    },
    mode: "shadow",
  });
  assert.equal(bad.comparison.topLanguage, null);
  assert.equal(bad.comparison.topScore, null);
  assert.equal(bad.comparison.supportedScore, null);
  assert.equal(bad.comparison.analyzedSeconds, null);
});

test("supported-score modes never remove a legacy unsupported-language fallback", async () => {
  const { evaluateOrukeetLanguageRouting: run } = await load();
  for (const mode of ["supported-0.30", "supported-0.10", "shadow"]) {
    const result = run({
      language: "auto",
      final: { ...final, language: "ja", languageConfidence: 0.95, languageSupportedScore: 0.5 },
      mode,
    });
    assert.equal(result.fallback, true);
    assert.equal(result.comparison.selectedFallback, true);
    assert.equal(result.comparison.candidate030, false);
  }
});

test("top-score comparator never labels a supported top language unsupported", async () => {
  const { evaluateOrukeetLanguageRouting: run } = await load();
  const result = run({
    final: { ...final, language: "en", languageConfidence: 0.9 },
    mode: "shadow",
  });
  assert.equal(result.comparison.top05Fallback, false);
  assert.equal(result.comparison.selectedFallback, false);
});
