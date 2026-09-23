const test = require("node:test");
const assert = require("node:assert/strict");

const loadPrompts = () => import("../../src/config/prompts.ts");

const TOOLS = ["search_notes", "get_calendar_availability"];
const NOTES = "Note: Q3 revenue projections\nRevenue up 12%.";

test("prompt parts keep the clock and retrieved notes out of the stable prefix", async (t) => {
  const { getAgentSystemPromptParts } = await loadPrompts();
  t.mock.timers.enable({ apis: ["Date"], now: Date.parse("2026-09-22T10:00:00Z") });

  const first = getAgentSystemPromptParts(TOOLS, NOTES);
  t.mock.timers.tick(90_000);
  const second = getAgentSystemPromptParts(TOOLS, "Note: something else entirely");

  assert.equal(first.stable, second.stable);
  assert.doesNotMatch(first.stable, /Current local date and time/);
  assert.ok(!first.stable.includes("Revenue up 12%"));
  assert.match(first.turnContext, /Current local date and time/);
  assert.ok(first.turnContext.includes("Revenue up 12%"));
  assert.notEqual(first.turnContext, second.turnContext);
});

test("getAgentSystemPrompt still returns stable + turn context, unchanged for typed chat", async (t) => {
  const { getAgentSystemPrompt, getAgentSystemPromptParts } = await loadPrompts();
  t.mock.timers.enable({ apis: ["Date"], now: Date.parse("2026-09-22T10:00:00Z") });

  const parts = getAgentSystemPromptParts(TOOLS, NOTES);
  assert.equal(getAgentSystemPrompt(TOOLS, NOTES), `${parts.stable}\n\n${parts.turnContext}`);

  const plain = getAgentSystemPromptParts(["search_notes"]);
  assert.equal(plain.turnContext, "");
  assert.equal(getAgentSystemPrompt(["search_notes"]), plain.stable);
});

test("voice turn message carries this turn's context ahead of what the user said", async () => {
  const { buildVoiceTurnMessage } = await loadPrompts();
  const message = buildVoiceTurnMessage("When am I free tomorrow?", "Current local date and time: X.");
  assert.ok(message.endsWith("When am I free tomorrow?"));
  assert.ok(message.indexOf("Current local date and time: X.") < message.indexOf("When am I free"));
  assert.equal(buildVoiceTurnMessage("Hello there", ""), "Hello there");
});

test("voice reply instructions ask for short, speakable answers", async () => {
  const { getVoiceReplyInstructions } = await loadPrompts();
  const instructions = getVoiceReplyInstructions([]);
  assert.match(instructions, /spoken aloud/i);
  assert.match(instructions, /one or two short sentences/i);
  assert.match(instructions, /Markdown/);
});

// Brevity alone made the local model answer from memory: 2/10 tool use in the
// spike's eval, 9/10 with this guidance placed before the brevity rule.
test("voice instructions push tools first, naming only the tools this session has", async () => {
  const { getVoiceReplyInstructions } = await loadPrompts();
  const all = getVoiceReplyInstructions([
    "web_search",
    "search_notes",
    "get_calendar_events",
    "get_calendar_availability",
  ]);
  assert.match(all, /call web_search/);
  assert.match(all, /out of date/);
  assert.match(all, /call search_notes/);
  assert.match(all, /calendar tools/);
  assert.match(all, /never just say that you will check/i);
  assert.ok(all.indexOf("web_search") < all.indexOf("one or two short sentences"));

  const offline = getVoiceReplyInstructions(["search_notes"]);
  assert.doesNotMatch(offline, /web_search/);
  assert.doesNotMatch(offline, /calendar/);
  assert.match(offline, /call search_notes/);
});
