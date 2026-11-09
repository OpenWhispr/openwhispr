// The skill pop-up against the real dialog, whose focus handling and Escape handling the
// other Skills tests replace with a stand-in.
const test = require("node:test");
const assert = require("node:assert/strict");
const React = require("react");

const { createRendererServer } = require("../lib/rendererTestHarness");
const { SKILLS_MOCKS } = require("../lib/skillsHarness");

const SKILL = {
  name: "meeting-prep",
  displayName: "Meeting prep",
  description: "Briefs me.",
  enabled: true,
  valid: true,
  addedAt: "2026-10-20T09:00:00.000Z",
  updatedAt: "2026-10-20T09:00:00.000Z",
  lastUsedAt: null,
};
const GLOBALS = [
  "window",
  "document",
  "navigator",
  "HTMLElement",
  "HTMLInputElement",
  "Node",
  "NodeFilter",
  "MutationObserver",
  "getComputedStyle",
  "Element",
  "Event",
  "CustomEvent",
  "FocusEvent",
  "KeyboardEvent",
  "MouseEvent",
  "requestAnimationFrame",
  "cancelAnimationFrame",
  "ResizeObserver",
];
const wait = (ms = 30) => React.act(() => new Promise((resolve) => setTimeout(resolve, ms)));

async function mountDialog(t) {
  const original = {};
  let root;
  let dom;
  t.after(async () => {
    if (root) await React.act(async () => root.unmount());
    await dom?.happyDOM.close();
    for (const [key, value] of Object.entries(original)) {
      if (value) Object.defineProperty(globalThis, key, value);
      else delete globalThis[key];
    }
    delete globalThis.__skillToasts;
  });
  const { Window } = await import("happy-dom");
  dom = new Window({ url: "http://localhost:5173" });
  for (const key of [...GLOBALS, "IS_REACT_ACT_ENVIRONMENT"]) {
    original[key] = Object.getOwnPropertyDescriptor(globalThis, key);
  }
  for (const key of GLOBALS) {
    const value = dom[key];
    const bind = typeof value === "function" && /AnimationFrame|getComputedStyle/.test(key);
    Object.defineProperty(globalThis, key, {
      value: bind ? value.bind(dom) : value,
      writable: true,
      configurable: true,
    });
  }
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  globalThis.__skillToasts = [];
  globalThis.window.electronAPI = {
    getPlatform: () => "darwin",
    skillsGet: async () => ({ ...SKILL, markdown: "---\nname: meeting-prep\n---\n", files: [] }),
  };

  const { "/ui/dialog": _standIn, ...mocks } = SKILLS_MOCKS;
  const vite = await createRendererServer(t, {
    cachePrefix: "openwhispr-skill-dialog-focus-",
    noExternal: ["react-i18next"],
    mockModules: mocks,
  });
  const store = await vite.ssrLoadModule("/stores/skillsStore.ts");
  store.useSkillsStore.setState({ skills: [SKILL], loaded: true });
  const { SkillDetailDialog } = await vite.ssrLoadModule(
    "/components/skills/SkillDetailDialog.tsx"
  );

  function Harness() {
    const [open, setOpen] = React.useState(false);
    return React.createElement(
      React.Fragment,
      null,
      React.createElement("button", { id: "opener", onClick: () => setOpen(true) }, "Open"),
      React.createElement(SkillDetailDialog, {
        name: SKILL.name,
        open,
        onOpenChange: setOpen,
      })
    );
  }
  const { createRoot } = require("react-dom/client");
  const container = globalThis.document.createElement("div");
  globalThis.document.body.append(container);
  root = createRoot(container);
  await React.act(async () => root.render(React.createElement(Harness)));

  const document = globalThis.document;
  const opener = document.getElementById("opener");
  const dialog = () => document.querySelector("[role=dialog]");
  const confirm = () => document.querySelector("[role=dialog] [role=alert]");
  // A key a person presses can be cancelled. The dialog closes on one tick and hands focus
  // back on the next.
  const pressEscape = async () => {
    const target = document.activeElement ?? document.body;
    const options = { key: "Escape", bubbles: true, cancelable: true };
    target.dispatchEvent(new globalThis.KeyboardEvent("keydown", options));
    await wait();
    await wait();
  };
  const open = async () => {
    opener.focus();
    opener.click();
    await wait();
  };
  return { document, opener, dialog, confirm, pressEscape, open };
}

test("closing the pop-up gives focus back to what opened it", async (t) => {
  const { document, opener, dialog, pressEscape, open } = await mountDialog(t);
  await open();
  assert.ok(dialog());

  await pressEscape();

  // Booleans: a failed comparison of two elements would try to print them.
  assert.equal(dialog() === null, true);
  assert.equal(document.activeElement === opener, true);
});

test("Esc in the uninstall confirm cancels it, and Esc again closes the pop-up", async (t) => {
  const { document, dialog, confirm, pressEscape, open } = await mountDialog(t);
  await open();
  const uninstall = [...document.querySelectorAll("[role=dialog] button")].find(
    (button) => button.textContent.trim() === "skills.detail.uninstall"
  );
  uninstall.click();
  await wait();
  assert.ok(confirm());

  await pressEscape();
  assert.equal(confirm() === null, true);
  assert.ok(dialog());

  await pressEscape();
  assert.equal(dialog() === null, true);
});
