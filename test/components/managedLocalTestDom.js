function installManagedLocalTestDom(t) {
  const globalKeys = ["document", "Node", "Element", "HTMLElement", "HTMLIFrameElement"];
  const originals = Object.fromEntries(globalKeys.map((key) => [key, globalThis[key]]));
  const originalAct = globalThis.IS_REACT_ACT_ENVIRONMENT;

  class TestNode {
    constructor(type, name, ownerDocument) {
      Object.assign(this, { nodeType: type, nodeName: name, ownerDocument,
        parentNode: null, childNodes: [] });
    }
    insertBefore(child, before) {
      if (child.parentNode) child.parentNode.removeChild(child);
      const found = before ? this.childNodes.indexOf(before) : this.childNodes.length;
      this.childNodes.splice(found < 0 ? this.childNodes.length : found, 0, child);
      child.parentNode = this;
      return child;
    }
    appendChild(child) { return this.insertBefore(child, null); }
    removeChild(child) {
      this.childNodes.splice(this.childNodes.indexOf(child), 1);
      child.parentNode = null;
      return child;
    }
    contains(child) {
      for (let current = child; current; current = current.parentNode)
        if (current === this) return true;
      return false;
    }
    get firstChild() { return this.childNodes[0] ?? null; }
    get nextSibling() {
      const index = this.parentNode?.childNodes.indexOf(this) ?? -1;
      return this.parentNode?.childNodes[index + 1] ?? null;
    }
    get textContent() { return this.childNodes.map((child) => child.textContent).join(""); }
    set textContent(value) {
      this.childNodes = [];
      if (value) this.appendChild(this.ownerDocument.createTextNode(value));
    }
  }
  class Element extends TestNode {}
  class HTMLElement extends Element {}
  class HTMLIFrameElement extends HTMLElement {}
  class TextNode extends TestNode {
    constructor(value, ownerDocument) {
      super(3, "#text", ownerDocument);
      this.nodeValue = value;
    }
    get textContent() { return this.nodeValue; }
    set textContent(value) { this.nodeValue = String(value); }
  }
  class HtmlElement extends HTMLElement {
    constructor(tag, ownerDocument, namespaceURI = "http://www.w3.org/1999/xhtml") {
      super(1, tag.toUpperCase(), ownerDocument);
      Object.assign(this, { tagName: tag.toUpperCase(), namespaceURI,
        attributes: new Map(), listeners: new Map() });
      this.style = { setProperty: (key, value) => (this.style[key] = value) };
    }
    get options() { return this.childNodes; }
    setAttribute(key, value) { this.attributes.set(key, String(value)); }
    getAttribute(key) { return this.attributes.get(key) ?? null; }
    removeAttribute(key) { this.attributes.delete(key); }
    addEventListener(type, listener) {
      const listeners = this.listeners.get(type) ?? new Set();
      listeners.add(listener);
      this.listeners.set(type, listeners);
    }
    removeEventListener(type, listener) { this.listeners.get(type)?.delete(listener); }
    dispatchEvent(event) {
      if (!event.target) event.target = this;
      for (let current = this; current; current = event.bubbles ? current.parentNode : null)
        for (const listener of current.listeners?.get(event.type) ?? []) listener(event);
      return true;
    }
  }
  const document = {
    nodeType: 9,
    activeElement: null,
    createElement: (tag) => new HtmlElement(tag, document),
    createElementNS: (namespace, tag) => new HtmlElement(tag, document, namespace),
    createTextNode: (value) => new TextNode(String(value), document),
    createComment: (value) => Object.assign(new TestNode(8, "#comment", document), { nodeValue: value }),
    addEventListener() {},
    removeEventListener() {},
  };
  const windowListeners = new Map();
  Object.assign(globalThis.window, {
    Node: TestNode,
    Element,
    HTMLElement,
    HTMLIFrameElement,
    document,
    getSelection: () => null,
    addEventListener(type, listener) {
      const listeners = windowListeners.get(type) ?? new Set();
      listeners.add(listener);
      windowListeners.set(type, listeners);
    },
    removeEventListener: (type, listener) => windowListeners.get(type)?.delete(listener),
    dispatchEvent: (event) => {
      for (const listener of windowListeners.get(event.type) ?? []) listener(event);
      return true;
    },
  });
  const createContainer = () => new HtmlElement("div", document);
  const container = createContainer();
  Object.assign(document, { documentElement: container, body: container, defaultView: globalThis.window });
  Object.assign(globalThis, { document, Node: TestNode, Element, HTMLElement, HTMLIFrameElement,
    IS_REACT_ACT_ENVIRONMENT: true });
  t.after(() => {
    for (const key of globalKeys) {
      if (originals[key] === undefined) delete globalThis[key];
      else globalThis[key] = originals[key];
    }
    if (originalAct === undefined) delete globalThis.IS_REACT_ACT_ENVIRONMENT;
    else globalThis.IS_REACT_ACT_ENVIRONMENT = originalAct;
  });
  return { container, createContainer };
}
function findElements(root, predicate, matches = []) {
  if (root.nodeType === 1 && predicate(root)) matches.push(root);
  for (const child of root.childNodes ?? []) findElements(child, predicate, matches);
  return matches;
}
function click(element) {
  element.dispatchEvent({
    type: "click",
    bubbles: true,
    button: 0,
    defaultPrevented: false,
    preventDefault() { this.defaultPrevented = true; },
  });
}
module.exports = { click, findElements, installManagedLocalTestDom };
