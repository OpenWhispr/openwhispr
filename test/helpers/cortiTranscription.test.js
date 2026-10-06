const test = require("node:test");
const assert = require("node:assert/strict");
const Module = require("node:module");

// cortiAuth and cortiTranscription call Electron's net.fetch, so stub it.
const originalLoad = Module._load;
let fetchBehavior = async () => {
  throw new Error("fetch not stubbed");
};
const electronStub = {
  app: { isReady: () => false, getPath: () => "/tmp", getVersion: () => "0.0.0" },
  net: { fetch: (...args) => fetchBehavior(...args) },
};
Module._load = function loadWithElectronStub(request, parent, isMain) {
  if (request === "electron") return electronStub;
  return originalLoad.call(this, request, parent, isMain);
};
test.after(() => {
  Module._load = originalLoad;
});

const { transcribeAudio } = require("../../src/helpers/cortiTranscription");

test("a rejected Corti client secret is classified instead of showing the token endpoint's body", async () => {
  const body = '{"error":"unauthorized_client","error_description":"Invalid client credentials"}';
  fetchBehavior = async () => new Response(body, { status: 401 });

  const error = await transcribeAudio({
    environment: "eu",
    tenant: "acme",
    clientId: "corti-id",
    clientSecret: "wrong-secret",
    audioBuffer: Buffer.from("audio"),
  }).then(
    () => assert.fail("expected the token mint to fail"),
    (err) => err
  );

  assert.equal(error.code, "PROVIDER_AUTH_FAILED");
  assert.equal(error.message, "Corti rejected your API key.");
  assert.equal(error.settingsTarget, "speechToText");
  assert.equal(error.technicalDetails.status, 401);
  assert.match(error.technicalDetails.underlyingError, /Invalid client credentials/);
});
