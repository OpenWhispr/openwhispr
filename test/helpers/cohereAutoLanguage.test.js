const test = require("node:test");
const assert = require("node:assert/strict");

const { resolveModelLanguage } = require("../../src/helpers/parakeetModelInfo");
const {
  firstImplicitAutoLanguage,
  implicitAutoLanguage,
} = require("../../src/helpers/cohereAutoLanguage");

test("Cohere Auto is the English fallback the model is actually started with", () => {
  assert.equal(
    implicitAutoLanguage("cohere"),
    resolveModelLanguage("cohere-transcribe-03-2026", "auto")
  );
  assert.equal(implicitAutoLanguage("cohere"), "en");
});

test("Whisper and Parakeet Auto stay real auto-detection", () => {
  assert.equal(implicitAutoLanguage("whisper"), null);
  assert.equal(implicitAutoLanguage("nvidia"), null);
  assert.equal(implicitAutoLanguage(undefined), null);
});

test("the warning follows whichever local scope is actually using Cohere", () => {
  assert.equal(
    firstImplicitAutoLanguage([
      { mode: "providers", provider: "openai" },
      { mode: "local", provider: "whisper" },
      { mode: "local", provider: "cohere" },
    ]),
    "en"
  );
  assert.equal(
    firstImplicitAutoLanguage([
      { mode: "local", provider: "nvidia" },
      { mode: "openwhispr", provider: "cohere" },
    ]),
    null
  );
});
