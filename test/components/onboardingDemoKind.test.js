const assert = require("node:assert/strict");
const test = require("node:test");

const load = () => import("../../src/utils/onboardingDemo.ts");

test("voice-agent recordings publish to the assistant onboarding session", async () => {
  const { getOnboardingDemoKind } = await load();

  assert.equal(getOnboardingDemoKind(true), "assistant");
  assert.equal(getOnboardingDemoKind(false), "dictation");
});

test("the assistant demo request carries the email and asks for the bare reply", async () => {
  const { buildAssistantDemoRequest } = await load();
  const request = buildAssistantDemoRequest("Reply and suggest a few times next week.", {
    senderName: "Maria Alvarez",
    subject: "Coffee next week?",
    body: "Hi! Would you be up for a quick coffee next week?\n\nMaria",
  });

  assert.ok(request.startsWith("Reply and suggest a few times next week."));
  assert.match(request, /From: Maria Alvarez/);
  assert.match(request, /Subject: Coffee next week\?/);
  assert.match(request, /quick coffee next week/);
  assert.match(request, /Address Maria by name/);
  assert.match(request, /no markdown/);
  assert.match(request, /Do not sign a name or a company/);
  // The demo has no follow-up turn, so the clarifying question the calendar
  // tool's instructions otherwise call for has to be pre-answered.
  assert.match(request, /never ask the user a question back/);
  assert.match(request, /weekdays next week between 9:00 and 17:00/);
});
