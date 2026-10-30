// Shared setup for the Skills screens' tests: module mocks, events and a mount helper.
const React = require("react");
const { createRendererServer, installBrowserGlobals } = require("./rendererTestHarness");
const { installInteractiveDom } = require("./interactiveDom");

const SKILLS_MOCKS = {
  "react-i18next": `
    const t = (key, values) => (values ? key + JSON.stringify(values) : key);
    export const useTranslation = () => ({ t, i18n: { language: "en" } });
  `,
  // Radix's contract without its portal, items always shown: picking one focuses it and runs
  // onSelect while the open menu keeps focus inside, then the menu closes, calling the content's
  // onCloseAutoFocus, and focus goes back to the trigger unless that prevented it.
  "/ui/dropdown-menu": `
    import { createContext, createElement, useContext, useRef } from "react";
    const Menu = createContext(null);
    export function DropdownMenu({ children }) {
      const parts = useRef({ trigger: null, onCloseAutoFocus: null });
      return createElement(Menu.Provider, { value: parts.current }, children);
    }
    export function DropdownMenuTrigger({ children }) {
      const parts = useContext(Menu);
      return createElement("div", { ref: (node) => (parts.trigger = node) }, children);
    }
    export function DropdownMenuContent({ children, onCloseAutoFocus }) {
      useContext(Menu).onCloseAutoFocus = onCloseAutoFocus;
      return createElement("div", null, children);
    }
    export function DropdownMenuItem({ onSelect, children }) {
      const parts = useContext(Menu);
      const onClick = (event) => {
        const item = event.currentTarget;
        const page = item.ownerDocument;
        item.focus();
        Object.defineProperty(page, "activeElement", { configurable: true, get: () => item, set() {} });
        try {
          onSelect?.(event);
        } finally {
          Object.defineProperty(page, "activeElement", { configurable: true, writable: true, value: item });
        }
        const closing = { defaultPrevented: false, preventDefault() { this.defaultPrevented = true; } };
        parts.onCloseAutoFocus?.(closing);
        if (!closing.defaultPrevented) parts.trigger?.querySelector("button")?.focus();
      };
      return createElement("button", { type: "button", role: "menuitem", onClick }, children);
    }
    export const DropdownMenuSeparator = () => createElement("div", { role: "separator" });
  `,
  "/ui/useToast": `
    export const useToast = () => ({ toast: (props) => globalThis.__skillToasts.push(props) });
  `,
  // Radix's contract without its portal: opening calls onOpenAutoFocus, Escape calls
  // onEscapeKeyDown and closes unless that prevented it, and closing calls onCloseAutoFocus.
  "/ui/dialog": `
    import React from "react";
    const Close = React.createContext(() => {});
    export function Dialog({ open, onOpenChange, children }) {
      if (!open) return null;
      return React.createElement(Close.Provider, { value: () => onOpenChange(false) }, children);
    }
    export function DialogContent(props) {
      const { children, className, onEscapeKeyDown, onOpenAutoFocus, onCloseAutoFocus } = props;
      const close = React.useContext(Close);
      const onClose = React.useRef(onCloseAutoFocus);
      onClose.current = onCloseAutoFocus;
      React.useEffect(() => {
        onOpenAutoFocus?.({ preventDefault() {} });
        return () => onClose.current?.({ preventDefault() {} });
      }, []);
      const onKeyDown = (event) => {
        if (event.key !== "Escape") return;
        onEscapeKeyDown?.(event);
        if (!event.isDefaultPrevented()) close();
      };
      return React.createElement("div", { role: "dialog", className, onKeyDown }, children);
    }
    const Pass = ({ children, className, dir }) =>
      React.createElement("div", { className, dir }, children);
    export const DialogTitle = Pass;
    export const DialogDescription = Pass;
  `,
  // markdownRenderer.test.js covers the real renderer; this records which mode was asked for.
  "/ui/MarkdownRenderer": `
    import React from "react";
    export function MarkdownRenderer({ content, hideFrontmatter }) {
      return React.createElement(
        "div",
        { "data-markdown": hideFrontmatter ? "hide-frontmatter" : "as-is" },
        content
      );
    }
    export default MarkdownRenderer;
  `,
};

const skill = (name, overrides = {}) => ({
  name,
  displayName: name.replace(/-/g, " "),
  description: `${name} description`,
  enabled: true,
  valid: true,
  addedAt: "2026-10-20T09:00:00.000Z",
  updatedAt: "2026-10-20T09:00:00.000Z",
  lastUsedAt: null,
  ...overrides,
});

function dispatch(element, type, init = {}) {
  element.dispatchEvent({
    type,
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
    ...init,
  });
}

const click = (element) => React.act(async () => dispatch(element, "click"));
const pressEscape = (element) =>
  React.act(async () => dispatch(element, "keydown", { key: "Escape" }));

// React's change event reads the new value from the element, then an input event.
function typeInto(input, value) {
  return React.act(async () => {
    input.value = value;
    dispatch(input, "input");
  });
}

function findAll(root, predicate, found = []) {
  if (root.nodeType === 1 && predicate(root)) found.push(root);
  for (const child of root.childNodes) findAll(child, predicate, found);
  return found;
}

// Icons render whitespace text nodes, so labels are compared trimmed.
const label = (node) => node.textContent.trim();
const ariaLabel = (node) => node.getAttribute("aria-label") ?? "";
const settle = () => React.act(async () => new Promise((resolve) => setImmediate(resolve)));

/**
 * Mounts one Skills component with the store loaded and window.electronAPI faked.
 * `wrap` turns the loaded component into the element to render, for state-holding harnesses.
 */
async function mountSkillsComponent(
  t,
  { modulePath, exportName, props = {}, skills = [], api = {}, wrap, platform = "darwin" }
) {
  let root = null;
  t.after(async () => {
    if (root) await React.act(async () => root.unmount());
  });
  const toasts = [];
  globalThis.__skillToasts = toasts;
  t.after(() => delete globalThis.__skillToasts);
  installBrowserGlobals(t, {
    window: {
      electronAPI: {
        getPlatform: () => platform,
        skillsList: async () => ({ skills }),
        ...api,
      },
    },
  });
  const container = installInteractiveDom(t);
  // Loaded once the DOM exists: react-dom checks for native input events when it loads.
  const { createRoot } = require("react-dom/client");
  const vite = await createRendererServer(t, {
    cachePrefix: "openwhispr-skills-screen-test-",
    noExternal: ["react-i18next"],
    mockModules: SKILLS_MOCKS,
  });
  const store = await vite.ssrLoadModule("/stores/skillsStore.ts");
  store.useSkillsStore.setState({ skills, loaded: true });
  const Component = (await vite.ssrLoadModule(modulePath))[exportName];
  root = createRoot(container);
  await React.act(async () =>
    root.render(wrap ? wrap(Component) : React.createElement(Component, props))
  );
  await settle();
  const unmount = async () => {
    await React.act(async () => root.unmount());
    root = null;
  };
  return { container, toasts, store, vite, unmount };
}

module.exports = {
  SKILLS_MOCKS,
  ariaLabel,
  click,
  dispatch,
  findAll,
  label,
  mountSkillsComponent,
  pressEscape,
  settle,
  skill,
  typeInto,
};
