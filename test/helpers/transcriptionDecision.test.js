const test = require("node:test");
const assert = require("node:assert/strict");

// --- shouldProcessTranscription ---

test("both toggles off: skip", async () => {
  const { shouldProcessTranscription } = await import(
    "../../src/helpers/transcriptionDecision.js"
  );
  assert.equal(
    shouldProcessTranscription({
      useReasoningModel: false,
      agentEnabled: false,
      agentName: "Jarvis",
      transcript: "Hey Jarvis, what time is it",
    }),
    "skip"
  );
});

test("cleanup on, agent off: process all text", async () => {
  const { shouldProcessTranscription } = await import(
    "../../src/helpers/transcriptionDecision.js"
  );
  assert.equal(
    shouldProcessTranscription({
      useReasoningModel: true,
      agentEnabled: false,
      agentName: "Jarvis",
      transcript: "I need to buy groceries",
    }),
    "process"
  );
});

test("cleanup on, agent on: process all text (prompt handles agent detection)", async () => {
  const { shouldProcessTranscription } = await import(
    "../../src/helpers/transcriptionDecision.js"
  );
  assert.equal(
    shouldProcessTranscription({
      useReasoningModel: true,
      agentEnabled: true,
      agentName: "Jarvis",
      transcript: "I need to buy groceries",
    }),
    "process"
  );
});

test("cleanup on, agent on, name in transcript: still process (not agent-only)", async () => {
  const { shouldProcessTranscription } = await import(
    "../../src/helpers/transcriptionDecision.js"
  );
  assert.equal(
    shouldProcessTranscription({
      useReasoningModel: true,
      agentEnabled: true,
      agentName: "Jarvis",
      transcript: "Hey Jarvis, what time is it",
    }),
    "process"
  );
});

test("agent on, cleanup off, name detected: agent-only", async () => {
  const { shouldProcessTranscription } = await import(
    "../../src/helpers/transcriptionDecision.js"
  );
  assert.equal(
    shouldProcessTranscription({
      useReasoningModel: false,
      agentEnabled: true,
      agentName: "Jarvis",
      transcript: "Hey Jarvis, what time is it",
    }),
    "agent-only"
  );
});

test("agent on, cleanup off, name absent: skip", async () => {
  const { shouldProcessTranscription } = await import(
    "../../src/helpers/transcriptionDecision.js"
  );
  assert.equal(
    shouldProcessTranscription({
      useReasoningModel: false,
      agentEnabled: true,
      agentName: "Jarvis",
      transcript: "I need to buy groceries",
    }),
    "skip"
  );
});

test("agent on, cleanup off, agentName null: skip", async () => {
  const { shouldProcessTranscription } = await import(
    "../../src/helpers/transcriptionDecision.js"
  );
  assert.equal(
    shouldProcessTranscription({
      useReasoningModel: false,
      agentEnabled: true,
      agentName: null,
      transcript: "Hey Jarvis, do something",
    }),
    "skip"
  );
});

test("agent on, cleanup off, agentName empty string: skip", async () => {
  const { shouldProcessTranscription } = await import(
    "../../src/helpers/transcriptionDecision.js"
  );
  assert.equal(
    shouldProcessTranscription({
      useReasoningModel: false,
      agentEnabled: true,
      agentName: "",
      transcript: "Hey Jarvis, do something",
    }),
    "skip"
  );
});

test("agent on, cleanup off, single-char agentName: skip (too short for detection)", async () => {
  const { shouldProcessTranscription } = await import(
    "../../src/helpers/transcriptionDecision.js"
  );
  assert.equal(
    shouldProcessTranscription({
      useReasoningModel: false,
      agentEnabled: true,
      agentName: "J",
      transcript: "Hey J, do something",
    }),
    "skip"
  );
});

test("agent on, cleanup off, fuzzy match within Levenshtein distance: agent-only", async () => {
  const { shouldProcessTranscription } = await import(
    "../../src/helpers/transcriptionDecision.js"
  );
  // "Jarvis" (6 chars) allows maxEdits=1, so "Jarvs" should match
  assert.equal(
    shouldProcessTranscription({
      useReasoningModel: false,
      agentEnabled: true,
      agentName: "Jarvis",
      transcript: "Hey Jarvs, set a timer",
    }),
    "agent-only"
  );
});

test("agent on, cleanup off, case-insensitive exact match: agent-only", async () => {
  const { shouldProcessTranscription } = await import(
    "../../src/helpers/transcriptionDecision.js"
  );
  assert.equal(
    shouldProcessTranscription({
      useReasoningModel: false,
      agentEnabled: true,
      agentName: "Jarvis",
      transcript: "hey jarvis, tell me a joke",
    }),
    "agent-only"
  );
});

// --- detectAgentName edge cases ---

test("detectAgentName: compound name split by STT", async () => {
  const { detectAgentName } = await import("../../src/utils/agentNameDetection.js");
  // STT splits "SkyNet" into "sky net"
  assert.equal(detectAgentName("hey sky net do something", "SkyNet"), true);
});

test("detectAgentName: name shorter than 2 chars returns false", async () => {
  const { detectAgentName } = await import("../../src/utils/agentNameDetection.js");
  assert.equal(detectAgentName("hey A do something", "A"), false);
});

test("detectAgentName: empty transcript returns false", async () => {
  const { detectAgentName } = await import("../../src/utils/agentNameDetection.js");
  assert.equal(detectAgentName("", "Jarvis"), false);
});

test("detectAgentName: short name (4 chars) requires exact match, no fuzzy", async () => {
  const { detectAgentName } = await import("../../src/utils/agentNameDetection.js");
  // "Nova" (4 chars) → maxEdits=0, so "Nava" should NOT match
  assert.equal(detectAgentName("hey Nava, do something", "Nova"), false);
});

test("detectAgentName: name with special regex chars does not crash", async () => {
  const { detectAgentName } = await import("../../src/utils/agentNameDetection.js");
  // Agent named "C++" shouldn't throw from unescaped regex.
  // Won't match because \b word boundaries don't fire around non-word chars,
  // but the important thing is no exception from the unescaped regex.
  assert.doesNotThrow(() => detectAgentName("tell C++ to compile", "C++"));
});
