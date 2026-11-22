const assert = require("node:assert/strict");
const test = require("node:test");
const React = require("react");
const { createRendererServer, installHappyDom } = require("../lib/rendererTestHarness");

const ADD_SEAT = "settingsPage.billing.addSeats.title";
const CONFIRM = "settingsPage.billing.addSeats.confirm";

const paidWorkspace = (id) => ({
  id,
  name: `Workspace ${id}`,
  role: "owner",
  plan: "business",
  status: "active",
  stripe_subscription_id: "sub_x",
  seats: 10,
  seats_used: 5,
  has_subscription: true,
});

const quote = (nextQuantity) => ({
  next_quantity: nextQuantity,
  current_quantity: nextQuantity - 1,
  seats_used: 5,
  amount_due: 1600,
  currency: "usd",
});

// A boolean, so a failing assertion never has to print a happy-dom node.
const dialogOpen = (container) => container.querySelector('[role="dialog"]') !== null;

async function setup(t) {
  const cleanup = [];
  const context = { after: (callback) => cleanup.push(callback) };
  t.after(async () => {
    for (const callback of cleanup.reverse()) await callback();
  });
  const happyWindow = await installHappyDom(context);
  const state = {
    CloudApiError: class CloudApiError extends Error {
      constructor(message, status, code) {
        super(message);
        this.status = status;
        this.code = code;
      }
    },
    previewCalls: [],
    previews: [],
    refreshes: 0,
    summaryReads: 0,
    pendingPreviews: new Map(),
    updateSeatsCalls: [],
    toasts: [],
  };
  globalThis.__seatQuoteTest = state;
  globalThis.__gen = 7;
  t.after(() => {
    delete globalThis.__seatQuoteTest;
    delete globalThis.__gen;
  });
  const vite = await createRendererServer(context, {
    noExternal: ["react-i18next"],
    cachePrefix: "openwhispr-workspace-billing-seat-quote-",
    mockModules: {
      "react-i18next":
        "export const useTranslation = () => ({ t: (key) => key, i18n: { language: 'en' } });",
      "/authRequestContext":
        "export const subscribeAuthRequestContext = () => () => {}; export const getValidatedAuthGeneration = () => globalThis.__gen ?? null;",
      "/stores/workspaceStore": `export const useWorkspaceStore = (select) => select({
        refresh: async () => { globalThis.__seatQuoteTest.refreshes++; if (globalThis.__seatQuoteTest.refreshError) throw Error("offline"); }
      });`,
      "/services/WorkspacesService": `export const WorkspacesService = {
        previewSeats: (workspaceId, additionalSeats, authGeneration) => {
          const state = globalThis.__seatQuoteTest;
          state.previewCalls.push([workspaceId, additionalSeats, authGeneration]);
          return new Promise((resolve, reject) => {
            state.pendingPreviews.set(workspaceId, { resolve, reject });
            state.previews.push({ resolve, reject });
          });
        },
        updateSeats: async (workspaceId, quantity, authGeneration) => {
          globalThis.__seatQuoteTest.updateSeatsCalls.push([workspaceId, quantity, authGeneration]);
          return globalThis.__seatQuoteTest.pendingPurchase ?? { quantity, seats_used: 5 };
        },
        billingPortal: async () => "https://stripe.test/portal",
        billingCheckout: async () => "https://stripe.test/checkout",
      };`,
      // The card's free-workspace path reads these; the real modules start i18n.
      "/services/BillingSummaryService":
        "export const getBillingSummary = async () => { globalThis.__seatQuoteTest.summaryReads++; return undefined; };",
      "/services/cloudApi":
        "export const CloudApiError = globalThis.__seatQuoteTest.CloudApiError;",
      "/services/InvitationsService": "export const InvitationsService = { list: async () => [] };",
      "/ui/useToast":
        "export const useToast = () => ({ toast: (value) => globalThis.__seatQuoteTest.toasts.push(value) });",
      "/hooks/useBillingRefreshOnReturn":
        "export const useBillingRefreshOnReturn = () => () => {};",
      // The real module starts the auth client; the card only calls openAdminConsole.
      "/lib/auth": "export const openAdminConsole = async () => {};",
      // The confirmation's own dialog markup is not under test: an inline stand-in keeps it
      // queryable without Radix's portal and focus handling.
      "/ui/dialog": `import React from "react";
        const pass = ({ children }) => React.createElement("div", null, children);
        export const Dialog = ({ open, children }) =>
          open ? React.createElement("div", { role: "dialog" }, children) : null;
        export const DialogContent = pass;
        export const DialogDescription = pass;
        export const DialogFooter = pass;
        export const DialogHeader = pass;
        export const DialogTitle = pass;`,
      "../icons": `const icon = () => null;
        export const AudioLines = icon;
        export const Brain = icon;
        export const Code2 = icon;
        export const Key = icon;
        export const Link2 = icon;
        export const Mail = icon;
        export const MessageCircle = icon;
        export const MessageSquare = icon;
        export const MonitorSmartphone = icon;
        export const ShieldCheck = icon;
        export const Sliders = icon;
        export const Users = icon;
        export const Building2 = icon;
        export const Copy = icon;
        export const CreditCard = icon;
        export const ExternalLink = icon;
        export const Loader2 = icon;
        export const Plus = icon;
        export const Shield = icon;
        export const User = icon;
        export const UserPlus = icon;
        export const Zap = icon;`,
    },
  });
  const { createRoot } = require("react-dom/client");
  const container = happyWindow.document.createElement("div");
  happyWindow.document.body.appendChild(container);
  const root = createRoot(container);
  context.after(() => React.act(() => root.unmount()));
  const { default: WorkspaceBillingCard } = await vite.ssrLoadModule(
    "/components/settings/WorkspaceBillingCard.tsx"
  );
  // The same element type at the same position, with no key: React keeps the card's
  // state when the workspace changes under it.
  const render = (workspace) =>
    React.act(async () =>
      root.render(workspace ? React.createElement(WorkspaceBillingCard, { workspace }) : null)
    );
  const click = (label) =>
    React.act(async () => {
      const button = [...container.querySelectorAll("button")].find(
        (candidate) =>
          candidate.textContent === label || candidate.getAttribute("aria-label") === label
      );
      assert.ok(button, `Missing button ${label}`);
      button.click();
    });
  const resolvePreview = (workspaceId, preview) =>
    React.act(async () => state.pendingPreviews.get(workspaceId).resolve(preview));
  return { state, container, render, click, resolvePreview };
}

test("a quote for A that returns after the card shows B is dropped", async (t) => {
  const { state, container, render, click, resolvePreview } = await setup(t);
  await render(paidWorkspace("a"));
  await click(ADD_SEAT);
  assert.equal(dialogOpen(container), true);
  assert.deepEqual(state.previewCalls, [["a", 1, 7]]);
  await render(paidWorkspace("b"));
  await resolvePreview("a", quote(11));
  assert.equal(dialogOpen(container), false);
  // The dropped quote was never stored, so coming back to A doesn't show it.
  await render(paidWorkspace("a"));
  assert.equal(dialogOpen(container), false);
  assert.deepEqual(state.updateSeatsCalls, []);
});

test("a quote confirmed after the account changed sends nothing", async (t) => {
  const { state, container, render, click, resolvePreview } = await setup(t);
  await render(paidWorkspace("a"));
  await click(ADD_SEAT);
  await resolvePreview("a", quote(11));
  assert.equal(dialogOpen(container), true);
  globalThis.__gen = 8;
  await click(CONFIRM);
  assert.deepEqual(state.updateSeatsCalls, []);
  assert.equal(state.toasts.length, 0);
  assert.equal(dialogOpen(container), false);
});

test("a current quote confirms against its own workspace and generation", async (t) => {
  const { state, render, click, resolvePreview } = await setup(t);
  await render(paidWorkspace("a"));
  await click(ADD_SEAT);
  await resolvePreview("a", quote(11));
  await click(CONFIRM);
  assert.deepEqual(state.updateSeatsCalls, [["a", 11, 7]]);
});

test("without a validated sign-in no quote is requested", async (t) => {
  const { state, container, render, click } = await setup(t);
  globalThis.__gen = null;
  await render(paidWorkspace("a"));
  await click(ADD_SEAT);
  assert.deepEqual(state.previewCalls, []);
  const add = [...container.querySelectorAll("button")].find(
    (button) => button.textContent === ADD_SEAT
  );
  assert.equal(add.disabled, true);
  assert.deepEqual(state.toasts, []);
  assert.equal(dialogOpen(container), false);
});

test("an open quote for A closes when the card shows B, and coming back to A doesn't reopen it", async (t) => {
  const { state, container, render, click, resolvePreview } = await setup(t);
  await render(paidWorkspace("a"));
  await click(ADD_SEAT);
  await resolvePreview("a", quote(11));
  assert.equal(dialogOpen(container), true);
  await render(paidWorkspace("b"));
  assert.equal(dialogOpen(container), false);
  await render(paidWorkspace("a"));
  assert.equal(dialogOpen(container), false);
  assert.deepEqual(state.updateSeatsCalls, []);
});

const command = (key) => "settingsPage.billing.addSeats." + key;
const primary = (container) => [...container.querySelectorAll('[role="dialog"] button')].at(-1);
const settle = (fn) => React.act(async () => fn());
const waitForQuote = () =>
  React.act(async () => new Promise((resolve) => setTimeout(resolve, 350)));

test("only the newest opening and delta authorize a purchase, including +5 → 0 → +1", async (t) => {
  const { state, container, render, click } = await setup(t);
  await render(paidWorkspace("a"));
  await click(ADD_SEAT);
  for (let index = 0; index < 4; index++) await click(command("increase"));
  for (let index = 0; index < 5; index++) await click(command("decrease"));
  assert.equal(primary(container).disabled, true);
  assert.equal(
    state.previewCalls.some((call) => call[1] === 0),
    false
  );
  await click(command("increase"));
  await waitForQuote();
  const old = state.previews.slice();
  await click("common.cancel");
  await click(ADD_SEAT);
  for (const [index, request] of old.entries()) {
    await settle(() => (index % 2 ? request.reject(Error("old")) : request.resolve(quote(11))));
  }
  assert.equal(primary(container).disabled, true);
  assert.deepEqual(state.toasts, []);
  await settle(() => state.previews.at(-1).resolve(quote(11)));
  assert.equal(primary(container).disabled, false);
  await click(CONFIRM);
  assert.deepEqual(state.updateSeatsCalls, [["a", 11, 7]]);
});

test("a seat retry quotes the outstanding difference to the original total and requires confirmation", async (t) => {
  const { state, container, render, click } = await setup(t);
  await render(paidWorkspace("a"));
  await click(ADD_SEAT);
  for (let index = 0; index < 4; index++) await click(command("increase"));
  await waitForQuote();
  await settle(() => state.previews.at(-1).resolve({ ...quote(15), current_quantity: 10 }));
  const purchase = Promise.withResolvers();
  state.pendingPurchase = purchase.promise;
  const confirm = primary(container);
  await settle(() => {
    confirm.click();
    confirm.click();
  });
  assert.deepEqual(state.updateSeatsCalls, [["a", 15, 7]]);
  assert.equal(primary(container).disabled, true);
  assert.equal(primary(container).getAttribute("aria-busy"), "true");
  assert.match(container.querySelector('[role="status"]').textContent, /adding/);
  await settle(() => purchase.reject(Error("offline")));
  assert.equal(state.toasts.at(-1).title, command("failure"));
  assert.equal(container.querySelector("input[type=range]").value, "5");
  assert.equal(primary(container).disabled, true);
  assert.deepEqual(state.previewCalls.at(-1), ["a", 1, 7]);
  await settle(() => state.previews.at(-1).resolve(quote(13)));
  assert.deepEqual(state.previewCalls.at(-1), ["a", 3, 7]);
  assert.equal(primary(container).disabled, true);
  await settle(() => state.previews.at(-1).resolve({ ...quote(15), current_quantity: 12 }));
  assert.equal(container.querySelector("input[type=range]").value, "3");
  assert.equal(state.updateSeatsCalls.length, 1);
  state.refreshError = true;
  state.pendingPurchase = Promise.resolve({ quantity: 15, seats_used: 8 });
  const reads = state.summaryReads;
  await click(CONFIRM);
  assert.equal(dialogOpen(container), false);
  assert.deepEqual(state.updateSeatsCalls.at(-1), ["a", 15, 7]);
  assert.equal(state.toasts.at(-1).title, command("success"));
  assert.equal(state.summaryReads, reads + 1);
  assert.equal(state.refreshes, 1);
});

test("a failed remaining-seat quote waits for a manual retry and keeps the target", async (t) => {
  const { state, container, render, click, resolvePreview } = await setup(t);
  await render(paidWorkspace("a"));
  await click(ADD_SEAT);
  await click(command("increase"));
  await waitForQuote();
  await resolvePreview("a", { ...quote(12), current_quantity: 10 });
  const purchase = Promise.withResolvers();
  state.pendingPurchase = purchase.promise;
  await click(CONFIRM);
  await settle(() => purchase.reject(Error("response lost")));
  await resolvePreview("a", quote(11));
  assert.deepEqual(state.previewCalls.at(-1), ["a", 2, 7]);
  const calls = state.previewCalls.length;
  await settle(() => state.previews.at(-1).reject(Error("offline")));
  assert.equal(primary(container).disabled, true);
  assert.equal(state.previewCalls.length, calls);
  await click("common.retry");
  assert.deepEqual(state.previewCalls.slice(calls), [["a", 2, 7]]);
  await resolvePreview("a", { ...quote(12), current_quantity: 10 });
  assert.equal(primary(container).disabled, false);
  assert.deepEqual(state.updateSeatsCalls, [["a", 12, 7]]);
});

test("a lower seat ceiling during reconciliation allows confirming the newly quoted total", async (t) => {
  const { state, container, render, click, resolvePreview } = await setup(t);
  await render(paidWorkspace("a"));
  await click(ADD_SEAT);
  for (let index = 0; index < 4; index++) await click(command("increase"));
  await waitForQuote();
  await resolvePreview("a", { ...quote(15), current_quantity: 10 });
  const purchase = Promise.withResolvers();
  state.pendingPurchase = purchase.promise;
  await click(CONFIRM);
  await settle(() => purchase.reject(Error("response lost")));
  await render({ ...paidWorkspace("a"), seat_limit: 13 });
  await resolvePreview("a", quote(11));
  assert.deepEqual(state.previewCalls.at(-1), ["a", 3, 7]);
  assert.equal(primary(container).disabled, true);
  await resolvePreview("a", { ...quote(13), current_quantity: 10 });
  state.pendingPurchase = Promise.resolve({ quantity: 13 });
  await click(CONFIRM);
  assert.deepEqual(state.updateSeatsCalls, [
    ["a", 15, 7],
    ["a", 13, 7],
  ]);
});

test("a purchase accepted before its response is lost is reconciled without a second write", async (t) => {
  const { state, container, render, click, resolvePreview } = await setup(t);
  await render(paidWorkspace("a"));
  await click(ADD_SEAT);
  for (let index = 0; index < 4; index++) await click(command("increase"));
  await waitForQuote();
  await resolvePreview("a", { ...quote(15), current_quantity: 10 });
  const purchase = Promise.withResolvers();
  state.pendingPurchase = purchase.promise;
  await click(CONFIRM);
  await settle(() => purchase.reject(Error("response lost")));
  assert.equal(primary(container).disabled, true);
  await resolvePreview("a", quote(16));
  assert.equal(dialogOpen(container), false);
  assert.deepEqual(state.updateSeatsCalls, [["a", 15, 7]]);
  assert.equal(state.toasts.at(-1).title, command("success"));
  assert.equal(state.refreshes, 1);
});

for (const [label, switchView] of [
  [
    "A → B → A",
    async (render) => {
      await render(paidWorkspace("b"));
      await render(paidWorkspace("a"));
    },
  ],
  [
    "owner → member → owner",
    async (render) => {
      await render({ ...paidWorkspace("a"), role: "member" });
      await render(paidWorkspace("a"));
    },
  ],
  [
    "sign-out → other account",
    async (render) => {
      globalThis.__gen = null;
      await render(paidWorkspace("a"));
      globalThis.__gen = 8;
      await render(paidWorkspace("a"));
    },
  ],
  ["Personal or unmount", (render) => render(null)],
]) {
  for (const result of ["accepted", "failed"]) {
    test(label + " suppresses an old " + result + " purchase", async (t) => {
      const { state, container, render, click, resolvePreview } = await setup(t);
      await render(paidWorkspace("a"));
      await click(ADD_SEAT);
      await resolvePreview("a", quote(11));
      const purchase = Promise.withResolvers();
      state.pendingPurchase = purchase.promise;
      await click(CONFIRM);
      await switchView(render);
      const reads = state.summaryReads;
      await settle(() =>
        result === "accepted" ? purchase.resolve({ quantity: 11 }) : purchase.reject(Error("old"))
      );
      assert.equal(state.toasts.length, 0);
      assert.equal(state.refreshes, 0);
      assert.equal(state.summaryReads, reads);
      assert.equal(dialogOpen(container), false);
    });
  }
}

test("a rejected over-cap preview refreshes the list and requotes a clamped selection once", async (t) => {
  const { state, container, render, click } = await setup(t);
  await render({ ...paidWorkspace("a"), seats: 495, seat_limit: 500 });
  await click(ADD_SEAT);
  for (let index = 0; index < 4; index++) await click(command("increase"));
  await waitForQuote();
  await settle(() => state.previews.at(-1).reject(Error("Workspace seat limit exceeded")));
  assert.equal(state.refreshes, 1);
  assert.equal(primary(container).disabled, true);
  await render({ ...paidWorkspace("a"), seats: 499, seat_limit: 500 });
  assert.deepEqual(
    state.previewCalls.map((call) => call[1]),
    [1, 5, 1]
  );
  await settle(() => state.previews.at(-1).resolve(quote(500)));
  assert.equal(primary(container).disabled, false);
  assert.equal(container.querySelector("input[type=range]").value, "1");
});

for (const timing of ["pending", "accepted"]) {
  test("a newer workspace seat snapshot replaces a " + timing + " quote", async (t) => {
    const { state, container, render, click } = await setup(t);
    await render(paidWorkspace("a"));
    await click(ADD_SEAT);
    const previous = state.previews[0];
    if (timing === "accepted") await settle(() => previous.resolve(quote(11)));
    await render({ ...paidWorkspace("a"), seats: 15, seat_limit: 18 });
    assert.equal(primary(container).disabled, true);
    assert.equal(state.previewCalls.length, 2);
    if (timing === "pending") await settle(() => previous.resolve(quote(11)));
    assert.equal(primary(container).disabled, true);
    // The list is an invalidation signal. Stripe may already be ahead of that list.
    await settle(() => state.previews.at(-1).resolve(quote(17)));
    await click(CONFIRM);
    assert.deepEqual(state.updateSeatsCalls, [["a", 17, 7]]);
  });
}

test("a cap change clamps the selection and zero uses the newest workspace snapshot", async (t) => {
  const { state, container, render, click, resolvePreview } = await setup(t);
  await render(paidWorkspace("a"));
  await click(ADD_SEAT);
  for (let index = 0; index < 4; index++) await click(command("increase"));
  await waitForQuote();
  await resolvePreview("a", { ...quote(15), current_quantity: 10 });
  await render({ ...paidWorkspace("a"), seats: 18, seat_limit: 20 });
  assert.deepEqual(state.previewCalls.at(-1), ["a", 2, 7]);
  assert.equal(primary(container).disabled, true);
  await resolvePreview("a", { ...quote(20), current_quantity: 18 });
  await click(command("decrease"));
  await click(command("decrease"));
  const before = state.previewCalls.length;
  await render({ ...paidWorkspace("a"), seats: 19, seat_limit: 20 });
  assert.equal(state.previewCalls.length, before);
  assert.equal(
    container.querySelector("tbody tr:last-child").textContent,
    command("total") + "1919"
  );
  assert.equal(primary(container).disabled, true);
});

test("a change to the billing terms invalidates the seat price before confirmation", async (t) => {
  const { state, container, render, click, resolvePreview } = await setup(t);
  let workspace = paidWorkspace("a");
  await render(workspace);
  await click(ADD_SEAT);
  await resolvePreview("a", { ...quote(11), proration_amount: 1000 });
  for (const changed of [
    { plan: "enterprise" },
    { stripe_subscription_id: "sub_new" },
    { current_period_end: "2027-01-01T00:00:00.000Z" },
  ]) {
    workspace = { ...workspace, ...changed };
    const before = state.previewCalls.length;
    await render(workspace);
    assert.equal(state.previewCalls.length, before + 1);
    assert.equal(primary(container).disabled, true);
    assert.doesNotMatch(container.querySelector('[role="dialog"]').textContent, /\$10\.00/);
    await click(CONFIRM);
    assert.deepEqual(state.updateSeatsCalls, []);
    await resolvePreview("a", { ...quote(11), proration_amount: 1000 });
  }
  await click(CONFIRM);
  assert.deepEqual(state.updateSeatsCalls, [["a", 11, 7]]);
});

test("the seat quote must cover the current occupancy", async (t) => {
  const { state, container, render, click, resolvePreview } = await setup(t);
  await render({ ...paidWorkspace("a"), seats_used: 13 });
  await click(ADD_SEAT);
  await resolvePreview("a", { ...quote(11), seats_used: 13 });
  assert.equal(primary(container).disabled, true);
  assert.match(container.querySelector('[role="status"]').textContent, /occupancyMinimum/);
  await click(CONFIRM);
  assert.deepEqual(state.updateSeatsCalls, []);
  await click(command("increase"));
  await click(command("increase"));
  await waitForQuote();
  await resolvePreview("a", { ...quote(13), current_quantity: 10, seats_used: 13 });
  assert.equal(primary(container).disabled, false);
  await click(CONFIRM);
  assert.deepEqual(state.updateSeatsCalls, [["a", 13, 7]]);
});

test("a stale-occupancy refusal allows changing the quantity after the new preview", async (t) => {
  const { state, container, render, click, resolvePreview } = await setup(t);
  await render(paidWorkspace("a"));
  await click(ADD_SEAT);
  await resolvePreview("a", quote(11));
  const purchase = Promise.withResolvers();
  state.pendingPurchase = purchase.promise;
  await click(CONFIRM);
  await settle(() =>
    purchase.reject(new state.CloudApiError("Occupied", 409, "seat_quantity_stale"))
  );
  await resolvePreview("a", { ...quote(11), seats_used: 13 });
  assert.equal(primary(container).disabled, true);
  await click(command("increase"));
  await waitForQuote();
  assert.deepEqual(state.previewCalls.at(-1), ["a", 2, 7]);
});

test("opening at the cached ceiling can buy a seat released on another device", async (t) => {
  const { state, container, render, click, resolvePreview } = await setup(t);
  await render({ ...paidWorkspace("a"), seats: 500 });
  await click(ADD_SEAT);
  assert.equal(state.refreshes, 1);
  assert.deepEqual(state.previewCalls, [["a", 1, 7]]);
  await resolvePreview("a", quote(500));
  assert.equal(primary(container).disabled, false);
  await click(CONFIRM);
  assert.deepEqual(state.updateSeatsCalls, [["a", 500, 7]]);
});

test("a confirmed ceiling resolves an interrupted final-seat purchase even with a stale list", async (t) => {
  const { state, container, render, click, resolvePreview } = await setup(t);
  await render({ ...paidWorkspace("a"), seats: 499 });
  await click(ADD_SEAT);
  await resolvePreview("a", quote(500));
  const purchase = Promise.withResolvers();
  state.pendingPurchase = purchase.promise;
  await click(CONFIRM);
  await settle(() => purchase.reject(Error("mirror failed")));
  await settle(() => state.previews.at(-1).reject(new state.CloudApiError("Invalid request", 400)));
  assert.equal(dialogOpen(container), true);
  assert.equal(primary(container).disabled, true);
  await click("common.retry");
  await settle(() =>
    state.previews.at(-1).reject(new state.CloudApiError("Workspace seat limit exceeded", 400))
  );
  assert.equal(dialogOpen(container), false);
  assert.equal(state.toasts.at(-1).title, command("limitReached"));
  assert.deepEqual(state.updateSeatsCalls, [["a", 500, 7]]);
});

test("a larger occupancy floor during recovery requires selecting and confirming a new total", async (t) => {
  const { state, container, render, click, resolvePreview } = await setup(t);
  await render(paidWorkspace("a"));
  await click(ADD_SEAT);
  await resolvePreview("a", quote(11));
  const purchase = Promise.withResolvers();
  state.pendingPurchase = purchase.promise;
  await click(CONFIRM);
  await settle(() => purchase.reject(Error("response lost")));
  await resolvePreview("a", { ...quote(11), seats_used: 45 });
  assert.equal(primary(container).disabled, true);
  const slider = container.querySelector("input[type=range]");
  assert.equal(slider.max, "35");
  await settle(() => {
    Object.getOwnPropertyDescriptor(globalThis.window.HTMLInputElement.prototype, "value").set.call(
      slider,
      "35"
    );
    slider.dispatchEvent(new globalThis.window.Event("input", { bubbles: true }));
  });
  await waitForQuote();
  assert.equal(primary(container).disabled, true);
  await resolvePreview("a", { ...quote(45), current_quantity: 10, seats_used: 45 });
  assert.deepEqual(state.updateSeatsCalls, [["a", 11, 7]]);
  state.pendingPurchase = Promise.resolve({ quantity: 45 });
  await click(CONFIRM);
  assert.deepEqual(state.updateSeatsCalls, [
    ["a", 11, 7],
    ["a", 45, 7],
  ]);
});

test("a late purchase response from a replaced subscription cannot close its new quote", async (t) => {
  const { state, container, render, click, resolvePreview } = await setup(t);
  const workspace = paidWorkspace("a");
  await render(workspace);
  await click(ADD_SEAT);
  await resolvePreview("a", quote(11));
  const purchase = Promise.withResolvers();
  state.pendingPurchase = purchase.promise;
  await click(CONFIRM);
  await render({ ...workspace, stripe_subscription_id: "replacement" });
  await settle(() => purchase.resolve({ quantity: 11 }));
  assert.equal(dialogOpen(container), true);
  assert.equal(state.toasts.length, 0);
  assert.equal(primary(container).disabled, true);
  await resolvePreview("a", quote(13));
  assert.equal(primary(container).disabled, false);
});

test("a second interrupted write for the same total probes one seat again at the ceiling", async (t) => {
  const { state, container, render, click, resolvePreview } = await setup(t);
  await render({ ...paidWorkspace("a"), seats: 497 });
  await click(ADD_SEAT);
  await click(command("increase"));
  await click(command("increase"));
  await waitForQuote();
  const quoteThree = { ...quote(500), current_quantity: 497 };
  await resolvePreview("a", quoteThree);
  const first = Promise.withResolvers();
  state.pendingPurchase = first.promise;
  await click(CONFIRM);
  await settle(() => first.reject(Error("connection lost")));
  await resolvePreview("a", quote(498));
  await resolvePreview("a", quoteThree);
  const second = Promise.withResolvers();
  state.pendingPurchase = second.promise;
  await click(CONFIRM);
  await settle(() => second.reject(Error("Stripe updated before mirror failed")));
  assert.deepEqual(state.previewCalls.at(-1), ["a", 1, 7]);
  await settle(() =>
    state.previews.at(-1).reject(new state.CloudApiError("Workspace seat limit exceeded", 400))
  );
  assert.equal(dialogOpen(container), false);
  assert.deepEqual(state.updateSeatsCalls, [
    ["a", 500, 7],
    ["a", 500, 7],
  ]);
});
