const assert = require("node:assert/strict");
const test = require("node:test");
const { mountByokStep } = require("../lib/byokStepHarness");

const PLACEHOLDER = {
  endpoint: "onboarding.rehaul.provider.endpointPlaceholder",
  modelId: "onboarding.rehaul.provider.modelIdPlaceholder",
  hostedKey: "onboarding.rehaul.provider.apiKeyPlaceholder",
};
const LABEL = {
  apiKey: "onboarding.rehaul.provider.apiKey",
  clientSecret: "onboarding.rehaul.provider.clientSecret",
  modelId: "onboarding.rehaul.provider.modelId",
};
const HOSTED_GROQ = {
  useLocalWhisper: "false",
  transcriptionMode: "providers",
  cloudTranscriptionMode: "byok",
  cloudTranscriptionProvider: "groq",
  cloudTranscriptionModel: "whisper-large-v3-turbo",
};
const CORTI = {
  ...HOSTED_GROQ,
  cloudTranscriptionProvider: "corti",
  cloudTranscriptionModel: "corti-transcribe",
};
const REJECTED = { success: false, errorCode: "credentialsRejected", status: 401 };
const phase = (step, label) => step.checkField(label)?.props.check.phase;
const sent = (step, field) => step.connectionRequests().map((config) => config[field]);

test("a saved hosted key is checked on arrival, and only Connected unlocks Proceed", async (t) => {
  const step = await mountByokStep(t, {
    settings: HOSTED_GROQ,
    secrets: { groqApiKey: "gsk-saved" },
  });
  assert.equal(phase(step, LABEL.apiKey), "waiting");
  assert.equal(step.proceedDisabled(), true);
  await step.wait(500);
  const [config] = step.connectionRequests();
  assert.equal(config.provider, "groq");
  assert.equal(config.apiKey, "gsk-saved");
  assert.equal(config.model, "whisper-large-v3-turbo");
  await step.answerConnection({ success: true });
  assert.equal(phase(step, LABEL.apiKey), "connected");
  assert.equal(step.proceedDisabled(), false);
  assert.equal(step.proceeded(), 0, "nothing advances by itself");
  await step.proceed();
  assert.equal(step.proceeded(), 1);
});

test("typing a key sends nothing until typing pauses for half a second", async (t) => {
  const step = await mountByokStep(t, { settings: HOSTED_GROQ });
  assert.equal(phase(step, LABEL.apiKey), "idle", "an empty key shows no status");
  for (const key of ["g", "gs", "gsk", "gsk-typed"]) {
    await step.type(PLACEHOLDER.hostedKey, key);
    await step.wait(300);
  }
  assert.equal(step.connectionRequests().length, 0);
  await step.wait(200);
  assert.deepEqual(sent(step, "apiKey"), ["gsk-typed"]);
});

test("a provider change mid-check discards the earlier answer", async (t) => {
  const step = await mountByokStep(t, {
    settings: HOSTED_GROQ,
    secrets: { groqApiKey: "gsk-saved", openaiApiKey: "sk-saved" },
  });
  await step.wait(500);
  await step.chooseProvider("openai");
  await step.answerConnection({ success: true }, 0);
  assert.notEqual(phase(step, LABEL.apiKey), "connected");
  assert.equal(step.proceedDisabled(), true);
  await step.wait(500);
  assert.deepEqual(sent(step, "provider"), ["groq", "openai"]);
  await step.answerConnection(REJECTED, 1);
  assert.equal(phase(step, LABEL.apiKey), "failed");
  assert.equal(step.proceedDisabled(), true);
});

test("a key that loads after mount is checked when it arrives", async (t) => {
  const step = await mountByokStep(t, { settings: HOSTED_GROQ });
  await step.wait(1000);
  assert.equal(step.connectionRequests().length, 0);
  await step.setStore({ groqApiKey: "gsk-late" });
  assert.equal(phase(step, LABEL.apiKey), "waiting");
  await step.wait(500);
  assert.deepEqual(sent(step, "apiKey"), ["gsk-late"]);
});

test("a rejected key keeps Proceed off; Retry and an edit both check again", async (t) => {
  const step = await mountByokStep(t, {
    settings: HOSTED_GROQ,
    secrets: { groqApiKey: "gsk-saved" },
  });
  await step.wait(500);
  await step.answerConnection(REJECTED);
  assert.equal(step.checkField(LABEL.apiKey).props.check.failure.errorCode, "credentialsRejected");
  assert.equal(step.proceedDisabled(), true);
  await step.retryCheck(LABEL.apiKey);
  assert.equal(step.connectionRequests().length, 2, "Retry does not wait for the pause");
  await step.answerConnection(REJECTED);
  await step.type(PLACEHOLDER.hostedKey, "gsk-fixed");
  assert.equal(phase(step, LABEL.apiKey), "waiting");
  await step.wait(500);
  assert.deepEqual(sent(step, "apiKey"), ["gsk-saved", "gsk-saved", "gsk-fixed"]);
});

test("Corti checks once both the client ID and secret are filled, in the secret", async (t) => {
  const step = await mountByokStep(t, { settings: CORTI, secrets: { cortiClientId: "corti-id" } });
  assert.ok(step.checkField(LABEL.apiKey) === undefined, "Corti has no API key field");
  assert.equal(phase(step, LABEL.clientSecret), "idle");
  await step.wait(1000);
  assert.equal(step.connectionRequests().length, 0);
  await step.setStore({ cortiClientSecret: "corti-secret" });
  assert.equal(phase(step, LABEL.clientSecret), "waiting");
  await step.wait(500);
  const [config] = step.connectionRequests();
  assert.deepEqual(
    [config.scope, config.provider, config.clientId, config.clientSecret],
    ["transcription", "corti", "corti-id", "corti-secret"]
  );
});

test("self-hosted: nothing is sent while the address has focus; leaving it checks", async (t) => {
  const step = await mountByokStep(t, { selfHostedRequested: true });
  await step.type(PLACEHOLDER.modelId, "local-model");
  await step.focusEndpoint();
  for (const url of ["http://192.168.1.1", "http://192.168.1.10:8000/v1"]) {
    await step.type(PLACEHOLDER.endpoint, url);
    await step.wait(2000);
  }
  assert.equal(step.connectionRequests().length, 0);
  assert.equal(phase(step, LABEL.modelId), "idle", "no status while the address is edited");
  await step.blurEndpoint();
  assert.equal(phase(step, LABEL.modelId), "waiting");
  await step.wait(500);
  assert.deepEqual(sent(step, "baseUrl"), ["http://192.168.1.10:8000/v1"]);
});

test("switching to another app while editing the address keeps the hold", async (t) => {
  const step = await mountByokStep(t, { selfHostedRequested: true });
  await step.type(PLACEHOLDER.modelId, "local-model");
  await step.focusEndpoint();
  await step.type(PLACEHOLDER.endpoint, "https://my-server.exa");
  await step.blurEndpoint({ windowSwitch: true });
  await step.wait(2000);
  assert.equal(step.connectionRequests().length, 0);
  await step.blurEndpoint();
  await step.wait(500);
  assert.equal(step.connectionRequests().length, 1);
});

test("focusing the address while Connected keeps Connected until an edit", async (t) => {
  const step = await mountByokStep(t, { selfHostedRequested: true });
  await step.type(PLACEHOLDER.endpoint, "http://127.0.0.1:8791/v1");
  await step.type(PLACEHOLDER.modelId, "local-model");
  await step.passConnectionTest();
  await step.focusEndpoint();
  await step.wait(2000);
  assert.equal(phase(step, LABEL.modelId), "connected");
  assert.equal(step.proceedDisabled(), false);
  assert.equal(step.connectionRequests().length, 1);
  await step.type(PLACEHOLDER.endpoint, "http://127.0.0.1:8792/v1");
  assert.equal(phase(step, LABEL.modelId), "idle");
  assert.equal(step.proceedDisabled(), true);
});

test("a mode switch with the address focused still checks both forms", async (t) => {
  const step = await mountByokStep(t, {
    settings: HOSTED_GROQ,
    secrets: { groqApiKey: "gsk-saved" },
  });
  await step.toggleSelfHosted();
  await step.type(PLACEHOLDER.endpoint, "http://127.0.0.1:8791/v1");
  await step.type(PLACEHOLDER.modelId, "local-model");
  await step.focusEndpoint();
  await step.toggleSelfHosted(); // the address field unmounts without a blur
  await step.wait(500);
  assert.deepEqual(sent(step, "provider"), ["groq"]);
  await step.toggleSelfHosted();
  assert.equal(phase(step, LABEL.modelId), "waiting");
  await step.wait(500);
  assert.deepEqual(sent(step, "provider"), ["groq", "custom"]);
});

test("each checked field is marked invalid only by a failure about its own value", async (t) => {
  for (const [name, options, label, invalidOn] of [
    ["hosted key", { settings: HOSTED_GROQ }, LABEL.apiKey, "credentialsRejected"],
    ["Corti secret", { settings: CORTI }, LABEL.clientSecret, "credentialsRejected"],
    ["self-hosted model", { selfHostedRequested: true }, LABEL.modelId, "modelNotFound"],
  ]) {
    await t.test(name, async (t) => {
      const step = await mountByokStep(t, options);
      assert.equal(step.checkField(label).props.invalidOn, invalidOn);
    });
  }
});

test("the live region is always there and says only what the check found", async (t) => {
  await t.test("empty on arrival", async (t) => {
    const region = (await mountByokStep(t, { settings: HOSTED_GROQ })).liveRegion();
    assert.equal(region.props["aria-live"], "polite");
    assert.equal(region.props["aria-atomic"], "true");
    assert.match(region.props.className, /\bsr-only\b/);
    assert.equal(region.props.children, "");
  });
  await t.test("a slow check, then its result, then an edit", async (t) => {
    const step = await mountByokStep(t, {
      settings: HOSTED_GROQ,
      secrets: { groqApiKey: "gsk-saved" },
    });
    // Two waits: the 1 s timer starts only once React has applied the send.
    await step.wait(500);
    await step.wait(999);
    assert.equal(step.liveRegion().props.children, "");
    await step.wait(1);
    assert.equal(step.liveRegion().props.children, "onboarding.rehaul.provider.testing");
    await step.answerConnection({ success: true });
    assert.equal(step.liveRegion().props.children, "onboarding.rehaul.provider.connected");
    await step.type(PLACEHOLDER.hostedKey, "gsk-other");
    assert.equal(step.liveRegion().props.children, "");
  });
});
