const test = require("node:test");
const assert = require("node:assert/strict");
const React = require("react");
const { createRendererServer } = require("../lib/rendererTestHarness");
const { mountAuditDom, deferred } = require("../lib/settingsAuditHarness");

async function setup(t) {
  const mounted = await mountAuditDom(t);
  const seen = (globalThis.__developerKey = {
    reads: [],
    creates: [],
    revokes: [],
    copies: [],
    toasts: [],
    timers: [],
  });
  t.after(() => delete globalThis.__developerKey);
  const begin = (list, args) => {
    const request = { ...deferred(), args };
    list.push(request);
    return request.promise;
  };
  seen.list = (...args) => begin(seen.reads, args);
  seen.create = (...args) => begin(seen.creates, args);
  seen.revoke = (...args) => begin(seen.revokes, args);
  t.mock.method(mounted.dom.navigator.clipboard, "writeText", (text) => begin(seen.copies, [text]));
  const timeout = globalThis.setTimeout,
    clear = globalThis.clearTimeout;
  t.mock.method(globalThis, "setTimeout", (fn, delay, ...args) => {
    if (delay !== 2000) return timeout(fn, delay, ...args);
    const timer = { fn, cancelled: false };
    seen.timers.push(timer);
    return timer;
  });
  t.mock.method(globalThis, "clearTimeout", (timer) => {
    if (seen.timers.includes(timer)) timer.cancelled = true;
    else clear(timer);
  });
  const vite = await createRendererServer(t, {
    noExternal: ["react-i18next", "@radix-ui/react-dialog"],
    mockModules: {
      "react-i18next": `const t=(key,opts)=>key+(opts?JSON.stringify(opts):"");export const useTranslation=()=>({t});`,
      "/ui/useToast": `export const useToast=()=>({toast:p=>globalThis.__developerKey.toasts.push(p)});`,
      "/services/WorkspaceApiKeysService": `export const WorkspaceApiKeysService={list:(...a)=>globalThis.__developerKey.list(...a),create:(...a)=>globalThis.__developerKey.create(...a),revoke:(...a)=>globalThis.__developerKey.revoke(...a)};`,
    },
  });
  const { default: Developer } = await vite.ssrLoadModule(
    "/components/settings/WorkspaceDeveloperTab.tsx"
  );
  const auth = await vite.ssrLoadModule("/lib/authRequestContext.ts");
  const workspace = (id = "A", role = "owner") => ({ id, name: id, role });
  const renderOwner = (id, role) =>
    mounted.render(
      React.createElement(
        React.StrictMode,
        null,
        React.createElement(Developer, { workspace: workspace(id, role) })
      )
    );
  await renderOwner("A", "owner");
  await React.act(async () => seen.reads.at(-1).resolve([]));
  const button = (text) =>
    [...mounted.dom.document.querySelectorAll("button")].find((b) => b.textContent.trim() === text);
  const click = (text) =>
    React.act(async () => {
      assert.ok(button(text), text);
      button(text).click();
    });
  const prepare = async (label) => {
    await click("settingsPage.workspace.developer.new");
    await React.act(async () => {
      const input = mounted.dom.document.querySelector("#key-name");
      input[Object.keys(input).find((k) => k.startsWith("__reactProps$"))].onChange({
        target: { value: label },
      });
    });
    await click("settingsPage.workspace.developer.scopes.notes.read");
    await React.act(async () =>
      mounted.dom.document
        .querySelector("form")
        .dispatchEvent(new mounted.dom.Event("submit", { bubbles: true, cancelable: true }))
    );
  };
  const fakeKey = (label) => ({
    id: label,
    name: label,
    key: `fake-test-only-${label}`,
    key_prefix: "fake",
    scopes: ["workspace:notes:read"],
  });
  const create = async (label) => {
    await prepare(label);
    await React.act(async () => seen.creates.at(-1).resolve(fakeKey(label)));
    await React.act(async () => seen.reads.at(-1).resolve([]));
    assert.ok(button("common.copy"), mounted.dom.document.body.textContent);
  };
  const escape = () =>
    React.act(async () =>
      mounted.dom.document.dispatchEvent(
        new mounted.dom.KeyboardEvent("keydown", { key: "Escape", bubbles: true })
      )
    );
  const copied = () => Boolean(button("common.copied"));
  return {
    ...mounted,
    seen,
    auth,
    renderOwner,
    button,
    click,
    prepare,
    create,
    fakeKey,
    escape,
    copied,
  };
}

test("real one-time key copy feedback follows its secret and latest operation through Done, failure and timers", async (t) => {
  const { seen, dom, click, create, copied, button } = await setup(t);
  await create("A");
  await click("common.copy");
  await React.act(async () => seen.copies.at(-1).resolve());
  assert.equal(copied(), true);
  const timerA = seen.timers.at(-1);
  await click("common.done");
  assert.equal(timerA.cancelled, true);
  await create("B");
  assert.equal(copied(), false);
  await React.act(async () => timerA.fn());
  assert.ok(button("common.copy"));
  await click("common.copy");
  const old = seen.copies.at(-1);
  await click("common.copy");
  const latest = seen.copies.at(-1);
  await React.act(async () => latest.resolve());
  assert.equal(copied(), true);
  const latestTimer = seen.timers.at(-1);
  await React.act(async () => old.resolve());
  assert.equal(seen.timers.at(-1), latestTimer);
  await click("common.copied");
  assert.equal(latestTimer.cancelled, true);
  assert.equal(copied(), false);
  await React.act(async () => latestTimer.fn());
  assert.equal(copied(), false);
  await React.act(async () => seen.copies.at(-1).resolve());
  assert.equal(copied(), true);
  await React.act(async () => seen.timers.at(-1).fn());
  assert.equal(copied(), false);
  await click("common.copy");
  await React.act(async () => seen.copies.at(-1).reject(new Error("fake clipboard denial")));
  assert.equal(copied(), false);
  assert.ok(
    dom.document.body.textContent.includes("fake-test-only-B"),
    "manual selection text survives denial"
  );
  assert.equal(localStorage.length, 0, "one-time keys are never persisted");
});

test("late copy success cannot mark a replacement key after pending Done; Escape and X close the secret", async (t) => {
  const { seen, click, create, copied, escape, button } = await setup(t);
  await create("old-done");
  await click("common.copy");
  const pending = seen.copies.at(-1);
  await click("common.done");
  assert.equal(button("common.copy"), undefined);
  await create("new-done");
  await React.act(async () => pending.resolve());
  assert.equal(copied(), false);
  await click("common.done");

  for (const dismissal of ["escape", "x"]) {
    await create(dismissal);
    if (dismissal === "escape") await escape();
    else await click("common.close");
    assert.equal(button("common.copy"), undefined);
  }
});

test("developer owner replacement and unmount fence copy/create/revoke/list completions", async (t) => {
  const { seen, dom, renderOwner, render, create, prepare, click, copied, fakeKey } =
    await setup(t);
  for (const replace of [
    () => renderOwner("B", "owner"),
    () => renderOwner("B", "admin"),
  ]) {
    await create("current");
    await click("common.copy");
    const pending = seen.copies.at(-1);
    await replace();
    await React.act(async () => pending.resolve());
    assert.equal(copied(), false);
    assert.equal(dom.document.body.textContent.includes("fake-test-only-current"), false);
    await React.act(async () => seen.reads.at(-1).resolve([]));
  }
  await prepare("pending-create");
  const pendingCreate = seen.creates.at(-1);
  await renderOwner("C", "owner");
  const newRead = seen.reads.at(-1);
  await React.act(async () => pendingCreate.resolve(fakeKey("obsolete-create")));
  assert.equal(dom.document.body.textContent.includes("fake-test-only-obsolete-create"), false);
  await React.act(async () => newRead.resolve([fakeKey("current-row")]));
  await React.act(async () =>
    dom.document
      .querySelector('button[aria-label="settingsPage.workspace.developer.revoke"]')
      .click()
  );
  const confirm = [...dom.document.querySelectorAll("button")].find(
    (b) => b.textContent === "settingsPage.workspace.developer.revoke"
  );
  assert.ok(confirm);
  await React.act(async () => confirm.click());
  const pendingRevoke = seen.revokes.at(-1);
  await renderOwner("D", "owner");
  const readCount = seen.reads.length,
    toastCount = seen.toasts.length;
  await React.act(async () => pendingRevoke.resolve());
  assert.equal(seen.reads.length, readCount);
  assert.equal(seen.toasts.length, toastCount);
  await renderOwner("E", "owner");
  await React.act(async () => seen.reads.at(-1).resolve([fakeKey("readback-row")]));
  await React.act(async () =>
    dom.document
      .querySelector('button[aria-label="settingsPage.workspace.developer.revoke"]')
      .click()
  );
  await click("settingsPage.workspace.developer.revoke");
  await React.act(async () => seen.revokes.at(-1).resolve());
  const readback = seen.reads.at(-1),
    beforeReadbackToasts = seen.toasts.length;
  await renderOwner("F", "owner");
  await React.act(async () => readback.resolve([]));
  assert.equal(
    seen.toasts.length,
    beforeReadbackToasts,
    "revocation feedback must expire during read-back too"
  );
  await create("unmount");
  await click("common.copy");
  const detached = seen.copies.at(-1);
  await render(null);
  await React.act(async () => detached.resolve());
  assert.equal(copied(), false);
  assert.equal(localStorage.length, 0);
});
