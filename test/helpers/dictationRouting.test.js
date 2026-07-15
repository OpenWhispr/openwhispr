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
