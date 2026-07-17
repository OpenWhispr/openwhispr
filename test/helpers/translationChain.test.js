const test = require("node:test");
const assert = require("node:assert/strict");

const load = () => import("../../src/helpers/translationChain.js");

// Builds an opts object with sane no-op defaults so each test only overrides what it cares about.
function makeOpts(overrides = {}) {
  return {
    text: "raw",
    cleanupReachable: true,
    cleanupIsCloud: false,
    shouldTranslate: true,
    translateIsCloud: false,
    runCleanup: async () => null,
    runTranslate: async () => null,
    onCleanupError: () => {},
    onEmptyTranslate: () => {},
    ...overrides,
  };
}

test("cleanup ok then translate ok: both applied in order", async () => {
  const { executeTranslationChain } = await load();
  const calls = [];

  const result = await executeTranslationChain(
    makeOpts({
      runCleanup: async (currentText) => {
        calls.push(["cleanup", currentText]);
        return "cleaned";
      },
      runTranslate: async (currentText) => {
        calls.push(["translate", currentText]);
        return "translated";
      },
    })
  );

  assert.equal(result.text, "translated");
  assert.deepEqual(calls, [
    ["cleanup", "raw"],
    ["translate", "cleaned"],
  ]);
});

test("cleanup unreachable: translate runs on the raw text", async () => {
  const { executeTranslationChain } = await load();
  let cleanupCalled = false;

  const result = await executeTranslationChain(
    makeOpts({
      cleanupReachable: false,
      runCleanup: async () => {
        cleanupCalled = true;
        return "cleaned";
      },
      runTranslate: async (currentText) => `translated(${currentText})`,
    })
  );

  assert.equal(cleanupCalled, false);
  assert.equal(result.text, "translated(raw)");
});

test("cleanup throws: onCleanupError fires, translate runs on original text", async () => {
  const { executeTranslationChain } = await load();
  const errors = [];

  const result = await executeTranslationChain(
    makeOpts({
      runCleanup: async () => {
        throw new Error("cleanup boom");
      },
      onCleanupError: (err) => errors.push(err.message),
      runTranslate: async (currentText) => `translated(${currentText})`,
    })
  );

  assert.deepEqual(errors, ["cleanup boom"]);
  assert.equal(result.text, "translated(raw)");
});

test("cleanup returns empty: text unchanged, translate still runs", async () => {
  const { executeTranslationChain } = await load();

  const result = await executeTranslationChain(
    makeOpts({
      runCleanup: async () => "",
      runTranslate: async (currentText) => `translated(${currentText})`,
    })
  );

  assert.equal(result.text, "translated(raw)");
});

test("translate returns empty: onEmptyTranslate fires, cleaned text kept", async () => {
  const { executeTranslationChain } = await load();
  let emptyCalled = false;

  const result = await executeTranslationChain(
    makeOpts({
      runCleanup: async () => "cleaned",
      runTranslate: async () => "",
      onEmptyTranslate: () => {
        emptyCalled = true;
      },
    })
  );

  assert.equal(emptyCalled, true);
  assert.equal(result.text, "cleaned");
});

test("shouldTranslate false: translate never called, cleaned text returned", async () => {
  const { executeTranslationChain } = await load();
  let translateCalled = false;

  const result = await executeTranslationChain(
    makeOpts({
      shouldTranslate: false,
      runCleanup: async () => "cleaned",
      runTranslate: async () => {
        translateCalled = true;
        return "translated";
      },
    })
  );

  assert.equal(translateCalled, false);
  assert.equal(result.text, "cleaned");
});

test("translate throws: error propagates, translate saw the cleaned text", async () => {
  const { executeTranslationChain } = await load();
  let sawText = null;

  await assert.rejects(
    () =>
      executeTranslationChain(
        makeOpts({
          runCleanup: async () => "cleaned",
          runTranslate: async (currentText) => {
            sawText = currentText;
            throw new Error("translate boom");
          },
        })
      ),
    /translate boom/
  );

  // The cleanup mutation reached the translate step before it threw.
  assert.equal(sawText, "cleaned");
});

test("usedCloudReasoning: both steps local stays false", async () => {
  const { executeTranslationChain } = await load();

  const result = await executeTranslationChain(
    makeOpts({
      cleanupIsCloud: false,
      translateIsCloud: false,
      runCleanup: async () => "cleaned",
      runTranslate: async () => "translated",
    })
  );

  assert.equal(result.usedCloudReasoning, false);
});

test("usedCloudReasoning: cloud cleanup succeeds sets it true", async () => {
  const { executeTranslationChain } = await load();

  const result = await executeTranslationChain(
    makeOpts({
      cleanupIsCloud: true,
      translateIsCloud: false,
      runCleanup: async () => "cleaned",
      runTranslate: async () => "translated",
    })
  );

  assert.equal(result.usedCloudReasoning, true);
});

test("usedCloudReasoning: cloud cleanup that returns empty still sets it true", async () => {
  const { executeTranslationChain } = await load();

  const result = await executeTranslationChain(
    makeOpts({
      cleanupIsCloud: true,
      translateIsCloud: false,
      runCleanup: async () => null,
      runTranslate: async () => "translated",
    })
  );

  assert.equal(result.usedCloudReasoning, true);
});

test("usedCloudReasoning: cloud cleanup that throws does not set it", async () => {
  const { executeTranslationChain } = await load();

  const result = await executeTranslationChain(
    makeOpts({
      cleanupIsCloud: true,
      translateIsCloud: false,
      runCleanup: async () => {
        throw new Error("cleanup boom");
      },
      runTranslate: async () => "translated",
    })
  );

  assert.equal(result.usedCloudReasoning, false);
});

test("usedCloudReasoning: cloud translate sets it true", async () => {
  const { executeTranslationChain } = await load();

  const result = await executeTranslationChain(
    makeOpts({
      cleanupIsCloud: false,
      translateIsCloud: true,
      runCleanup: async () => "cleaned",
      runTranslate: async () => "translated",
    })
  );

  assert.equal(result.usedCloudReasoning, true);
});

test("usedCloudReasoning: cleanup fails but cloud translate succeeds is true", async () => {
  const { executeTranslationChain } = await load();

  const result = await executeTranslationChain(
    makeOpts({
      cleanupIsCloud: true,
      translateIsCloud: true,
      runCleanup: async () => {
        throw new Error("cleanup boom");
      },
      runTranslate: async () => "translated",
    })
  );

  assert.equal(result.usedCloudReasoning, true);
  assert.equal(result.text, "translated");
});

test("usedCloudReasoning: cloud translate step skipped when shouldTranslate is false", async () => {
  const { executeTranslationChain } = await load();

  const result = await executeTranslationChain(
    makeOpts({
      cleanupIsCloud: false,
      translateIsCloud: true,
      shouldTranslate: false,
      runCleanup: async () => "cleaned",
    })
  );

  assert.equal(result.usedCloudReasoning, false);
  assert.equal(result.text, "cleaned");
});

test("shouldRunTranslateStep matrix", async () => {
  const { shouldRunTranslateStep } = await load();

  assert.equal(shouldRunTranslateStep("auto", "it"), true);
  assert.equal(shouldRunTranslateStep("en", "it"), true);
  assert.equal(shouldRunTranslateStep("it", "it"), false);
  // Empty/undefined source is treated as auto → always translate.
  assert.equal(shouldRunTranslateStep("", "it"), true);
  assert.equal(shouldRunTranslateStep("", "en"), true);
  assert.equal(shouldRunTranslateStep(undefined, "it"), true);
});
