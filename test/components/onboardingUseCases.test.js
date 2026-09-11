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
