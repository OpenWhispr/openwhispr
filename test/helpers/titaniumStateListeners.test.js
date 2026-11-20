// Sign-out and account changes must reach main-process subscribers (D-08): they
// drop connections that were opened under the previous license.
const test = require("node:test");
const assert = require("node:assert/strict");
const {
  onTitaniumStateChanged,
  notifyTitaniumStateChanged,
} = require("../../src/helpers/titanium/titaniumIpc");

test("subscribers see every state change until they unsubscribe", () => {
  const seen = [];
  const off = onTitaniumStateChanged((state) => seen.push(state.signedIn));

  notifyTitaniumStateChanged({ signedIn: true });
  notifyTitaniumStateChanged({ signedIn: false });
  off();
  notifyTitaniumStateChanged({ signedIn: true });

  assert.deepEqual(seen, [true, false]);
});

test("a throwing subscriber does not stop the others", () => {
  const seen = [];
  const offBad = onTitaniumStateChanged(() => {
    throw new Error("boom");
  });
  const offGood = onTitaniumStateChanged((state) => seen.push(state.signedIn));

  assert.doesNotThrow(() => notifyTitaniumStateChanged({ signedIn: false }));
  assert.deepEqual(seen, [false]);
  offBad();
  offGood();
});

test("the cleanup request path never logs any part of the key", () => {
  const source = require("node:fs").readFileSync(
    require("node:path").join(__dirname, "../../src/services/ai/inferenceProviders/openai.ts"),
    "utf8"
  );
  assert.equal(source.includes("apiKeyPreview"), false);
  assert.equal(/apiKey\.substring|apiKey\.slice/.test(source), false);
});
