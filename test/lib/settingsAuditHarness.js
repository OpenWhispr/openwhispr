const React = require("react");
const { createRoot } = require("react-dom/client");
const { installBrowserGlobals } = require("./rendererTestHarness");

// happy-dom globals over installBrowserGlobals so audit mounts get real markup, events and selectors.
function installAuditDomGlobals(t, dom) {
  const bound = (name) => dom[name].bind(dom);
  installBrowserGlobals(t, {
    windowInstance: dom,
    globals: {
      document: dom.document,
      DocumentFragment: dom.DocumentFragment,
      navigator: dom.navigator,
      HTMLElement: dom.HTMLElement,
      HTMLInputElement: dom.HTMLInputElement,
      HTMLTextAreaElement: dom.HTMLTextAreaElement,
      HTMLButtonElement: dom.HTMLButtonElement,
      HTMLSelectElement: dom.HTMLSelectElement,
      Element: dom.Element,
      Node: dom.Node,
      NodeFilter: dom.NodeFilter,
      CustomEvent: dom.CustomEvent,
      Event: dom.Event,
      MutationObserver: dom.MutationObserver,
      ResizeObserver: dom.ResizeObserver,
      getComputedStyle: bound("getComputedStyle"),
      requestAnimationFrame: bound("requestAnimationFrame"),
      cancelAnimationFrame: bound("cancelAnimationFrame"),
      IS_REACT_ACT_ENVIRONMENT: true,
    },
  });
}

async function mountAuditDom(t) {
  const { Window } = await import("happy-dom");
  const dom = new Window();
  dom.electronAPI = {};
  installAuditDomGlobals(t, dom);
  const container = dom.document.createElement("div");
  dom.document.body.appendChild(container);
  const root = createRoot(container);
  t.after(async () => {
    // Re-apply the full global set: installBrowserGlobals' cleanup may run first and Radix's unmount
    // touches rAF/cAF/navigator and element classes, not just window/document.
    globalThis.window = dom;
    globalThis.document = dom.document;
    globalThis.navigator = dom.navigator;
    globalThis.requestAnimationFrame = dom.requestAnimationFrame.bind(dom);
    globalThis.cancelAnimationFrame = dom.cancelAnimationFrame.bind(dom);
    globalThis.HTMLElement = dom.HTMLElement;
    globalThis.HTMLInputElement = dom.HTMLInputElement;
    globalThis.HTMLTextAreaElement = dom.HTMLTextAreaElement;
    globalThis.HTMLButtonElement = dom.HTMLButtonElement;
    globalThis.HTMLSelectElement = dom.HTMLSelectElement;
    globalThis.Element = dom.Element;
    globalThis.Node = dom.Node;
    globalThis.NodeFilter = dom.NodeFilter;
    globalThis.CustomEvent = dom.CustomEvent;
    globalThis.Event = dom.Event;
    globalThis.MutationObserver = dom.MutationObserver;
    globalThis.ResizeObserver = dom.ResizeObserver;
    globalThis.getComputedStyle = dom.getComputedStyle.bind(dom);
    globalThis.DocumentFragment = dom.DocumentFragment;
    globalThis.IS_REACT_ACT_ENVIRONMENT = true;
    await React.act(async () => root.unmount());
    // Radix dispatches its unmount autofocus event from a zero-delay timer.
    await React.act(async () => new Promise((resolve) => setTimeout(resolve, 20)));
    await dom.happyDOM.close();
  });
  return { dom, container, root, render: (node) => React.act(async () => root.render(node)) };
}

function deferred() {
  let resolve, reject;
  const promise = new Promise((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}

module.exports = { mountAuditDom, deferred };
