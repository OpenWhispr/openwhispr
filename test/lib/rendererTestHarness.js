// Shared setup for tests that load renderer modules through Vite SSR:
// Map-backed browser globals plus a dev server with per-test module mocks.
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

function installBrowserGlobals(t, { initialStorage = {}, window: windowProps = {} } = {}) {
  const originalWindow = globalThis.window;
  const originalLocalStorage = globalThis.localStorage;
  const values = new Map(Object.entries(initialStorage));
  const storage = {
    getItem: (key) => (values.has(key) ? values.get(key) : null),
    setItem: (key, value) => values.set(key, String(value)),
    removeItem: (key) => values.delete(key),
    clear: () => values.clear(),
  };
  globalThis.localStorage = storage;
  globalThis.window = {
    innerWidth: 1200,
    localStorage: storage,
    addEventListener() {},
    removeEventListener() {},
    setInterval() {
      return 1;
    },
    electronAPI: {},
    ...windowProps,
  };
  t.after(() => {
    if (originalWindow === undefined) delete globalThis.window;
    else globalThis.window = originalWindow;
    if (originalLocalStorage === undefined) delete globalThis.localStorage;
    else globalThis.localStorage = originalLocalStorage;
  });
  return { window: globalThis.window, storage };
}

// Minimal fake DOM for mounting hook harnesses with react-dom's createRoot:
// just enough node structure for React to attach a root — no layout, no real
// events. Call installBrowserGlobals first; this assigns onto globalThis.window.
function installHookDom(t) {
  const originalDocument = globalThis.document;
  const originalActEnvironment = globalThis.IS_REACT_ACT_ENVIRONMENT;
  const originalRequestAnimationFrame = globalThis.requestAnimationFrame;
  const originalCancelAnimationFrame = globalThis.cancelAnimationFrame;
  const noop = () => {};

  class Element {}
  class HTMLElement extends Element {}
  class HTMLIFrameElement extends HTMLElement {}

  const document = {
    nodeType: 9,
    activeElement: null,
    addEventListener: noop,
    removeEventListener: noop,
  };
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
  Object.assign(globalThis.window, {
    Element,
    HTMLElement,
    HTMLIFrameElement,
    document,
    getSelection: () => null,
  });
  document.defaultView = globalThis.window;
  document.documentElement = container;
  globalThis.document = document;
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  globalThis.requestAnimationFrame = () => 1;
  globalThis.cancelAnimationFrame = noop;

  t.after(() => {
    if (originalDocument === undefined) delete globalThis.document;
    else globalThis.document = originalDocument;
    if (originalActEnvironment === undefined) delete globalThis.IS_REACT_ACT_ENVIRONMENT;
    else globalThis.IS_REACT_ACT_ENVIRONMENT = originalActEnvironment;
    if (originalRequestAnimationFrame === undefined) delete globalThis.requestAnimationFrame;
    else globalThis.requestAnimationFrame = originalRequestAnimationFrame;
    if (originalCancelAnimationFrame === undefined) delete globalThis.cancelAnimationFrame;
    else globalThis.cancelAnimationFrame = originalCancelAnimationFrame;
  });

  return container;
}

// Minimal but faithful fake DOM for mounting FULL component trees with
// react-dom's createRoot (not just hook harnesses — real interactive
// elements, attributes, styles, and event dispatch). Call
// installBrowserGlobals first; this assigns onto globalThis.window and
// globalThis.document. Extracted here (fix round 1, finding 4) after a
// byte-identical copy of this function existed in two test files —
// test/helpers/assistantPanel.test.js was the first, and
// test/components/streamingReplySettled.test.js the second; both now
// import it from here instead of carrying their own copy.
function installInteractiveDom(t) {
  const noop = () => {};
  const originalDocument = globalThis.document;
  const originalNode = globalThis.Node;
  const originalElement = globalThis.Element;
  const originalHTMLElement = globalThis.HTMLElement;
  const originalHTMLIFrameElement = globalThis.HTMLIFrameElement;
  const originalActEnvironment = globalThis.IS_REACT_ACT_ENVIRONMENT;
  const originalRequestAnimationFrame = globalThis.requestAnimationFrame;
  const originalCancelAnimationFrame = globalThis.cancelAnimationFrame;

  class FakeNode {
    constructor(nodeType, nodeName, ownerDocument) {
      this.nodeType = nodeType;
      this.nodeName = nodeName;
      this.ownerDocument = ownerDocument;
      this.parentNode = null;
      this.childNodes = [];
    }

    appendChild(child) {
      return this.insertBefore(child, null);
    }

    insertBefore(child, before) {
      if (child.parentNode) child.parentNode.removeChild(child);
      const index = before === null ? this.childNodes.length : this.childNodes.indexOf(before);
      this.childNodes.splice(index < 0 ? this.childNodes.length : index, 0, child);
      child.parentNode = this;
      return child;
    }

    removeChild(child) {
      const index = this.childNodes.indexOf(child);
      if (index >= 0) this.childNodes.splice(index, 1);
      child.parentNode = null;
      return child;
    }

    contains(candidate) {
      for (let current = candidate; current; current = current.parentNode) {
        if (current === this) return true;
      }
      return false;
    }

    get firstChild() {
      return this.childNodes[0] ?? null;
    }

    get lastChild() {
      return this.childNodes.at(-1) ?? null;
    }

    get nextSibling() {
      if (!this.parentNode) return null;
      const index = this.parentNode.childNodes.indexOf(this);
      return this.parentNode.childNodes[index + 1] ?? null;
    }

    get textContent() {
      return this.childNodes.map((child) => child.textContent).join("");
    }

    set textContent(value) {
      for (const child of this.childNodes) child.parentNode = null;
      this.childNodes = [];
      if (value !== "") this.appendChild(this.ownerDocument.createTextNode(String(value)));
    }
  }

  class Element extends FakeNode {}
  class HTMLElement extends Element {}
  class HTMLIFrameElement extends HTMLElement {}

  class FakeText extends FakeNode {
    constructor(value, ownerDocument) {
      super(3, "#text", ownerDocument);
      this.nodeValue = value;
    }

    get textContent() {
      return this.nodeValue;
    }

    set textContent(value) {
      this.nodeValue = String(value);
    }
  }

  class FakeElement extends HTMLElement {
    constructor(tagName, ownerDocument, namespaceURI = "http://www.w3.org/1999/xhtml") {
      super(1, tagName.toUpperCase(), ownerDocument);
      this.tagName = tagName.toUpperCase();
      this.namespaceURI = namespaceURI;
      this.attributes = new Map();
      this.listeners = new Map();
      this.style = {
        setProperty: (name, value) => {
          this.style[name] = value;
        },
        removeProperty: (name) => {
          delete this.style[name];
        },
      };
    }

    setAttribute(name, value) {
      this.attributes.set(name, String(value));
    }

    getAttribute(name) {
      return this.attributes.get(name) ?? null;
    }

    removeAttribute(name) {
      this.attributes.delete(name);
    }

    addEventListener(type, listener) {
      const listeners = this.listeners.get(type) ?? new Set();
      listeners.add(listener);
      this.listeners.set(type, listeners);
    }

    removeEventListener(type, listener) {
      this.listeners.get(type)?.delete(listener);
    }

    dispatchEvent(event) {
      if (!event.target) event.target = this;
      for (let current = this; current; current = event.bubbles ? current.parentNode : null) {
        event.currentTarget = current;
        for (const listener of current.listeners?.get(event.type) ?? []) listener(event);
        if (event.cancelBubble) break;
      }
      return !event.defaultPrevented;
    }

    focus() {
      this.ownerDocument.activeElement = this;
    }
  }

  const documentListeners = new Map();
  const document = {
    nodeType: 9,
    nodeName: "#document",
    activeElement: null,
    createElement: (tagName) => new FakeElement(tagName, document),
    createElementNS: (namespaceURI, tagName) => new FakeElement(tagName, document, namespaceURI),
    createTextNode: (value) => new FakeText(String(value), document),
    createComment: (value) => {
      const comment = new FakeNode(8, "#comment", document);
      comment.nodeValue = String(value);
      return comment;
    },
    addEventListener(type, listener) {
      const listeners = documentListeners.get(type) ?? new Set();
      listeners.add(listener);
      documentListeners.set(type, listeners);
    },
    removeEventListener(type, listener) {
      documentListeners.get(type)?.delete(listener);
    },
  };
  const container = new FakeElement("div", document);
  document.documentElement = container;
  document.body = container;
  document.defaultView = globalThis.window;
  Object.assign(globalThis.window, {
    Node: FakeNode,
    Element,
    HTMLElement,
    HTMLIFrameElement,
    document,
    getSelection: () => ({
      isCollapsed: true,
      rangeCount: 0,
      removeAllRanges() {},
    }),
  });
  globalThis.document = document;
  globalThis.Node = FakeNode;
  globalThis.Element = Element;
  globalThis.HTMLElement = HTMLElement;
  globalThis.HTMLIFrameElement = HTMLIFrameElement;
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  globalThis.requestAnimationFrame = (callback) => {
    callback();
    return 1;
  };
  globalThis.cancelAnimationFrame = noop;

  t.after(() => {
    if (originalDocument === undefined) delete globalThis.document;
    else globalThis.document = originalDocument;
    if (originalNode === undefined) delete globalThis.Node;
    else globalThis.Node = originalNode;
    if (originalElement === undefined) delete globalThis.Element;
    else globalThis.Element = originalElement;
    if (originalHTMLElement === undefined) delete globalThis.HTMLElement;
    else globalThis.HTMLElement = originalHTMLElement;
    if (originalHTMLIFrameElement === undefined) delete globalThis.HTMLIFrameElement;
    else globalThis.HTMLIFrameElement = originalHTMLIFrameElement;
    if (originalActEnvironment === undefined) delete globalThis.IS_REACT_ACT_ENVIRONMENT;
    else globalThis.IS_REACT_ACT_ENVIRONMENT = originalActEnvironment;
    if (originalRequestAnimationFrame === undefined) delete globalThis.requestAnimationFrame;
    else globalThis.requestAnimationFrame = originalRequestAnimationFrame;
    if (originalCancelAnimationFrame === undefined) delete globalThis.cancelAnimationFrame;
    else globalThis.cancelAnimationFrame = originalCancelAnimationFrame;
  });

  return container;
}

// Walks a fake-DOM tree (from installInteractiveDom) depth-first, returning
// the first element node matching `predicate`, or null.
function findElement(root, predicate) {
  if (root.nodeType === 1 && predicate(root)) return root;
  for (const child of root.childNodes) {
    const match = findElement(child, predicate);
    if (match) return match;
  }
  return null;
}

// Same walk as findElement, but collects every matching element node.
function findAllElements(root, predicate) {
  const found = [];
  const walk = (node) => {
    if (node.nodeType === 1 && predicate(node)) found.push(node);
    for (const child of node.childNodes) walk(child);
  };
  walk(root);
  return found;
}

// mockModules maps an import-path suffix (e.g. "/utils/logger") to the ESM
// source served in its place.
async function createRendererServer(
  t,
  { cachePrefix = "openwhispr-renderer-test-", mockModules = {}, noExternal = false } = {}
) {
  const { createServer } = await import("vite");
  const cacheDir = fs.mkdtempSync(path.join(os.tmpdir(), cachePrefix));
  const suffixes = Object.keys(mockModules);
  const vite = await createServer({
    root: path.resolve(__dirname, "../../src"),
    cacheDir,
    configFile: false,
    appType: "custom",
    logLevel: "silent",
    optimizeDeps: { noDiscovery: true },
    ssr: noExternal ? { noExternal } : undefined,
    plugins: [
      {
        name: "renderer-test-module-mocks",
        enforce: "pre",
        resolveId(source) {
          const suffix = suffixes.find((candidate) => source.endsWith(candidate));
          if (suffix) return `\0mock:${suffix}`;
          return null;
        },
        load(id) {
          if (!id.startsWith("\0mock:")) return null;
          return mockModules[id.slice("\0mock:".length)];
        },
      },
    ],
    server: { middlewareMode: true },
  });
  t.after(async () => {
    await vite.close();
    fs.rmSync(cacheDir, { recursive: true, force: true });
  });
  return vite;
}

// Minimal Web Audio + capture stubs so the mic pipeline can run under Node.
function installMicCaptureGlobals(t) {
  const track = {
    readyState: "live",
    label: "Fake Mic",
    stop() {},
    getSettings: () => ({}),
  };
  const stream = {
    getTracks: () => [track],
    getAudioTracks: () => [track],
    getVideoTracks: () => [],
  };
  const mediaDevices = {
    getUserMedia: async () => stream,
    enumerateDevices: async () => [],
    addEventListener() {},
    removeEventListener() {},
  };
  const node = () => ({
    connect() {},
    disconnect() {},
    gain: { value: 0 },
    fftSize: 0,
    smoothingTimeConstant: 0,
  });
  class FakeAudioContext {
    constructor() {
      this.state = "running";
      this.audioWorklet = { addModule: async () => {} };
      this.destination = {};
    }
    createMediaStreamSource() {
      return node();
    }
    createGain() {
      return node();
    }
    createAnalyser() {
      return node();
    }
    async resume() {}
    async close() {}
  }
  class FakeAudioWorkletNode {
    constructor() {
      this.port = { onmessage: null, postMessage() {} };
    }
    connect() {}
    disconnect() {}
  }

  const originalNavigator = Object.getOwnPropertyDescriptor(globalThis, "navigator");
  Object.defineProperty(globalThis, "navigator", {
    value: { mediaDevices },
    configurable: true,
    writable: true,
  });
  globalThis.AudioContext = FakeAudioContext;
  globalThis.AudioWorkletNode = FakeAudioWorkletNode;
  t.after(() => {
    if (originalNavigator) Object.defineProperty(globalThis, "navigator", originalNavigator);
    else delete globalThis.navigator;
    delete globalThis.AudioContext;
    delete globalThis.AudioWorkletNode;
  });
}

module.exports = {
  createRendererServer,
  installBrowserGlobals,
  installHookDom,
  installInteractiveDom,
  installMicCaptureGlobals,
  findElement,
  findAllElements,
};
