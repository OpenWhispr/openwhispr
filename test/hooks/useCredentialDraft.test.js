const test = require("node:test");
const assert = require("node:assert/strict");
const React = require("react");
const { createRoot } = require("react-dom/client");
const {
  createRendererServer,
  installBrowserGlobals,
  installHookDom,
} = require("../lib/rendererTestHarness");

async function mountDraft(t) {
  let root;
  t.after(async () => {
    if (root) await React.act(async () => root.unmount());
  });
  installBrowserGlobals(t);
  const container = installHookDom(t);
  const vite = await createRendererServer(t, { cachePrefix: "openwhispr-credential-draft-" });
  const { useCredentialDraft } = await vite.ssrLoadModule("/hooks/useCredentialDraft.ts");
  let draft;
  function Harness() {
    draft = useCredentialDraft();
    return null;
  }
  root = createRoot(container);
  await React.act(async () => root.render(React.createElement(Harness)));
  return { draft: () => draft, act: (run) => React.act(async () => run(draft)) };
}

const report = (phase, apiKey) => ({ phase, checked: { apiKey }, refused: false });

test("an answer settles only a draft that still holds the value it was for", async (t) => {
  const hook = await mountDraft(t);
  const saved = [];
  const save = (value) => saved.push(value);
  await hook.act((draft) => draft.change("apiKey", "abc", save));
  await hook.act((draft) => draft.follow(report("checking", "abc")));
  // A keystroke lands before the pass for "abc" reaches the hook.
  await hook.act((draft) => draft.change("apiKey", "abcd", save));
  await hook.act((draft) => draft.follow(report("connected", "abc")));
  assert.deepEqual(saved, []);
  assert.equal(hook.draft().value("apiKey", ""), "abcd");
  await hook.act((draft) => draft.follow(report("waiting", "abcd")));
  await hook.act((draft) => draft.follow(report("connected", "abcd")));
  assert.deepEqual(saved, ["abcd"]);
});
