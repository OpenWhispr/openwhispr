const test = require("node:test");
const assert = require("node:assert/strict");

const {
  isNoteFormattingConfigured,
  ensureNoteFormattingConfigured,
} = require("../../src/helpers/noteFormattingConfig.js");

test("an unconfigured environment is reported as unconfigured", () => {
  assert.equal(isNoteFormattingConfigured({}), false);
  assert.equal(isNoteFormattingConfigured({ NOTE_FORMATTING_PROVIDER: "openai" }), false);
  assert.equal(isNoteFormattingConfigured({ NOTE_FORMATTING_MODEL: "gpt-5.5" }), false);
  assert.equal(
    isNoteFormattingConfigured({ NOTE_FORMATTING_PROVIDER: "", NOTE_FORMATTING_MODEL: "gpt-5.5" }),
    false
  );
});

test("a fully configured environment is reported as configured", () => {
  assert.equal(
    isNoteFormattingConfigured({
      NOTE_FORMATTING_PROVIDER: "openai",
      NOTE_FORMATTING_MODEL: "gpt-5.5",
    }),
    true
  );
});

test("an unconfigured environment is pointed at the bundled local model", () => {
  const env = {};
  const configured = [];

  const changed = ensureNoteFormattingConfigured({
    env,
    modelId: "gemma-3",
    onConfigured: (c) => configured.push(c),
  });

  assert.equal(changed, true);
  assert.equal(env.NOTE_FORMATTING_PROVIDER, "local");
  assert.equal(env.NOTE_FORMATTING_MODEL, "gemma-3");
  assert.deepEqual(configured, [{ provider: "local", model: "gemma-3" }]);
  assert.equal(
    isNoteFormattingConfigured(env),
    true,
    "the pipeline must find a provider and model after auto-configuration"
  );
});

test("a user's existing choice is never overridden", () => {
  const env = {
    NOTE_FORMATTING_PROVIDER: "anthropic",
    NOTE_FORMATTING_MODEL: "claude-opus-4-7",
  };
  const configured = [];

  const changed = ensureNoteFormattingConfigured({
    env,
    modelId: "gemma-3",
    onConfigured: (c) => configured.push(c),
  });

  assert.equal(changed, false);
  assert.equal(env.NOTE_FORMATTING_PROVIDER, "anthropic");
  assert.equal(env.NOTE_FORMATTING_MODEL, "claude-opus-4-7");
  assert.deepEqual(configured, [], "no broadcast when nothing changed");
});

test("a half-configured environment is completed rather than left broken", () => {
  const env = { NOTE_FORMATTING_PROVIDER: "openai" };

  assert.equal(ensureNoteFormattingConfigured({ env, modelId: "gemma-3" }), true);
  assert.equal(env.NOTE_FORMATTING_PROVIDER, "local");
  assert.equal(env.NOTE_FORMATTING_MODEL, "gemma-3");
});

test("without a model id there is nothing to fall back to", () => {
  const env = {};

  assert.equal(ensureNoteFormattingConfigured({ env, modelId: "" }), false);
  assert.equal(isNoteFormattingConfigured(env), false);
});

test("auto-configuration is idempotent", () => {
  const env = {};
  ensureNoteFormattingConfigured({ env, modelId: "gemma-3" });

  assert.equal(ensureNoteFormattingConfigured({ env, modelId: "gemma-3" }), false);
  assert.equal(env.NOTE_FORMATTING_MODEL, "gemma-3");
});
