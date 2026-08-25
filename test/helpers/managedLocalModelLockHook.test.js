const test = require("node:test");
const assert = require("node:assert/strict");
const React = require("react");
const { createRoot } = require("react-dom/client");
const { createRendererServer, installBrowserGlobals } = require("../lib/rendererTestHarness");

function installHookDom(t) {
  const originalDocument = global.document;
  const originalActEnvironment = global.IS_REACT_ACT_ENVIRONMENT;
  const noop = () => {};
  class Element {}
  class HTMLElement extends Element {}
  class HTMLIFrameElement extends HTMLElement {}
  const document = { nodeType: 9, addEventListener: noop, removeEventListener: noop };
  const container = {
    nodeType: 1,
    nodeName: "DIV",
    tagName: "DIV",
    namespaceURI: "http://www.w3.org/1999/xhtml",
    ownerDocument: document,
    addEventListener: noop,
    removeEventListener: noop,
    appendChild: noop,
    removeChild: noop,
    insertBefore: noop,
  };
  Object.assign(global.window, { Element, HTMLElement, HTMLIFrameElement, document });
  document.defaultView = global.window;
  document.documentElement = container;
  global.document = document;
  global.IS_REACT_ACT_ENVIRONMENT = true;
  t.after(() => {
    if (originalDocument === undefined) delete global.document;
    else global.document = originalDocument;
    if (originalActEnvironment === undefined) delete global.IS_REACT_ACT_ENVIRONMENT;
    else global.IS_REACT_ACT_ENVIRONMENT = originalActEnvironment;
  });
  return container;
}

function createLockQueue() {
  let held = false;
  const queue = [];
  return {
    request: async (_name, callback) => {
      if (held) await new Promise((resolve) => queue.push(resolve));
      held = true;
      try {
        return await callback({ name: "managed-local" });
      } finally {
        held = false;
        queue.shift()?.();
      }
    },
  };
}

test("mounted managed local lock hook releases an ineligible owner for a queued successor", async (t) => {
  installBrowserGlobals(t);
  const originalNavigator = Object.getOwnPropertyDescriptor(global, "navigator");
  Object.defineProperty(global, "navigator", {
    value: { locks: createLockQueue() },
    configurable: true,
    writable: true,
  });
  t.after(() => {
    if (originalNavigator) Object.defineProperty(global, "navigator", originalNavigator);
    else delete global.navigator;
  });
  const container = installHookDom(t);
  const vite = await createRendererServer(t, {
    cachePrefix: "openwhispr-managed-local-lock-hook-test-",
  });
  const { useManagedLocalModelLock } = await vite.ssrLoadModule(
    "/hooks/useManagedLocalModelLock.ts"
  );
  const events = [];
  let firstEligible = true;
  let firstOwnsLock = false;
  let secondOwnsLock = false;
  const onError = () => {};
  const reconcileFirst = async () => events.push("first:reconcile");
  const reconcileSecond = async () => events.push("second:reconcile");

  function First() {
    firstOwnsLock = useManagedLocalModelLock(firstEligible, reconcileFirst, onError);
    return null;
  }
  function Second() {
    secondOwnsLock = useManagedLocalModelLock(true, reconcileSecond, onError);
    return null;
  }

  const root = createRoot(container);
  const render = async () => {
    await React.act(async () => {
      root.render(
        React.createElement(
          React.Fragment,
          null,
          React.createElement(First),
          React.createElement(Second)
        )
      );
    });
    await Promise.resolve();
    await Promise.resolve();
  };

  await render();
  assert.equal(firstOwnsLock, true);
  assert.equal(secondOwnsLock, false);
  assert.deepEqual(events, ["first:reconcile"]);

  firstEligible = false;
  await render();
  assert.equal(firstOwnsLock, false);
  assert.equal(secondOwnsLock, true);
  assert.deepEqual(events, ["first:reconcile", "second:reconcile"]);
  await React.act(async () => root.unmount());
});
