const test = require("node:test");
const assert = require("node:assert/strict");
const { createElement } = require("react");
const { renderToStaticMarkup } = require("react-dom/server");
const { createRendererServer } = require("../lib/rendererTestHarness");

async function loadBar(t) {
  const vite = await createRendererServer(t, { cachePrefix: "openwhispr-workspace-error-bar-" });
  const { WorkspaceErrorBar } = await vite.ssrLoadModule(
    "/components/workspace/WorkspaceErrorBar.tsx"
  );
  return (props) => renderToStaticMarkup(createElement(WorkspaceErrorBar, props));
}

test("renders the message as an alert with its action", async (t) => {
  const render = await loadBar(t);

  const markup = render({
    tone: "error",
    message: "2 couldn't be invited.",
    action: { label: "Try again", onClick: () => {} },
  });

  assert.match(markup, /role="alert"/);
  assert.match(markup, /2 couldn&#x27;t be invited\./);
  assert.match(markup, /<button[^>]*>Try again<\/button>/);
  assert.match(markup, /bg-destructive/);
  assert.doesNotMatch(render({ tone: "error", message: "Nope" }), /<button/);
});

test("warning tone uses the warning tint", async (t) => {
  const render = await loadBar(t);

  const markup = render({ tone: "warning", message: "Email not delivered." });

  assert.match(markup, /role="alert"/);
  assert.match(markup, /bg-warning/);
  assert.doesNotMatch(markup, /destructive/);
});
