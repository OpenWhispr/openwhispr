const test = require("node:test");
const assert = require("node:assert/strict");

const load = () => import("../../src/helpers/dictationRouting.js");

test("voice agent hotkey routes to the agent without a wake word", async () => {
  const { resolveDictationRouteKind } = await load();

  assert.equal(
    resolveDictationRouteKind({
      cleanupReachable: true,
      agentReachable: true,
      agentInvoked: false,
      voiceAgentRequested: true,
    }),
    "agent"
  );
});

test("voice agent hotkey never triggers cleanup", async () => {
  const { resolveDictationRouteKind } = await load();

  // Even with cleanup enabled and reachable, a voice agent recording with an
  // unreachable agent returns the raw transcript instead of falling back.
  assert.equal(
    resolveDictationRouteKind({
      cleanupReachable: true,
      agentReachable: false,
      agentInvoked: false,
      voiceAgentRequested: true,
    }),
    "skip"
  );
});

test("voice agent hotkey ignores the wake word state", async () => {
  const { resolveDictationRouteKind } = await load();

  assert.equal(
    resolveDictationRouteKind({
      cleanupReachable: false,
      agentReachable: true,
      agentInvoked: true,
      voiceAgentRequested: true,
    }),
    "agent"
  );
});

test("normal dictation with wake word routes to the agent", async () => {
  const { resolveDictationRouteKind } = await load();

  assert.equal(
    resolveDictationRouteKind({
      cleanupReachable: true,
      agentReachable: true,
      agentInvoked: true,
      voiceAgentRequested: false,
    }),
    "agent"
  );
});

test("normal dictation without wake word routes to cleanup", async () => {
  const { resolveDictationRouteKind } = await load();

  assert.equal(
    resolveDictationRouteKind({
      cleanupReachable: true,
      agentReachable: true,
      agentInvoked: false,
      voiceAgentRequested: false,
    }),
    "cleanup"
  );
});

test("wake word with unreachable agent falls back to cleanup", async () => {
  const { resolveDictationRouteKind } = await load();

  assert.equal(
    resolveDictationRouteKind({
      cleanupReachable: true,
      agentReachable: false,
      agentInvoked: true,
      voiceAgentRequested: false,
    }),
    "cleanup"
  );
});

test("skips reasoning when nothing is reachable", async () => {
  const { resolveDictationRouteKind } = await load();

  assert.equal(
    resolveDictationRouteKind({
      cleanupReachable: false,
      agentReachable: false,
      agentInvoked: false,
      voiceAgentRequested: false,
    }),
    "skip"
  );
});

test("agent is reachable in cloud mode without an explicit model", async () => {
  const { resolveDictationAgentReachability } = await load();

  assert.equal(
    resolveDictationAgentReachability({
      useDictationAgent: true,
      dictationAgentModel: "",
      isCloudAgent: true,
      isSelfHostedAgent: false,
    }),
    true
  );
});

test("agent is reachable in self-hosted mode without an explicit model", async () => {
  const { resolveDictationAgentReachability } = await load();

  assert.equal(
    resolveDictationAgentReachability({
      useDictationAgent: true,
      dictationAgentModel: "",
      isCloudAgent: false,
      isSelfHostedAgent: true,
    }),
    true
  );
});

test("agent is unreachable with an empty model on a model-required provider", async () => {
  const { resolveDictationAgentReachability } = await load();

  assert.equal(
    resolveDictationAgentReachability({
      useDictationAgent: true,
      dictationAgentModel: "   ",
      isCloudAgent: false,
      isSelfHostedAgent: false,
    }),
    false
  );
});

test("agent is reachable with an explicit model (BYOK/local/enterprise)", async () => {
  const { resolveDictationAgentReachability } = await load();

  assert.equal(
    resolveDictationAgentReachability({
      useDictationAgent: true,
      dictationAgentModel: "gpt-5.5",
      isCloudAgent: false,
      isSelfHostedAgent: false,
    }),
    true
  );
});

test("disabling the dictation agent overrides cloud reachability", async () => {
  const { resolveDictationAgentReachability } = await load();

  assert.equal(
    resolveDictationAgentReachability({
      useDictationAgent: false,
      dictationAgentModel: "",
      isCloudAgent: true,
      isSelfHostedAgent: true,
    }),
    false
  );
});

// Screen-context image routing on the agent route.
const imageTarget = {
  hasScreenContext: true,
  visionOverrideEnabled: false,
  visionReachable: false,
  visionProviderImageWired: false,
  baseProviderImageWired: true,
  isCloudAgent: false,
  baseModelSupportsVision: false,
};

test("no captured screenshot never attaches", async () => {
  const { resolveAgentImageTarget } = await load();

  assert.deepEqual(
    resolveAgentImageTarget({
      ...imageTarget,
      hasScreenContext: false,
      visionOverrideEnabled: true,
      visionReachable: true,
      visionProviderImageWired: true,
      isCloudAgent: true,
      baseModelSupportsVision: true,
    }),
    { attach: false, useVisionOverride: false }
  );
});

test("cloud agent attaches to the base model (server picks the vision model)", async () => {
  const { resolveAgentImageTarget } = await load();

  assert.deepEqual(resolveAgentImageTarget({ ...imageTarget, isCloudAgent: true }), {
    attach: true,
    useVisionOverride: false,
  });
});

test("BYOK base model attaches only when the registry marks it vision-capable", async () => {
  const { resolveAgentImageTarget } = await load();

  assert.deepEqual(resolveAgentImageTarget({ ...imageTarget, baseModelSupportsVision: true }), {
    attach: true,
    useVisionOverride: false,
  });
  assert.deepEqual(resolveAgentImageTarget(imageTarget), {
    attach: false,
    useVisionOverride: false,
  });
});

test("an unwired base provider never gets the image", async () => {
  const { resolveAgentImageTarget } = await load();

  assert.deepEqual(
    resolveAgentImageTarget({
      ...imageTarget,
      baseProviderImageWired: false,
      isCloudAgent: true,
      baseModelSupportsVision: true,
    }),
    { attach: false, useVisionOverride: false }
  );
});

test("a reachable, image-wired vision override wins over the base model", async () => {
  const { resolveAgentImageTarget } = await load();

  assert.deepEqual(
    resolveAgentImageTarget({
      ...imageTarget,
      visionOverrideEnabled: true,
      visionReachable: true,
      visionProviderImageWired: true,
      baseModelSupportsVision: true,
    }),
    { attach: true, useVisionOverride: true }
  );
});

test("vision override lets a text-only base agent still get screen context", async () => {
  const { resolveAgentImageTarget } = await load();

  assert.deepEqual(
    resolveAgentImageTarget({
      ...imageTarget,
      visionOverrideEnabled: true,
      visionReachable: true,
      visionProviderImageWired: true,
      baseProviderImageWired: false,
    }),
    { attach: true, useVisionOverride: true }
  );
});

test("an unusable vision override drops the image instead of rerouting to base", async () => {
  const { resolveAgentImageTarget } = await load();

  // Override enabled but not configured (unreachable) — base could take the
  // image, but silently ignoring the user's routing choice would be worse.
  assert.deepEqual(
    resolveAgentImageTarget({
      ...imageTarget,
      visionOverrideEnabled: true,
      visionReachable: false,
      visionProviderImageWired: true,
      baseModelSupportsVision: true,
    }),
    { attach: false, useVisionOverride: false }
  );

  // Override pointing at a provider whose client can't send images.
  assert.deepEqual(
    resolveAgentImageTarget({
      ...imageTarget,
      visionOverrideEnabled: true,
      visionReachable: true,
      visionProviderImageWired: false,
      isCloudAgent: true,
    }),
    { attach: false, useVisionOverride: false }
  );
});
