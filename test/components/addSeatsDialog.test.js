const test = require("node:test");
const assert = require("node:assert/strict");
const React = require("react");
const { createRendererServer } = require("../lib/rendererTestHarness");

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

let AddSeatsDialog;
let createRoot;
let happyWindow;
let vite;

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

  vite = await createRendererServer(t, {
    cachePrefix: "openwhispr-add-seats-dialog-",
    noExternal: ["react-i18next"],
    mockModules: {
      "react-i18next": `
        import en from "/locales/en/translation.json";
        const lookup = (key) => key.split(".").reduce((value, part) => value?.[part], en);
        const t = (key, values = {}) => {
          let text = lookup(key);
          if (text === undefined && typeof values.count === "number") {
            text = lookup(key + "_" + new Intl.PluralRules("en").select(values.count));
          }
          if (typeof text !== "string") return key;
          return text.replace(/{{\\s*(\\w+)\\s*}}/g, (_, name) => String(values[name] ?? ""));
        };
        export const useTranslation = () => ({ t, i18n: { language: "en" } });
      `,

      "/services/cloudApi": "export class CloudApiError extends Error {}",
      "/authRequestContext": "export const getValidatedAuthGeneration = () => 7;",
      "/services/WorkspacesService":
        "export const WorkspacesService = { previewSeats: (...args) => globalThis.__previewSeats(...args), updateSeats: (...args) => globalThis.__updateSeats(...args) };",
      "/ui/useToast":
        "export const useToast = () => ({ toast: (message) => globalThis.__seatMessages.push(message) });",
    },
  });
  ({ AddSeatsDialog } = await vite.ssrLoadModule(
    "/components/settings/billing/AddSeatsDialog.tsx"
  ));
});
test.after(async () => {
  await happyWindow.happyDOM.close();
});

async function open(t, options = {}) {
  const container = happyWindow.document.createElement("div");
  happyWindow.document.body.appendChild(container);
  const root = createRoot(container);
  const previewCalls = [];
  const messages = [];
  globalThis.__seatMessages = messages;
  globalThis.__previewSeats = async (_workspaceId, delta) => {
    previewCalls.push(delta);
    return {
      current_quantity: 10,
      next_quantity: 10 + delta,
      seats_used: 10,
      amount_due: 11000,
      currency: "usd",
      ...(options.legacy
        ? {}
        : {
            member_seats: 8,
            pending_seats: 2,
            unit_amount: 1200,
            interval: "monthly",
            proration_amount: 200 * delta,
            next_invoice_amount: 12000 + 200 * delta,
            next_invoice_date: "2026-11-19T12:00:00Z",
          }),
    };
  };
  globalThis.__updateSeats = async () => ({ quantity: 23, seats_used: 10 });
  const identity = { workspaceId: "a", authGeneration: 7 };
  function Harness() {
    const [visible, setVisible] = React.useState(true);
    const trigger = React.useRef(null);
    return React.createElement(
      React.Fragment,
      null,
      React.createElement("button", { ref: trigger, onClick: () => setVisible(true) }, "Open"),
      visible &&
        React.createElement(AddSeatsDialog, {
          workspace: {
            id: "a",
            name: "Acme",
            seats: 10,
            seats_used: 10,
            seat_limit: options.seatLimit,
          },
          planName: "Business",
          identity,
          summary: options.legacy
            ? undefined
            : { next_invoice: { amount: 10000, currency: "usd", date: "2026-11-19T12:00:00Z" } },
          onClose: () => setVisible(false),
          restoreFocus: () => trigger.current?.focus(),
          refreshWorkspace: async () => {},
          refreshSummary: () => {},
        })
    );
  }
  t.after(async () => {
    await React.act(async () => root.unmount());
    container.remove();
  });
  await React.act(async () => root.render(React.createElement(Harness)));
  return { previewCalls, messages };
}

const dialog = () => happyWindow.document.querySelector('[role="dialog"]');
const range = () => dialog().querySelector('input[type="range"]');
const labels = () => [...dialog().querySelectorAll("dt")].map((element) => element.textContent);
const byName = (name) =>
  [...dialog().querySelectorAll("button")].find(
    (button) => (button.getAttribute("aria-label") || button.textContent) === name
  );
const amount = (name) =>
  [...dialog().querySelectorAll("tr")].find((row) => row.querySelector("th")?.textContent === name)
    ?.textContent;
const click = (name) =>
  React.act(async () => {
    assert.ok(byName(name), name);
    byName(name).click();
  });
const setRange = (value) =>
  React.act(async () => {
    Object.getOwnPropertyDescriptor(happyWindow.HTMLInputElement.prototype, "value").set.call(
      range(),
      String(value)
    );
    range().dispatchEvent(new happyWindow.Event("input", { bubbles: true }));
  });
const waitForFocus = () => React.act(async () => new Promise((resolve) => setTimeout(resolve, 10)));
const waitForQuote = () =>
  React.act(async () => new Promise((resolve) => setTimeout(resolve, 350)));

test("the real dialog opens on the quantity, displays the dated totals and returns focus after purchase", async (t) => {
  const { messages, previewCalls } = await open(t);
  await waitForFocus();
  assert.equal(happyWindow.document.activeElement === range(), true);
  assert.equal(range().labels[0].textContent, "Seats to add");
  assert.match(dialog().textContent, /Acme · Business/);
  assert.ok(byName("Add 1 seat"));
  assert.equal(amount("Pending seats"), "Pending seats22");
  assert.equal(amount("Available"), "Available01");
  assert.deepEqual(labels(), ["Price", "Added to next invoice", "Next invoice · Nov 19, 2026"]);
  assert.doesNotMatch(dialog().textContent, /Charge today/);
  await setRange(5);
  assert.ok(byName("Add 5 seats"));
  assert.equal(amount("Total seats"), "Total seats1015");
  await click("Decrease seats");
  assert.ok(byName("Add 4 seats"));
  await click("Increase seats");
  await setRange(0);
  assert.equal(byName("Decrease seats").disabled, true);
  assert.equal(byName("Add seats").disabled, true);
  assert.equal(amount("Total seats"), "Total seats1010");
  assert.deepEqual(
    [...dialog().querySelectorAll("dd")].map((element) => element.textContent),
    ["$12.00 / seat / month", "$0.00", "$100.00"]
  );
  await setRange(20);
  assert.equal(byName("Increase seats").disabled, true);
  assert.equal(amount("Total seats"), "Total seats1030");
  await waitForQuote();
  assert.deepEqual(previewCalls, [1, 20]);
  await click("Add 20 seats");
  await waitForFocus();
  assert.equal(dialog() === null, true);
  assert.equal(happyWindow.document.activeElement.textContent, "Open");
  assert.equal(messages[0].title, "Acme now has 23 seats.");
});

test("older previews omit unavailable pricing and seat categories", async (t) => {
  await open(t, { legacy: true });
  assert.deepEqual(labels(), ["Next invoice"]);
  assert.equal(amount("In use"), undefined);
  assert.equal(amount("Pending seats"), undefined);
  assert.equal(amount("Available"), "Available01");
});

test("an owner already at the cap can close the dialog from initial keyboard focus", async (t) => {
  const { previewCalls } = await open(t, { seatLimit: 10 });
  await waitForFocus();
  assert.equal(range().disabled, true);
  assert.equal(byName("Decrease seats").disabled, true);
  assert.equal(byName("Increase seats").disabled, true);
  assert.equal(byName("Add seats").disabled, true);
  assert.equal(happyWindow.document.activeElement === byName("Cancel"), true);
  assert.deepEqual(previewCalls, [1]);
  await click("Cancel");
  await waitForFocus();
  assert.equal(happyWindow.document.activeElement.textContent, "Open");
});
