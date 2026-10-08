const test = require("node:test");
const assert = require("node:assert/strict");

const load = () => import("../../src/config/prompts.ts");

test("the prompt lists what the assistant can do, grouped, before how to use each tool", async () => {
  const { getAgentSystemPrompt } = await load();
  const prompt = getAgentSystemPrompt([
    "search_notes",
    "create_note",
    "web_search",
    "copy_to_clipboard",
    {
      name: "slack_send_message",
      connectorId: "slack",
      promptInstruction: "Use slack_send_message…",
    },
    {
      name: "linear_search_issues",
      connectorId: "linear",
      promptInstruction: "Use linear_search…",
    },
    { name: "linear_comment", connectorId: "linear", promptInstruction: "Use linear_comment…" },
  ]);

  assert.match(prompt, /You can use these tools:\n/);
  assert.match(prompt, /^- The user's notes: search_notes, create_note$/m);
  assert.match(prompt, /^- Web search: web_search$/m);
  assert.match(prompt, /^- Clipboard: copy_to_clipboard$/m);
  assert.match(prompt, /^- Slack: slack_send_message$/m);
  assert.match(prompt, /^- Linear: linear_search_issues, linear_comment$/m);
  assert.ok(prompt.indexOf("You can use these tools") < prompt.indexOf("How to use them"));
  assert.match(prompt, /^- Use search_notes to find/m);
  assert.doesNotMatch(prompt, /The user's calendar/);
});

test("the prompt forbids claiming an ability a listed tool covers", async () => {
  const { getAgentSystemPrompt } = await load();
  const prompt = getAgentSystemPrompt(["web_search"]);
  assert.match(prompt, /Never tell the user you can't do something one of these tools covers/);
  assert.match(prompt, /never say you can't browse the web when web search is listed/);
  assert.match(prompt, /say that it failed rather than claiming you lack the ability/);
});

test("web search is for anything that may have changed, and when in doubt the model searches", async () => {
  const { getAgentSystemPrompt } = await load();
  const prompt = getAgentSystemPrompt(["web_search"]);
  assert.match(
    prompt,
    /Use web_search whenever the answer depends on public information that may have changed/
  );
  assert.match(prompt, /whenever the user asks you to look something up/);
  assert.match(prompt, /search rather than decline/);
});

test("web search stays on public information the context doesn't already answer", async () => {
  const { getAgentSystemPrompt } = await load();
  const prompt = getAgentSystemPrompt(["web_search", "search_notes"]);
  assert.doesNotMatch(prompt, /releases, people,/);
  assert.match(prompt, /Don't search for people the user knows personally/);
  assert.match(prompt, /nor for anything the conversation, the user's notes or the context/);
  assert.match(prompt, /don't call one when the conversation or the context provided here/);
});

test("connector tools group under the same names the unavailable list uses", async () => {
  const { getAgentSystemPrompt } = await load();
  const { CONNECTOR_NAMES } = await import("../../src/config/agentCapabilities.ts");
  const prompt = getAgentSystemPrompt(
    Object.keys(CONNECTOR_NAMES).map((connectorId) => ({
      name: `${connectorId}_tool`,
      connectorId,
    }))
  );
  for (const [connectorId, name] of Object.entries(CONNECTOR_NAMES)) {
    assert.match(prompt, new RegExp(`^- ${name}: ${connectorId}_tool$`, "m"));
  }
});

test("the tool-trace rule rides only with traced history", async () => {
  const { getAgentSystemPrompt } = await load();
  assert.match(
    getAgentSystemPrompt(["web_search"], undefined, { toolTrace: true }),
    /\[Tools used: …\] note .* Never write such a note yourself/
  );
  assert.doesNotMatch(getAgentSystemPrompt(["web_search"]), /Tools used/);
});

test("without tools there is no capability block, but unavailable capabilities are still named", async () => {
  const { getAgentSystemPrompt } = await load();
  const bare = getAgentSystemPrompt([]);
  assert.doesNotMatch(bare, /You can use these tools|Never tell the user/);

  const tooSmall = getAgentSystemPrompt([], undefined, {
    unavailable: [
      {
        name: "Tools (web search, notes, calendar, integrations)",
        reason: "modelTooSmall",
        where: "Settings → Language Models",
      },
    ],
  });
  assert.match(tooSmall, /Not available in this conversation/);
  assert.match(tooSmall, /runs without tools.*Settings → Language Models/);
});

test("unavailable capabilities sit after the tools and before the note context", async () => {
  const { getAgentSystemPrompt } = await load();
  const prompt = getAgentSystemPrompt(["search_notes"], "Note ID: 7", {
    unavailable: [{ name: "Slack", reason: "notConnected", where: "Integrations → Connectors" }],
  });
  const tools = prompt.indexOf("You can use these tools");
  const unavailable = prompt.indexOf("- Slack: not connected");
  const note = prompt.indexOf("Note ID: 7");
  assert.ok(tools !== -1 && tools < unavailable && unavailable < note);
});

test("a note's chat answers from its note first, then searches other notes and names the one used", async () => {
  const { getAgentSystemPrompt } = await load();
  const prompt = getAgentSystemPrompt(["search_notes"], undefined, { openNote: "Note ID: 7" });
  assert.match(
    prompt,
    /answer from this note first[^]*with search_notes, and name the note[^]*\n\nNote ID: 7$/
  );
  assert.doesNotMatch(prompt, /notes from the user's library/);

  // Without search_notes there's nothing to look in.
  const withoutTools = getAgentSystemPrompt([], undefined, { openNote: "Note ID: 7" });
  assert.match(withoutTools, /say so\.\n\nNote ID: 7$/);
  assert.doesNotMatch(withoutTools, /search_notes/);
});
