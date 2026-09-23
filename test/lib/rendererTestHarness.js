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

// installHookDom plus host elements, for mounting components that render real
// markup (divs, buttons, text) — e.g. a whole view that must unmount and
// remount. Still no layout and no events: React DOM only needs a node tree it
// can insert into, update and remove from. Returns the root container.
function installHostDom(t) {
  installHookDom(t);
  const document = globalThis.document;
  const HTML_NS = "http://www.w3.org/1999/xhtml";
  const createStyle = () => {
    const style = {};
    Object.defineProperties(style, {
      setProperty: { value: (name, value) => (style[name] = value) },
      removeProperty: { value: (name) => delete style[name] },
    });
    return style;
  };

  class HostNode {
    constructor(nodeType, name, namespaceURI = null) {
      this.nodeType = nodeType;
      this.nodeName = name.toUpperCase();
      this.tagName = this.nodeName;
      this.localName = name.toLowerCase();
      this.namespaceURI = namespaceURI;
      this.ownerDocument = document;
      this.childNodes = [];
      this.parentNode = null;
      this.attributes = {};
      this.style = createStyle();
      this.nodeValue = null;
    }

    get firstChild() {
      return this.childNodes[0] ?? null;
    }

    get lastChild() {
      return this.childNodes.at(-1) ?? null;
    }

    get nextSibling() {
      if (!this.parentNode) return null;
      const siblings = this.parentNode.childNodes;
      return siblings[siblings.indexOf(this) + 1] ?? null;
    }

    appendChild(child) {
      return this.insertBefore(child, null);
    }

    insertBefore(child, before) {
      child.parentNode?.removeChild(child);
      const index = before ? this.childNodes.indexOf(before) : -1;
      if (index < 0) this.childNodes.push(child);
      else this.childNodes.splice(index, 0, child);
      child.parentNode = this;
      return child;
    }

    removeChild(child) {
      const index = this.childNodes.indexOf(child);
      if (index >= 0) this.childNodes.splice(index, 1);
      child.parentNode = null;
      return child;
    }

    setAttribute(name, value) {
      this.attributes[name] = String(value);
    }

    removeAttribute(name) {
      delete this.attributes[name];
    }

    getAttribute(name) {
      return this.attributes[name] ?? null;
    }

    hasAttribute(name) {
      return name in this.attributes;
    }

    addEventListener() {}
    removeEventListener() {}
    focus() {}
    blur() {}

    get textContent() {
      if (this.nodeType === 3) return this.nodeValue;
      return this.childNodes.map((child) => child.textContent).join("");
    }

    set textContent(value) {
      for (const child of this.childNodes) child.parentNode = null;
      this.childNodes = [];
      if (value !== "" && value != null) this.appendChild(document.createTextNode(value));
    }
  }

  document.createElement = (tagName) => new HostNode(1, tagName, HTML_NS);
  document.createElementNS = (namespaceURI, tagName) => new HostNode(1, tagName, namespaceURI);
  document.createTextNode = (text) => {
    const node = new HostNode(3, "#text");
    node.nodeValue = String(text);
    return node;
  };
  document.body = document.createElement("body");
  const container = document.createElement("div");
  document.documentElement = container;
  return container;
}

// mockModules maps an import-path suffix (e.g. "/utils/logger") to the ESM
// source served in its place.
async function createRendererServer(
  t,
  {
    cachePrefix = "openwhispr-renderer-test-",
    mockModules = {},
    noExternal = false,
    resolveAlias = {},
  } = {}
) {
  const { createServer } = await import("vite");
  const cacheDir = fs.mkdtempSync(path.join(os.tmpdir(), cachePrefix));
  const suffixes = Object.keys(mockModules);
  const vite = await createServer({
    root: path.resolve(__dirname, "../../src"),
    cacheDir,
    configFile: false,
    resolve: { alias: resolveAlias },
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
  installHostDom,
  installMicCaptureGlobals,
};
