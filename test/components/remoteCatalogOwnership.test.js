const test = require("node:test");
const assert = require("node:assert/strict");
const React = require("react");
const { createRendererServer } = require("../lib/rendererTestHarness");
const { mountAuditDom, deferred } = require("../lib/settingsAuditHarness");

test("remote catalogs reject ABA/key/refresh races, keep drafts and adopt only current fallbacks", async (t) => {
  const { render, root } = await mountAuditDom(t);
  const pending = [];
  t.mock.method(globalThis, "fetch", (url, options) => {
    const request = { ...deferred(), url, options };
    pending.push(request);
    return request.promise;
  });
  const seen = (globalThis.__remoteCatalog = { buttons: [], options: [] });
  t.after(() => delete globalThis.__remoteCatalog);
  const vite = await createRendererServer(t, {
    noExternal: ["react-i18next"],
    mockModules: {
      "react-i18next": `const t = key => key; export const useTranslation = () => ({t});`,
      "/ui/input": `export const Input = props => { globalThis.__remoteCatalog.input = props; return null; };`,
      "/ui/button": `export const Button = props => { globalThis.__remoteCatalog.buttons.push(props); return null; };`,
      "/ui/ApiKeyInput": `export default () => null;`,
      "/ui/ModelCardList": `export default ({models}) => {globalThis.__remoteCatalog.options = models; return null;};`,
      "/ui/SearchableModelList": `import {useState} from "react"; export const MODEL_SEARCH_THRESHOLD = 2; export default ({models}) => {const [draft,setDraft]=useState(""); globalThis.__remoteCatalog.search = {models,draft,setDraft}; return null;};`,
    },
  });
  const { default: Panel } = await vite.ssrLoadModule("/components/OpenAICompatiblePanel.tsx");
  let update;
  const writes = [];
  function Owner() {
    const [config, setConfig] = React.useState({
      baseUrl: "https://a.test/v1",
      apiKey: "fake-one",
      lockedBaseUrl: false,
    });
    update = (patch) => setConfig((current) => ({ ...current, ...patch }));
    return React.createElement(Panel, {
      ...config,
      setBaseUrl: (baseUrl) => {
        writes.push(baseUrl);
        update({ baseUrl });
      },
      setApiKey() {},
      model: "manual-model",
      setModel: () => assert.fail("discovery is not an allowlist"),
      defaultBaseUrl: "https://reset.test/v1",
    });
  }
  await render(React.createElement(Owner));
  const change = (patch) => React.act(async () => update(patch));
  const finish = (index, ids) =>
    React.act(async () =>
      pending[index].resolve({ ok: true, json: async () => ({ data: ids.map((id) => ({ id })) }) })
    );
  const refresh = () =>
    React.act(async () =>
      seen.buttons
        .findLast((b) => b.children === "common.refresh" || b.children === "common.loading")
        .onClick()
    );
  await change({ baseUrl: "https://b.test/v1" });
  await change({ baseUrl: "https://a.test/v1" });
  assert.equal(pending.length, 3);
  await finish(0, ["old-a"]);
  assert.deepEqual(seen.options, []);
  await finish(2, ["current-a"]);
  await finish(1, ["old-b"]);
  assert.equal(seen.options[0].value, "current-a");
  await change({ apiKey: "fake-two" });
  assert.equal(pending[3].options.headers.Authorization, "Bearer fake-two");
  await refresh();
  await refresh();
  assert.equal(pending.length, 6);
  await finish(4, ["older-refresh"]);
  assert.deepEqual(seen.options, []);
  await finish(5, ["new-1", "new-2", "new-3"]);
  await React.act(async () => pending[3].reject(new Error("old credential failure")));
  assert.equal(seen.search.models[0].value, "new-1");
  await React.act(async () => seen.search.setDraft("kept search"));
  await change({ apiKey: "fake-three" });
  assert.equal(seen.search.draft, "kept search");
  assert.deepEqual(seen.search.models, []);
  await finish(6, ["replacement"]);
  assert.equal(
    seen.search.draft,
    "kept search",
    "small replacement catalog does not remount the visited search leaf"
  );
  const typed = pending.length;
  await React.act(async () =>
    seen.input.onChange({ target: { value: " https://draft.test/v1/ " } })
  );
  assert.equal(pending.length, typed, "typing does not fetch");
  await change({ baseUrl: "https://external.test/v1" });
  assert.equal(
    seen.input.value,
    " https://draft.test/v1/ ",
    "external settings preserve a genuine endpoint draft"
  );
  await finish(7, ["external"]);
  await React.act(async () => seen.input.onBlur());
  assert.equal(writes.at(-1), "https://draft.test/v1");
  await finish(8, ["applied"]);

  await change({ baseUrl: "https://fallback.test/api/v1", lockedBaseUrl: false });
  await finish(9, []);
  assert.equal(pending[10].url, "https://fallback.test/v1/models");
  await finish(10, ["fallback"]);
  assert.equal(writes.at(-1), "https://fallback.test/v1");
  assert.equal(pending.length, 11, "owned adopted catalog is not fetched twice");
  await change({ baseUrl: "https://obsolete.test/api/v1" });
  await finish(11, []);
  await change({ baseUrl: "https://current.test/v1" });
  await finish(12, ["stale-fallback"]);
  assert.equal(writes.at(-1), "https://fallback.test/v1", "stale fallback cannot write settings");
  await finish(13, ["current"]);
  await refresh();
  await render(null);
  await finish(14, ["unmounted"]);
  assert.equal(writes.at(-1), "https://fallback.test/v1");
  for (const action of ["apply", "reset"]) {
    await render(React.createElement(Owner));
    await finish(pending.length - 1, ["initial"]);
    if (action === "apply")
      await React.act(async () =>
        seen.input.onChange({ target: { value: "https://unmounted.test/api/v1" } })
      );
    await React.act(async () => {
      if (action === "apply") seen.input.onBlur();
      else seen.buttons.findLast((button) => button.children === "common.reset").onClick();
      root.render(null);
    });
    const request = pending.at(-1);
    assert.equal(
      request.options.signal.aborted,
      true,
      `${action}: lifetime cancels before new config commits`
    );
    const count = pending.length;
    const publications = writes.length;
    await finish(count - 1, []);
    assert.equal(pending.length, count, "no fallback request after unmount");
    assert.equal(writes.length, publications, "no fallback endpoint publication after unmount");
  }

  // Ported from the endpoint-actions test: reset publishes the default
  // endpoint; apply-and-refresh adopts the applied draft's catalog.
  await render(React.createElement(Owner));
  await finish(pending.length - 1, ["initial"]);
  await React.act(async () =>
    seen.buttons.findLast((button) => button.children === "common.reset").onClick()
  );
  assert.equal(writes.at(-1), "https://reset.test/v1", "reset publishes the default endpoint");
  await finish(pending.length - 1, ["default-model"]);
  await React.act(async () =>
    seen.input.onChange({ target: { value: " https://applied.test/v1/ " } })
  );
  await React.act(async () =>
    seen.buttons
      .findLast((button) => button.children === "reasoning.custom.applyAndRefresh")
      .onClick()
  );
  assert.equal(writes.at(-1), "https://applied.test/v1");
  await finish(pending.length - 1, ["applied-model"]);
  assert.equal(
    seen.options[0].value,
    "applied-model",
    "apply-and-refresh adopts the applied catalog"
  );
});
