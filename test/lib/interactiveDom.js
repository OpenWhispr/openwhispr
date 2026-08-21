function installInteractiveDom(t) {
  const originalDocument = globalThis.document;
  const originalNode = globalThis.Node;
  const originalElement = globalThis.Element;
  const originalHTMLElement = globalThis.HTMLElement;
  const originalHTMLIFrameElement = globalThis.HTMLIFrameElement;
  const originalActEnvironment = globalThis.IS_REACT_ACT_ENVIRONMENT;

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
    getSelection: () => null,
  });
  globalThis.Node = FakeNode;
  globalThis.Element = Element;
  globalThis.HTMLElement = HTMLElement;
  globalThis.HTMLIFrameElement = HTMLIFrameElement;
  globalThis.document = document;
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;

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
  });

  return container;
}

function findElement(root, predicate) {
  if (root.nodeType === 1 && predicate(root)) return root;
  for (const child of root.childNodes ?? []) {
    const match = findElement(child, predicate);
    if (match) return match;
  }
  return null;
}

function click(element) {
  element.dispatchEvent({
    type: "click",
    bubbles: true,
    button: 0,
    defaultPrevented: false,
    cancelBubble: false,
    preventDefault() {
      this.defaultPrevented = true;
    },
    stopPropagation() {
      this.cancelBubble = true;
    },
  });
}

module.exports = { click, findElement, installInteractiveDom };
