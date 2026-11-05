const test = require("node:test");
const assert = require("node:assert/strict");
const React = require("react");
const { createRendererServer } = require("../lib/rendererTestHarness");

// Real Radix dialog in happy-dom with the English strings, so a test reads what a person reads.

const DOM_GLOBALS = [
  "document",
  "navigator",
  "Node",
  "NodeFilter",
  "Element",
  "HTMLElement",
  "HTMLInputElement",
  "HTMLTextAreaElement",
  "MutationObserver",
  "getComputedStyle",
  "KeyboardEvent",
  "MouseEvent",
  "PointerEvent",
  "FocusEvent",
  "Event",
  "CustomEvent",
  "ResizeObserver",
  "DOMRect",
];

const capabilities = (overrides) => ({
  manage_members: true,
  manage_teams: true,
  create_teams: false,
  create_spaces: true,
  manage_settings: true,
  manage_billing: false,
  delete_workspace: false,
  transfer_ownership: false,
  leave: true,
  ...overrides,
});

// The role is deliberately not what decides anything: capabilities do.
const workspaceWith = ({ role = "admin", billingManager, ...overrides } = {}) => ({
  id: "w1",
  name: "Acme",
  role,
  billing_manager: billingManager,
  capabilities: capabilities(overrides),
});

let TeamPaywallDialog;
let createRoot;
let happyWindow;

test.before(async (t) => {
  const { Window } = await import("happy-dom");
  happyWindow = new Window();
  const define = (name, value) =>
    Object.defineProperty(globalThis, name, { value, configurable: true, writable: true });
  define("window", happyWindow);
  for (const name of DOM_GLOBALS) define(name, happyWindow[name]);
  for (const name of ["requestAnimationFrame", "cancelAnimationFrame"]) {
    define(name, happyWindow[name].bind(happyWindow));
  }
  define("IS_REACT_ACT_ENVIRONMENT", true);
  ({ createRoot } = require("react-dom/client"));

  const vite = await createRendererServer(t, {
    cachePrefix: "openwhispr-team-paywall-dialog-",
    noExternal: ["react-i18next"],
    mockModules: {
      "react-i18next": `
        import en from "/locales/en/translation.json";
        const lookup = (key) => key.split(".").reduce((value, part) => value?.[part], en);
        const t = (key, values = {}) => {
          const text = lookup(key);
          if (typeof text !== "string") return key;
          return text.replace(/{{\\s*(\\w+)\\s*}}/g, (_, name) => String(values[name] ?? ""));
        };
        export const useTranslation = () => ({ t, i18n: { language: "en" } });
      `,
    },
  });
  ({ default: TeamPaywallDialog } = await vite.ssrLoadModule(
    "/components/workspace/TeamPaywallDialog.tsx"
  ));
});

test.after(async () => {
  await happyWindow.happyDOM.close();
});

const h = React.createElement;
const dialog = () => happyWindow.document.querySelector('[role="dialog"]');
const readable = (value) => value.replace(/[⁨⁩]/g, "").replace(/\s+/g, " ").trim();
const buttons = () => [...dialog().querySelectorAll("button")].map((b) => readable(b.textContent));
const click = (label) =>
  React.act(async () => {
    const button = [...dialog().querySelectorAll("button")].find(
      (b) => readable(b.textContent) === label
    );
    assert.ok(button, `${label} exists`);
    button.dispatchEvent(new happyWindow.MouseEvent("click", { bubbles: true, detail: 1 }));
  });

async function mount(t, workspace) {
  const opened = [];
  const closes = [];
  happyWindow.electronAPI = { openSettingsSection: (section) => opened.push(section) };
  globalThis.window.electronAPI = happyWindow.electronAPI;
  const container = happyWindow.document.createElement("div");
  happyWindow.document.body.appendChild(container);
  const root = createRoot(container);
  t.after(async () => {
    await React.act(async () => root.unmount());
    container.remove();
    delete happyWindow.electronAPI;
  });
  function Host() {
    const [open, setOpen] = React.useState(true);
    return h(TeamPaywallDialog, {
      workspace,
      open,
      onOpenChange: (next) => {
        closes.push(next);
        setOpen(next);
      },
    });
  }
  await React.act(async () => root.render(h(Host)));
  return { opened, closes };
}

test("the owner gets Upgrade, which opens Plans & Billing and closes", async (t) => {
  // An owner's row says manage_billing; the plan name and the role are never read.
  const { opened, closes } = await mount(
    t,
    workspaceWith({ role: "member", manage_billing: true })
  );
  assert.match(readable(dialog().textContent), /Teams are on the Business plan/);
  assert.match(
    readable(dialog().textContent),
    /Teamspaces are free\. Upgrade to group people into teams\./
  );
  assert.deepEqual(buttons(), ["Upgrade to Business", "Not now"]);
  assert.equal(dialog().querySelector('button[aria-label="Close"]'), null);

  await click("Upgrade to Business");
  assert.deepEqual(closes, [false]);
  assert.deepEqual(opened, ["plansBilling"]);
});

test("another admin is told who to ask, and has no Upgrade", async (t) => {
  const { opened } = await mount(
    t,
    workspaceWith({ role: "owner", billingManager: "Olivia Owner" })
  );
  assert.match(
    readable(dialog().textContent),
    /Teamspaces are free\. Ask Olivia Owner to upgrade to group people into teams\./
  );
  assert.deepEqual(buttons(), ["Close"]);
  assert.deepEqual(opened, []);
});

test("with no name on hand, the owner", async (t) => {
  await mount(t, workspaceWith({}));
  assert.match(
    readable(dialog().textContent),
    /Ask your workspace owner to upgrade to group people into teams\./
  );
  assert.deepEqual(buttons(), ["Close"]);
});

test("Not now closes and changes nothing", async (t) => {
  const { opened, closes } = await mount(t, workspaceWith({ manage_billing: true }));
  await click("Not now");
  assert.deepEqual(closes, [false]);
  assert.deepEqual(opened, []);
});
