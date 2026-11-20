const assert = require("node:assert/strict");
const test = require("node:test");
const React = require("react");
const { createRendererServer, installHappyDom } = require("../lib/rendererTestHarness");

const ADD_SEAT = "settingsPage.unifiedBilling.addSeat";
const CONFIRM = "settingsPage.unifiedBilling.confirmSeats.confirm";
const SEAT_UPDATE_FAILED = "settingsPage.unifiedBilling.seatUpdateFailed";

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
    previewCalls: [],
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
        "export const getValidatedAuthGeneration = () => globalThis.__gen ?? null;",
      "/stores/workspaceStore": `export const useWorkspaceStore = (select) => select({
        refresh: async () => {}
      });`,
      "/services/WorkspacesService": `export const WorkspacesService = {
        previewSeats: (workspaceId, additionalSeats, authGeneration) => {
          const state = globalThis.__seatQuoteTest;
          state.previewCalls.push([workspaceId, additionalSeats, authGeneration]);
          return new Promise((resolve, reject) => {
            state.pendingPreviews.set(workspaceId, { resolve, reject });
          });
        },
        updateSeats: async (workspaceId, quantity, authGeneration) => {
          globalThis.__seatQuoteTest.updateSeatsCalls.push([workspaceId, quantity, authGeneration]);
          return { quantity, seats_used: 5 };
        },
        billingPortal: async () => "https://stripe.test/portal",
        billingCheckout: async () => "https://stripe.test/checkout",
      };`,
      // The card's free-workspace path reads these; the real modules start i18n.
      "/services/cloudApi": "export class CloudApiError extends Error {}",
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
    React.act(async () => root.render(React.createElement(WorkspaceBillingCard, { workspace })));
  const click = (label) =>
    React.act(async () => {
      const button = [...container.querySelectorAll("button")].find(
        (candidate) => candidate.textContent === label
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
  assert.equal(state.toasts.at(-1).title, SEAT_UPDATE_FAILED);
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
  assert.equal(state.toasts.at(-1).title, SEAT_UPDATE_FAILED);
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
