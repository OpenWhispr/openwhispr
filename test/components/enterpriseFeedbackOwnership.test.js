const test = require("node:test");
const assert = require("node:assert/strict");
const React = require("react");
const { createRendererServer } = require("../lib/rendererTestHarness");
const { mountAuditDom, deferred } = require("../lib/settingsAuditHarness");
const { enterpriseProviderMocks } = require("../lib/enterpriseProviderFixture");

const translator = `export const useTranslation = () => ({t: (key) => globalThis.__feedbackLocale + ":" + key});`;

test("retained Bedrock catalogs invalidate on shared effective configuration and reject superseded/rejected/unmounted reads", async (t) => {
  const { dom, container, render } = await mountAuditDom(t);
  const reads = [];
  globalThis.__feedbackLocale = "en";
  globalThis.__bedrockOwned = { leaves: [] };
  t.after(() => {
    delete globalThis.__bedrockOwned;
    delete globalThis.__feedbackLocale;
  });
  dom.electronAPI = {
    listBedrockModels: (config) => {
      const request = { ...deferred(), config };
      reads.push(request);
      return request.promise;
    },
  };
  const vite = await createRendererServer(t, {
    noExternal: ["react-i18next"],
    mockModules: {
      "react-i18next": translator,
      ...enterpriseProviderMocks("__bedrockOwned.store"),
      "/stores/policyStore": `import {create} from "zustand"; export const usePolicyStore=create(()=>({accountId:"fake-account",authGeneration:1})); globalThis.__bedrockOwned.policy=usePolicyStore;`,
      "/TestConnectionButton": `export default ()=>null;`,
      "/ui/SearchableModelList": `import React,{useState} from "react"; export default function List({models}){const [draft,setDraft]=useState(""); globalThis.__bedrockOwned.leaves.push({models,draft,setDraft}); return React.createElement("span",null,models.map(m=>m.label).join(" "));}`,
    },
  });
  const { default: Enterprise } = await vite.ssrLoadModule(
    "/components/EnterpriseProviderConfig.tsx"
  );
  const draw = (allowed = true) =>
    render(
      allowed
        ? React.createElement(
            "div",
            { hidden: true },
            React.createElement(Enterprise, {
              provider: "bedrock",
              reasoningModel: "us.model",
              setReasoningModel() {},
            })
          )
        : null
    );
  await draw();
  const browse = () =>
    React.act(async () =>
      [...container.querySelectorAll("button")]
        .find((b) => /browseModels|retry/.test(b.textContent))
        .click()
    );
  const change = (patch) => React.act(async () => globalThis.__bedrockOwned.store.setState(patch));
  const finish = (index, label) =>
    React.act(async () =>
      reads[index].resolve({ success: true, models: [{ value: label, label }] })
    );
  await browse();
  await change({ bedrockRegion: "eu-west-1" });
  assert.equal(reads.length, 1, "shared replacement does not automatically call a provider");
  await browse();
  await finish(0, "obsolete-us");
  assert.doesNotMatch(container.textContent, /obsolete-us/);
  await finish(1, "current-eu");
  assert.match(container.textContent, /current-eu/);
  const leaf = () => globalThis.__bedrockOwned.leaves.at(-1);
  await React.act(async () => leaf().setDraft("retained query"));
  for (const patch of [
    { bedrockSecretAccessKey: "fake-new" },
    { bedrockAuthMode: "sso" },
    { bedrockProfile: "other" },
    { bedrockRegion: "us-east-1" },
  ]) {
    await change(patch);
    assert.equal(leaf().draft, "retained query");
    assert.deepEqual(leaf().models, []);
    await browse();
    await finish(reads.length - 1, "fresh");
  }
  assert.equal(reads.at(-1).config.bedrockSecretAccessKey, "");
  assert.equal(reads.at(-1).config.bedrockProfile, "other");
  await change({ bedrockProfile: "transient" });
  await change({ bedrockProfile: "other" });
  assert.deepEqual(leaf().models, [], "ABA cannot resurrect an old loaded catalog");
  await browse();
  await finish(reads.length - 1, "current-again");
  await React.act(async () =>
    globalThis.__bedrockOwned.policy.setState({ accountId: "replacement", authGeneration: 2 })
  );
  await browse();
  await React.act(async () => reads.at(-1).reject(new Error("fake native rejection")));
  assert.match(container.textContent, /modelListError/);
  await browse();
  const pending = reads.at(-1);
  await draw(false);
  await React.act(async () =>
    pending.resolve({ success: true, models: [{ value: "removed", label: "removed" }] })
  );
  await draw();
  assert.doesNotMatch(container.textContent, /removed|fresh/);
});

test("connection feedback follows tested configuration/auth, not callback identity, with locale-reactive failures and owned timers", async (t) => {
  const { dom, container, render } = await mountAuditDom(t);
  globalThis.__feedbackLocale = "en";
  t.after(() => delete globalThis.__feedbackLocale);
  const requests = [];
  const timers = new Map();
  const callbacks = [];
  let nextTimer = 0;
  const realTimeout = globalThis.setTimeout;
  const realClearTimeout = globalThis.clearTimeout;
  t.mock.method(globalThis, "setTimeout", (callback, delay, ...args) => {
    if (delay !== 8000) return realTimeout(callback, delay, ...args);
    callbacks.push(callback);
    const id = ++nextTimer;
    timers.set(id, callback);
    return id;
  });
  t.mock.method(globalThis, "clearTimeout", (id) => {
    if (!timers.delete(id)) realClearTimeout(id);
  });
  const expire = () =>
    React.act(async () => {
      const [id, callback] = [...timers].at(-1);
      timers.delete(id);
      callback();
    });
  dom.electronAPI = {
    testEnterpriseConnection: (provider, config) => {
      const request = { ...deferred(), provider, config };
      requests.push(request);
      return request.promise;
    },
  };
  const vite = await createRendererServer(t, {
    noExternal: ["react-i18next"],
    mockModules: { "react-i18next": translator },
  });
  const { default: TestConnection } = await vite.ssrLoadModule(
    "/components/TestConnectionButton.tsx"
  );
  const auth = await vite.ssrLoadModule("/lib/authRequestContext.ts");
  let configuration = { model: "one", apiKey: "fake-one" };
  let provider = "azure";
  const draw = () =>
    render(
      React.createElement(
        "div",
        { hidden: true },
        React.createElement(TestConnection, {
          provider,
          configurationKey: JSON.stringify(configuration),
          getConfig: () => ({ ...configuration }),
        })
      )
    );
  const click = () => React.act(async () => container.querySelector("button").click());
  const finish = (index, result) => React.act(async () => requests[index].resolve(result));
  await draw();
  await click();
  configuration = { model: "two", apiKey: "fake-two" };
  await draw();
  assert.equal(container.querySelector("button").disabled, false);
  await click();
  await finish(0, { success: true });
  assert.doesNotMatch(container.textContent, /testSuccess/);
  await finish(1, { success: true });
  assert.match(container.textContent, /testSuccess/);
  assert.equal(timers.size, 1, "success owns a pending nonzero reset timer");
  await draw();
  assert.equal(timers.size, 1, "callback identity replacement retains the timer");
  assert.match(
    container.textContent,
    /testSuccess/,
    "fresh factory identity does not clear feedback"
  );
  await React.act(async () => auth.observeAuthTokenStateEvent({ generation: 99, hasToken: true }));
  assert.doesNotMatch(container.textContent, /testSuccess/);
  assert.equal(timers.size, 0, "auth replacement cancels its pending timer");
  await React.act(async () => callbacks[0]());
  await click();
  configuration = {
    model: "two",
    managedContext: { accountId: "fake", workspaceId: "w", generation: 1, providerVersion: 1 },
  };
  provider = "bedrock";
  await draw();
  await click();
  await finish(2, { success: false, error: "obsolete" });
  assert.doesNotMatch(container.textContent, /obsolete/);
  await React.act(async () => requests[3].reject(new Error("fake rejection")));
  assert.match(container.textContent, /en:reasoning.enterprise.testFailed/);
  globalThis.__feedbackLocale = "fr";
  await draw();
  assert.match(container.textContent, /fr:reasoning.enterprise.testFailed/);
  configuration = {
    ...configuration,
    managedContext: { ...configuration.managedContext, generation: 2 },
  };
  await draw();
  assert.doesNotMatch(container.textContent, /testFailed/);
  await click();
  await finish(4, { success: true });
  await expire();
  assert.equal(timers.size, 0);
  assert.doesNotMatch(container.textContent, /testSuccess/);
  await click();
  await render(null);
  await finish(5, { success: true });
  provider = "azure";
  configuration = { model: "A", apiKey: "fake-ABA" };
  await draw();
  await click();
  configuration = { model: "B", apiKey: "fake-ABA" };
  await draw();
  configuration = { model: "A", apiKey: "fake-ABA" };
  await draw();
  await finish(6, { success: true });
  assert.doesNotMatch(
    container.textContent,
    /testSuccess/,
    "ABA cannot resurrect obsolete feedback"
  );
  await click();
  await finish(7, { success: true });
  assert.equal(timers.size, 1);
  await click();
  assert.equal(timers.size, 0, "retest cancels the previous feedback timer");
  await finish(8, { success: true });
  assert.equal(timers.size, 1);
  await render(null);
  assert.equal(timers.size, 0, "unmount cancels a pending successful feedback timer");
});
