const test = require("node:test");
const assert = require("node:assert/strict");

const load = () => import("../../src/config/cleanupPromptProfiles.ts");
const dictation = { inferenceScope: "dictationCleanup" };

test("S1-mini has its own cleanup prompt; other models have none", async () => {
  const { getCleanupPromptProfile } = await load();
  const profile = getCleanupPromptProfile("s1-mini-q4_k_m", dictation);
  assert.equal(
    profile.systemPrompt,
    "You are a text normalizer for speech-to-text transcripts. The input begins with a control line specifying the styling, structure, and context settings; clean the transcript to match those settings and output only the cleaned text."
  );
  assert.equal(
    profile.buildUserContent("um so send the report"),
    "[Styling: semi-formal] [Structure: prose] [Context: general]\num so send the report"
  );
  assert.equal(profile.temperature, 0);
  assert.equal(profile.maxChunkWords, 600);

  for (const model of ["qwen3.5-0.8b-q4_k_m", "gemma-4-e2b-it-qat-q4_0", "", undefined]) {
    assert.equal(getCleanupPromptProfile(model, dictation), null, String(model));
  }
});

test("a profile only replaces the default dictation cleanup prompt", async () => {
  const { getCleanupPromptProfile } = await load();
  for (const config of [
    {},
    { inferenceScope: "noteFormatting" },
    { ...dictation, systemPrompt: "Translate to French" },
    { ...dictation, requiresAgent: true },
    { ...dictation, hasCustomCleanupPrompt: true },
  ]) {
    assert.equal(getCleanupPromptProfile("s1-mini-q4_k_m", config), null, JSON.stringify(config));
  }
});

test("profiled cleanup sends each part in order and joins the answers", async () => {
  const { getCleanupPromptProfile, runProfiledCleanup } = await load();
  const profile = { ...getCleanupPromptProfile("s1-mini-q4_k_m", dictation), maxChunkWords: 4 };
  const sent = [];
  const result = await runProfiledCleanup(
    profile,
    "one two three. four five six. seven.",
    (user) => {
      sent.push(user);
      return Promise.resolve(user.split("\n")[1].toUpperCase());
    }
  );
  assert.deepEqual(
    sent.map((user) => user.split("\n")[1]),
    ["one two three.", "four five six. seven."]
  );
  assert.ok(sent.every((user) => user.startsWith("[Styling: semi-formal]")));
  assert.equal(result, "ONE TWO THREE. FOUR FIVE SIX. SEVEN.");
});

test("a part the model empties (filler only) is left out of the joined text", async () => {
  const { getCleanupPromptProfile, runProfiledCleanup } = await load();
  const profile = { ...getCleanupPromptProfile("s1-mini-q4_k_m", dictation), maxChunkWords: 2 };
  const answers = ["First.", "  ", "Third."];
  const result = await runProfiledCleanup(profile, "first one. um uh. third one.", () =>
    Promise.resolve(answers.shift())
  );
  assert.equal(result, "First. Third.");
});

test("S1-mini's answers go through the wider output check, part by part", async () => {
  const { getCleanupPromptProfile, runProfiledCleanup } = await load();
  const profile = getCleanupPromptProfile("s1-mini-q4_k_m", dictation);
  const raw = "um so can you uh send me the report by friday";
  await assert.rejects(
    runProfiledCleanup(profile, raw, () => Promise.resolve("")),
    { code: "CLEANUP_OUTPUT_INVALID" }
  );
  await assert.rejects(
    runProfiledCleanup(profile, raw, () => Promise.resolve(`${raw} `.repeat(4))),
    { code: "CLEANUP_OUTPUT_INVALID" }
  );
  assert.equal(await runProfiledCleanup(profile, "um uh", () => Promise.resolve("")), "");

  const answers = ["First part is fine.", ""];
  await assert.rejects(
    runProfiledCleanup(
      { ...profile, maxChunkWords: 6 },
      "first part is fine. second part has real words too.",
      () => Promise.resolve(answers.shift())
    ),
    { code: "CLEANUP_OUTPUT_INVALID" }
  );
});
