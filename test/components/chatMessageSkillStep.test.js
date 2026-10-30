const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const React = require("react");
const { renderToStaticMarkup } = require("react-dom/server");
const { createRendererServer, installBrowserGlobals } = require("../lib/rendererTestHarness");

async function stepRenderer(t, cachePrefix) {
  installBrowserGlobals(t);
  const vite = await createRendererServer(t, { cachePrefix });
  const [{ default: i18next }, { initReactI18next }] = await Promise.all([
    vite.ssrLoadModule("i18next"),
    vite.ssrLoadModule("react-i18next"),
  ]);
  if (!i18next.isInitialized) {
    const translation = JSON.parse(
      fs.readFileSync(path.join(__dirname, "../../src/locales/en/translation.json"), "utf8")
    );
    await i18next.use(initReactI18next).init({
      lng: "en",
      resources: { en: { translation } },
      interpolation: { escapeValue: false },
    });
  }
  const { ChatMessage } = await vite.ssrLoadModule("/components/chat/ChatMessage.tsx");
  return (toolCall) =>
    renderToStaticMarkup(
      React.createElement(ChatMessage, {
        messageId: "m1",
        role: "assistant",
        content: "",
        isStreaming: false,
        toolCalls: [toolCall],
      })
    ).replaceAll("&#x27;", "'");
}

test("a completed load_skill step reads Using skill · name with the skill icon", async (t) => {
  const render = await stepRenderer(t, "openwhispr-chat-message-skill-step-test-");
  const call = (status, result) => ({
    id: `c-${status}`,
    name: "load_skill",
    arguments: JSON.stringify({ name: "meeting-prep" }),
    status,
    result,
  });

  const done = render(call("completed", "Meeting prep"));
  assert.ok(done.includes("Using skill · Meeting prep"), done);
  assert.ok(done.includes('data-icon="skill-stack"'));

  assert.ok(render(call("executing")).includes("Loading skill…"));
});

test("a failed load_skill step reads Couldn't use skill · the name it asked for", async (t) => {
  const render = await stepRenderer(t, "openwhispr-chat-message-skill-step-failed-test-");
  const failed = (args, result) => ({
    id: "c-failed",
    name: "load_skill",
    arguments: args,
    status: "completed",
    result,
    failed: true,
  });

  const missing = render(failed('{"name":"meeting-perp"}', 'No skill named "meeting-perp"'));
  assert.ok(missing.includes("Couldn't use skill · meeting-perp"), missing);
  assert.ok(!missing.includes("Using skill"), missing);

  const file = render(
    failed(
      '{"name":"meeting-prep","file":"references/agenda.md"}',
      "The meeting-prep skill has no file references/agenda.md to read"
    )
  );
  assert.ok(file.includes("Couldn't use skill · meeting-prep"), file);

  // Arguments that name no skill leave the error as the step's text.
  const unnamed = render(failed("{", "Error: Invalid input for tool load_skill"));
  assert.ok(unnamed.includes("Error: Invalid input for tool load_skill"), unnamed);
  assert.ok(!unnamed.includes("skill ·"), unnamed);
});
