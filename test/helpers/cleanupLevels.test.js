const test = require("node:test");
const assert = require("node:assert/strict");

const load = () => import("../../src/config/cleanupLevels.ts");

test("normalizes stored cleanup levels and preserves the legacy cleanup toggle", async () => {
  const { getCleanupLevelForEnabled, normalizeCleanupLevel } = await load();

  for (const level of ["none", "light", "medium", "high"]) {
    assert.equal(normalizeCleanupLevel(level), level);
  }
  assert.equal(normalizeCleanupLevel("unknown", true), "medium");
  assert.equal(normalizeCleanupLevel(null, false), "none");
  assert.equal(getCleanupLevelForEnabled(false, "high"), "none");
  assert.equal(getCleanupLevelForEnabled(true, "none"), "medium");
  assert.equal(getCleanupLevelForEnabled(true, "high"), "high");
});

test("none and medium preserve the established cleanup prompt", async () => {
  const { applyCleanupLevel } = await load();
  const prompt = "BASE CLEANUP CONTRACT";

  assert.equal(applyCleanupLevel(prompt, "none"), prompt);
  assert.equal(applyCleanupLevel(prompt, "medium"), prompt);
});

test("light cleanup adds a conservative editing boundary", async () => {
  const { applyCleanupLevel } = await load();
  const result = applyCleanupLevel("BASE", "light");

  assert.match(result, /^BASE\n\nCLEANUP LEVEL: LIGHT/);
  assert.match(result, /Preserve the speaker's wording, length, order, and structure/);
  assert.match(result, /Do not rephrase for style or concision/);
});

test("high cleanup permits polish without changing facts or intent", async () => {
  const { applyCleanupLevel } = await load();
  const result = applyCleanupLevel("BASE", "high");

  assert.match(result, /^BASE\n\nCLEANUP LEVEL: HIGH/);
  assert.match(result, /preserving every fact, instruction, proper noun, technical term/);
  assert.match(result, /Never add new information or answer the transcript/);
});

test("selects a cloud prompt override only when the level or custom prompt requires one", async () => {
  const { getCleanupPromptOverride } = await load();

  assert.equal(getCleanupPromptOverride("CUSTOM", "high", "DEFAULT"), "CUSTOM");
  assert.equal(getCleanupPromptOverride("CUSTOM", "none", "DEFAULT"), undefined);
  assert.equal(getCleanupPromptOverride("", "medium", "DEFAULT"), undefined);
  assert.equal(getCleanupPromptOverride("", "none", "DEFAULT"), undefined);
  assert.match(getCleanupPromptOverride("", "light", "DEFAULT"), /CLEANUP LEVEL: LIGHT/);
  assert.match(getCleanupPromptOverride("", "high", "DEFAULT"), /CLEANUP LEVEL: HIGH/);
});
