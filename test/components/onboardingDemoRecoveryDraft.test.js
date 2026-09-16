const assert = require("node:assert/strict");
const test = require("node:test");

const load = () => import("../../src/components/onboarding/flow.ts");

test("explicit practice recovery drafts survive a session roundtrip with route progress", async () => {
  const { createOnboardingSession, parseOnboardingSession } = await load();
  const session = createOnboardingSession();
  session.authPath = "account";
  session.currentStepId = "assistant-demo";
  session.history = ["auth", "permissions", "dictation-demo", "assistant-hotkey"];
  session.resume.dictationHotkeyConfirmed = true;
  session.resume.dictationDemoCompleted = true;
  session.resume.demoRecoveryDrafts = {
    dictation: { text: "Keep my typed practice text.", transcript: "" },
    assistant: { text: "Hi Maria,", transcript: "Suggest a time for coffee." },
  };

  assert.deepEqual(parseOnboardingSession(JSON.stringify(session)), session);
});

test("practice recovery parsing keeps bounded known strings and rejects malformed drafts", async () => {
  const { createOnboardingSession, parseOnboardingSession } = await load();
  const session = createOnboardingSession();
  const parseDrafts = (drafts) => {
    session.resume.demoRecoveryDrafts = drafts;
    return parseOnboardingSession(JSON.stringify(session)).resume.demoRecoveryDrafts;
  };

  for (const value of [null, false, 42, "text", []]) {
    assert.deepEqual(parseDrafts(value), {});
    assert.deepEqual(parseDrafts({ dictation: value, assistant: value }), {});
  }

  assert.deepEqual(
    parseDrafts({
      dictation: { text: 42, transcript: false, password: "discard" },
      assistant: { text: "reply", transcript: "heard", apiKey: "discard" },
      unknown: { text: "discard", transcript: "discard" },
    }),
    {
      dictation: { text: "", transcript: "" },
      assistant: { text: "reply", transcript: "heard" },
    }
  );
  assert.deepEqual(
    parseDrafts({ assistant: { text: "a".repeat(20001), transcript: "b".repeat(20001) } }),
    { assistant: { text: "a".repeat(20000), transcript: "b".repeat(20000) } }
  );
});

test("older onboarding sessions resume without creating practice recovery drafts", async () => {
  const { createOnboardingSession, parseOnboardingSession } = await load();
  const session = createOnboardingSession();
  assert.deepEqual(session.resume.demoRecoveryDrafts, {});

  session.authPath = "account";
  session.currentStepId = "assistant-demo";
  session.resume.dictationDemoCompleted = true;
  delete session.resume.demoRecoveryDrafts;
  const previous = parseOnboardingSession(JSON.stringify(session));
  assert.deepEqual(previous.resume.demoRecoveryDrafts, {});
  assert.equal(previous.resume.dictationDemoCompleted, true);

  delete session.resume;
  const legacy = parseOnboardingSession(JSON.stringify(session));
  assert.deepEqual(legacy.resume.demoRecoveryDrafts, {});
  assert.equal(legacy.resume.dictationHotkeyConfirmed, true);
  assert.equal(legacy.resume.assistantHotkeyConfirmed, true);
  assert.equal(legacy.resume.dictationDemoCompleted, false);
});
