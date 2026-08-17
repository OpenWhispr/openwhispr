const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { createElement } = require("react");
const { renderToStaticMarkup } = require("react-dom/server");
const i18next = require("i18next");
const { initReactI18next } = require("react-i18next");

// tsx resolves tsconfig from the cwd, where none sets the automatic JSX runtime,
// so compiled .tsx uses the classic transform and needs a global React.
globalThis.React = require("react");

async function initI18n() {
  if (i18next.isInitialized) return;
  const en = JSON.parse(
    fs.readFileSync(path.join(__dirname, "../../src/locales/en/translation.json"), "utf8")
  );
  await i18next.use(initReactI18next).init({
    lng: "en",
    resources: { en: { translation: en } },
    interpolation: { escapeValue: false },
  });
}

// tsx compiles the .tsx module to CJS, so its default lands one level deeper.
function unwrapDefault(mod) {
  return mod.default?.default ?? mod.default;
}

test("empty conversation list renders its copy and the new chat action", async () => {
  await initI18n();
  const mod = await import("../../src/components/chat/EmptyConversationList.tsx");
  const EmptyConversationList = unwrapDefault(mod);
  const html = renderToStaticMarkup(createElement(EmptyConversationList, { onNewChat: () => {} }));

  assert.ok(html.includes("Start your first conversation"));
  assert.ok(html.includes("New chat"));
});

test("model card list with zero models renders the shared empty state copy", async () => {
  await initI18n();
  const mod = await import("../../src/components/ui/ModelCardList.tsx");
  const ModelCardList = unwrapDefault(mod);
  const html = renderToStaticMarkup(createElement(ModelCardList, { models: [] }));

  assert.ok(html.includes("No models available"));
});

test("chat empty selection state renders copy with an icon instead of the retired illustration", async () => {
  await initI18n();
  const mod = await import("../../src/components/chat/EmptyChatState.tsx");
  const EmptyChatState = unwrapDefault(mod);
  const html = renderToStaticMarkup(createElement(EmptyChatState));

  assert.ok(html.includes("Select a conversation or start a new one"));
  assert.ok(html.includes("<svg"));
});
