const test = require("node:test");
const assert = require("node:assert/strict");
const React = require("react");
const { createRendererServer } = require("../lib/rendererTestHarness");
const { mountAuditDom, deferred } = require("../lib/settingsAuditHarness");

async function setup(t) {
  const mounted = await mountAuditDom(t);
  const seen = (globalThis.__namePrompt = {
    calls: [],
    deltas: [],
  });
  t.after(() => delete globalThis.__namePrompt);
  mounted.dom.electronAPI = {
    applyDictionaryChanges: async (delta) => {
      seen.deltas.push(delta);
    },
  };
  localStorage.setItem("agentName", "Whisper");
  localStorage.setItem("customDictionary", JSON.stringify(["Whisper", "Unrelated"]));
  const mocks = {
    "react-i18next": `const t=(key,opts)=>key+(opts?JSON.stringify(opts):"");export const useTranslation=()=>({t,i18n:{language:"en"}});`,
    "/i18n": `export const normalizeUiLanguage=value=>value||"en";export default {language:"en",changeLanguage:async()=>{},getFixedT:locale=>(key)=>locale+":"+key+" {{agentName}} {{targetLanguage}}"};`,
    "/utils/logger": `export default {debug(){},error(){},warn(){},info(){}};`,
    "/services/SyncService.js": `export const syncService={canSync:()=>false,syncDictionaryNow(){}};`,
    "/hooks/usePolicy": `export const usePolicySnapshot=()=>({status:"idle",policy:null});`,
    "/hooks/useScreenRecordingPermission": `export const useScreenRecordingPermission=()=>({isMacOS:false,supported:false});`,
    "/settings/InferenceConfigEditor": `export default ()=>null;`,
    "./InferenceConfigEditor": `export default ()=>null;`,
    "/hooks/useDialogs": `export const useDialogs=()=>({alertDialog:{},showAlertDialog(){},hideAlertDialog(){}});`,
    "/SnippetsView": `export default ()=>null;`,
    "/DictionaryEmptyIllustration": `export default ()=>null;`,
    "/ui/useToast": `export const useToast=()=>({toast(){}});`,
    "./dialog": `export const AlertDialog=()=>null;`,
    "/services/ReasoningService": `export default {processText(...args){const request=globalThis.__namePrompt.begin(args);return request.promise;}};`,
    "/helpers/dictationAgentInference": `export const resolveDictationAgentInference=()=>({reachable:true,model:"agent",displayProvider:"openwhispr",config:{provider:"openwhispr"}});`,
    "/helpers/dictationTranslationInference": `export const resolveDictationTranslationInference=()=>({reachable:true,model:"translate",displayProvider:"openwhispr",config:{provider:"openwhispr"}});`,
  };
  seen.begin = (args) => {
    const request = { ...deferred(), args };
    seen.calls.push(request);
    return request;
  };
  const vite = await createRendererServer(t, { noExternal: ["react-i18next"], mockModules: mocks });
  const names = await vite.ssrLoadModule("/utils/agentName.ts");
  const { useSettingsStore: store } = await vite.ssrLoadModule("/stores/settingsStore.ts");
  store.setState({
    useDictationAgent: true,
    useCleanupModel: true,
    cleanupMode: "openwhispr",
    cleanupCloudMode: "openwhispr",
    cleanupModel: "auto",
    isSignedIn: true,
    useDictationTranslation: true,
    translationMode: "openwhispr",
    translationCloudMode: "openwhispr",
    translationTargetLanguage: "es",
  });
  const { default: Studio } = await vite.ssrLoadModule("/components/ui/PromptStudio.tsx");
  const { default: Settings } = await vite.ssrLoadModule(
    "/components/settings/DictationAgentSettings.tsx"
  );
  const prompts = await vite.ssrLoadModule("/config/prompts/index.ts");
  const click = (root, text) =>
    React.act(async () => {
      const button = [...root.querySelectorAll("button")].find(
        (b) => b.textContent.trim() === text
      );
      assert.ok(button, `${text}: ${root.textContent}`);
      button.click();
    });
  const edit = (el, value) =>
    React.act(async () => {
      assert.ok(el);
      el[Object.keys(el).find((k) => k.startsWith("__reactProps$"))].onChange({
        target: { value },
      });
    });
  return { ...mounted, seen, vite, mocks, names, store, Studio, Settings, prompts, click, edit };
}

test("saved name synchronizes independent renderer owners, dictionary deltas, defaults and disposers", async (t) => {
  const { dom, names, store, mocks, seen } = await setup(t);
  const other = await createRendererServer(t, { mockModules: mocks });
  const second = await other.ssrLoadModule("/utils/agentName.ts");
  const stopOne = names.subscribeAgentNameChanges(),
    stopTwo = second.subscribeAgentNameChanges();
  t.after(() => {
    stopOne();
    stopTwo();
  });
  // The browser delivers a rename to other windows as a storage event.
  const storageEvent = (key) =>
    dom.dispatchEvent(new dom.StorageEvent("storage", { key, storageArea: dom.localStorage }));
  names.setAgentName("  Nova  ");
  storageEvent("agentName");
  assert.equal(names.getAgentName(), "Nova");
  assert.equal(second.getAgentName(), "Nova");
  assert.deepEqual(store.getState().customDictionary, ["Unrelated", "Nova"]);
  assert.equal(seen.deltas.length, 1, "only the renaming owner writes the dictionary");
  assert.ok(seen.deltas.every((d) => !d.remove.includes("Unrelated")));
  localStorage.setItem("agentName", "  External  ");
  await React.act(async () => storageEvent("agentName"));
  assert.equal(names.getAgentName(), "External");
  assert.equal(second.getAgentName(), "External");
  assert.equal(seen.deltas.length, 1);
  localStorage.removeItem("agentName");
  storageEvent("agentName");
  assert.equal(names.getAgentName(), "OpenWhispr");
  names.setAgentName(" ");
  assert.equal(names.getAgentName(), "OpenWhispr");
  names.setAgentName("BeforeClear");
  storageEvent("agentName");
  const deltas = seen.deltas.length;
  localStorage.clear();
  storageEvent(null);
  assert.equal(second.getAgentName(), "BeforeClear", "clearing storage is not a rename");
  assert.equal(seen.deltas.length, deltas, "clearing storage writes no dictionary delta");
  t.mock.method(dom.localStorage, "setItem", () => {
    throw new Error("fake denied storage");
  });
  assert.throws(() => names.setAgentName("Unsaved"), /denied storage/);
  assert.equal(names.getAgentName(), "BeforeClear");
  assert.equal(second.getAgentName(), "BeforeClear");
  assert.equal(seen.deltas.length, deltas);
  t.mock.restoreAll();
  stopOne();
  stopTwo();
  localStorage.setItem("agentName", "Detached");
  storageEvent("agentName");
  assert.equal(names.getAgentName(), "BeforeClear", "storage listener disposed too");
});

test("real name inputs retain dirty drafts while all mounted and hidden studios use the saved name", async (t) => {
  const { render, container, names, seen, Studio, Settings, click, edit, vite } = await setup(t);
  const { default: Dictionary } = await vite.ssrLoadModule("/components/DictionaryView.tsx");
  await render(
    React.createElement(
      React.StrictMode,
      null,
      React.createElement("section", { id: "settings-one" }, React.createElement(Settings)),
      React.createElement(
        "section",
        { id: "settings-two", hidden: true },
        React.createElement(Settings)
      ),
      React.createElement("section", { id: "dictionary" }, React.createElement(Dictionary)),
      ...["cleanup", "dictationAgent", "translate"].map((kind) =>
        React.createElement(
          "section",
          { id: kind, key: kind, hidden: kind === "translate" },
          React.createElement(Studio, { kind })
        )
      )
    )
  );
  const one = container.querySelector("#settings-one"),
    two = container.querySelector("#settings-two");
  const input = (root) =>
    root.querySelector('input[aria-label="settingsPage.agentConfig.agentName"]');
  await edit(input(two), "Genuine dirty draft");
  await edit(input(one), "  Saved Nova  ");
  assert.equal(names.getAgentName(), "Whisper", "typing is never saved");
  await click(one, "settingsPage.agentConfig.save");
  assert.equal(input(one).value, "Saved Nova");
  assert.equal(input(two).value, "Genuine dirty draft");
  assert.equal(seen.deltas.length, 1);
  assert.match(container.querySelector("#dictionary").textContent, /Saved Nova/);
  assert.match(container.querySelector("#dictionary").textContent, /Unrelated/);
  assert.equal(container.querySelector("#dictionary").textContent.includes("Whisper"), false);
  for (const kind of ["cleanup", "dictationAgent", "translate"]) {
    const root = container.querySelector(`#${kind}`);
    assert.match(root.querySelector("pre").textContent, /Saved Nova/);
    await click(root, "promptStudio.tabs.customize");
    assert.match(root.textContent, /Saved Nova/);
    await click(root, "promptStudio.tabs.test");
    if (kind === "cleanup") assert.match(root.textContent, /addressHint.*Saved Nova/);
    await click(root, "promptStudio.test.run");
    const request = seen.calls.at(-1);
    assert.equal(request.args[2], "Saved Nova");
    if (kind !== "cleanup") assert.match(request.args[3].systemPrompt, /Saved Nova/);
    await React.act(async () => request.resolve("finished"));
  }
});

for (const kind of ["cleanup", "dictationAgent", "translate"]) {
  test(`${kind} pristine prompt follows locale/saved changes; drafts survive store writes until typed back`, async (t) => {
    const { render, container, Studio, store, prompts, click, edit } = await setup(t);
    await render(React.createElement(Studio, { kind }));
    await click(container, "promptStudio.tabs.customize");
    const textarea = () => container.querySelector('textarea[rows="16"]');
    assert.equal(textarea().value, prompts.getDefaultPromptText(kind, "en"));
    await React.act(async () => store.getState().setUiLanguage("es"));
    assert.equal(textarea().value, prompts.getDefaultPromptText(kind, "es"));
    await click(container, "promptStudio.common.save");
    assert.equal(
      store.getState().customPrompts[kind],
      "",
      "pristine localized default must not become an old custom prompt"
    );
    await React.act(async () => store.getState().setCustomPrompt(kind, "External {{agentName}}"));
    assert.equal(textarea().value, "External {{agentName}}");
    await edit(textarea(), "Dirty {{agentName}}");
    await React.act(async () => {
      store.getState().setUiLanguage("fr");
      store.getState().setCustomPrompt(kind, "New saved");
    });
    assert.equal(textarea().value, "Dirty {{agentName}}");
    await edit(textarea(), "New saved");
    await React.act(async () => store.getState().setCustomPrompt(kind, "Latest saved"));
    assert.equal(
      textarea().value,
      "Latest saved",
      "typing back to resolved text releases draft ownership"
    );
    await edit(textarea(), "");
    await click(container, "promptStudio.common.save");
    assert.equal(store.getState().customPrompts[kind], "");
    assert.equal(textarea().value, prompts.getDefaultPromptText(kind, "fr"));
    await edit(textarea(), "Discard");
    await click(container, "promptStudio.common.reset");
    assert.equal(textarea().value, prompts.getDefaultPromptText(kind, "fr"));
    assert.equal(store.getState().customPrompts[kind], "");
  });
}

test("concurrent real prompt studios capture isolated Test inputs through interleaved Save/Reset and unmount", async (t) => {
  const { render, container, Studio, store, seen, prompts, names, click, edit } = await setup(t);
  const kinds = ["cleanup", "dictationAgent", "translate"];
  await render(
    React.createElement(
      React.Fragment,
      null,
      ...kinds.map((kind) =>
        React.createElement(
          "section",
          { key: kind, id: kind },
          React.createElement(Studio, { kind })
        )
      )
    )
  );
  await React.act(async () => names.setAgentName("CurrentName"));
  for (const kind of kinds) {
    const root = container.querySelector(`#${kind}`);
    await click(root, "promptStudio.tabs.customize");
    await edit(
      root.querySelector('textarea[rows="16"]'),
      `${kind} request {{agentName}} {{targetLanguage}}`
    );
    await click(root, "promptStudio.tabs.test");
    await click(root, "promptStudio.test.run");
  }
  assert.equal(seen.calls.length, 3);
  assert.equal(store.getState().customPrompts.cleanup, "");
  for (const [index, kind] of kinds.entries()) {
    const root = container.querySelector(`#${kind}`);
    await click(root, "promptStudio.tabs.customize");
    await edit(root.querySelector('textarea[rows="16"]'), `${kind} saved`);
    await click(root, index === 1 ? "promptStudio.common.reset" : "promptStudio.common.save");
    assert.ok(!prompts.resolvePrompt(kind, { agentName: "CurrentName" }).includes("request"));
    const config = seen.calls[index].args[3];
    assert.match(
      kind === "cleanup" ? config.cleanupPrompt : config.systemPrompt,
      new RegExp(`${kind} request`)
    );
    if (kind !== "cleanup") assert.match(config.systemPrompt, /CurrentName/);
  }
  const saved = { ...store.getState().customPrompts };
  await React.act(async () => {
    seen.calls[2].resolve("translation result");
    seen.calls[0].resolve("cleanup result");
    seen.calls[1].reject(new Error("fake rejection"));
  });
  assert.deepEqual(store.getState().customPrompts, saved);
  for (const kind of kinds)
    await click(container.querySelector(`#${kind}`), "promptStudio.tabs.test");
  assert.match(container.textContent, /translation result/);
  assert.match(container.textContent, /cleanup result/);
  assert.match(container.textContent, /fake rejection/);
  await click(container.querySelector("#cleanup"), "promptStudio.test.run");
  const detached = seen.calls.at(-1);
  await render(null);
  await React.act(async () => detached.resolve("must not publish"));
  assert.equal(container.textContent, "");
  assert.deepEqual(store.getState().customPrompts, saved);
});
