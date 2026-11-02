const test = require("node:test");
const assert = require("node:assert/strict");
const React = require("react");
const { renderToStaticMarkup } = require("react-dom/server");
const { createRendererServer, installBrowserGlobals } = require("../lib/rendererTestHarness");

test("new-chat suggestions keep busy state and returning-chat visibility", async (t) => {
  installBrowserGlobals(t);
  const server = await createRendererServer(t, {
    noExternal: ["react-i18next"],
    mockModules: {
      "react-i18next": `export const useTranslation = () => ({ t: key => "localized:" + key });`,
    },
  });
  const { NewChatEmptyState } = await server.ssrLoadModule(
    "/components/chat/NewChatEmptyState.tsx"
  );
  const props = { showSuggestions: true, disabled: false, onPrompt: () => {} };
  const render = (overrides = {}) =>
    renderToStaticMarkup(React.createElement(NewChatEmptyState, { ...props, ...overrides }));
  const html = render();
  assert.equal((html.match(/<button/g) ?? []).length, 3);
  assert.doesNotMatch(html, /disabled=""/);
  assert.equal((render({ disabled: true }).match(/disabled=""/g) ?? []).length, 3);
  assert.doesNotMatch(render({ showSuggestions: false }), /<button/);
});
