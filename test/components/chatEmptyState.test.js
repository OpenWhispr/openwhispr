const test = require("node:test");
const assert = require("node:assert/strict");
const React = require("react");
const { renderToStaticMarkup } = require("react-dom/server");
const { createRendererServer, installBrowserGlobals } = require("../lib/rendererTestHarness");

test("new-chat suggestions keep localized prompts, busy state and returning-chat visibility", async (t) => {
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
  const submitted = [];
  const props = {
    showSuggestions: true,
    disabled: false,
    onPrompt: (text) => submitted.push(text),
  };
  const render = (overrides = {}) =>
    renderToStaticMarkup(React.createElement(NewChatEmptyState, { ...props, ...overrides }));
  const html = render();
  assert.equal((html.match(/<button/g) ?? []).length, 3);
  assert.doesNotMatch(html, /disabled=""/);
  assert.equal((render({ disabled: true }).match(/disabled=""/g) ?? []).length, 3);
  assert.doesNotMatch(render({ showSuggestions: false }), /<button/);

  // The isolated translation hook has no React hooks; invoke the rendered buttons' real callbacks.
  const tree = NewChatEmptyState(props);
  for (const button of tree.props.children[1].props.children) button.props.onClick();
  assert.deepEqual(submitted, [
    "localized:chat.starters.todos",
    "localized:chat.starters.meeting",
    "localized:chat.starters.sharedNotes",
  ]);
});
