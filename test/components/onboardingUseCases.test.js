const assert = require("node:assert/strict");
const test = require("node:test");

const load = () => import("../../src/components/onboarding/useCases.ts");

test("use-case rows keep the reference order and stable payload IDs", async () => {
  const { USE_CASE_OPTIONS } = await load();

  assert.deepEqual(
    USE_CASE_OPTIONS.map(({ id }) => id),
    ["dictation", "meetings", "healthcare", "translation", "upload", "ai"]
  );
});

test("use-case setup requires a selection or a meaningful note", async () => {
  const { hasUseCaseIntent } = await load();

  assert.equal(hasUseCaseIntent([], ""), false);
  assert.equal(hasUseCaseIntent([], "   "), false);
  assert.equal(hasUseCaseIntent(["dictation"], ""), true);
  assert.equal(hasUseCaseIntent([], "Accessibility workflows"), true);
});
