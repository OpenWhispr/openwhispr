const assert = require("node:assert/strict");
const test = require("node:test");
const React = require("react");
const { createRendererServer, installHappyDom } = require("../lib/rendererTestHarness");

const PERSONAL = { kind: "personal" };
const DISABLED = { kind: "disabled" };
const workspace = (workspaceId, canManageBilling = true) => ({
  kind: "workspace",
  workspaceId,
  canManageBilling,
});

async function setup(t, mockModules = {}) {
  const cleanups = [];
  const context = { after: (callback) => cleanups.push(callback) };
  t.after(async () => {
    for (const callback of cleanups.reverse()) await callback();
  });
  const happyWindow = await installHappyDom(context);
  happyWindow.happyDOM.setURL("https://example.com");
  const requests = [];
  let generation = 1;
  happyWindow.electronAPI = {
    authGetTokenState: async () => ({ token: "test-token", generation }),
    cloudApiRequest: (request) =>
      new Promise((resolve, reject) => requests.push({ ...request, resolve, reject })),
  };
  const vite = await createRendererServer(context, {
    cachePrefix: "openwhispr-use-billing-summary-",
    mockModules,
    noExternal: ["react-i18next"],
  });
  const { useBillingSummary } = await vite.ssrLoadModule("/hooks/useBillingSummary.ts");
  const auth = await vite.ssrLoadModule("/lib/authRequestContext.ts");
  const { createRoot } = require("react-dom/client");
  const container = happyWindow.document.createElement("div");
  const root = createRoot(container);
  let mounted = true;
  const unmount = async () => {
    if (!mounted) return;
    await React.act(async () => root.unmount());
    mounted = false;
  };
  context.after(unmount);

  const renders = [];
  let latest;
  function Probe({ input }) {
    latest = useBillingSummary(input);
    renders.push(latest.summary?.billing_email);
    return null;
  }
  return {
    container,
    root,
    vite,
    requests,
    renders,
    render: async (input) => {
      renders.length = 0;
      await React.act(async () => root.render(React.createElement(Probe, { input })));
    },
    signIn: (nextGeneration) =>
      React.act(async () => {
        generation = nextGeneration;
        const request = await auth.prepareAuthRequest({
          url: "https://example.com/api/auth/get-session",
        });
        const userId = `user-${generation}`;
        await auth.handleAuthRequestSuccess({
          request,
          response: new Response(),
          data: { user: { id: userId } },
        });
        assert.equal(auth.commitValidatedAuthContext(generation, userId), true);
      }),
    current: () => latest.summary?.billing_email,
    refresh: () => React.act(async () => latest.refresh()),
    settle: (request, email) =>
      React.act(async () => {
        if (email instanceof Error) request.reject(email);
        else request.resolve({ success: true, data: { data: { billing_email: email } } });
      }),
    unmount,
  };
}

test("only a visible eligible plan with a validated sign-in requests billing details", async (t) => {
  const probe = await setup(t);
  await probe.render(PERSONAL);
  assert.equal(probe.requests.length, 0);
  await probe.render(DISABLED);
  await probe.signIn(1);
  await probe.refresh();
  await probe.render(workspace("A", false));
  await probe.refresh();
  assert.equal(probe.requests.length, 0);
  await probe.render(workspace("A"));
  assert.equal(probe.requests.length, 1);
  assert.equal(probe.requests[0].path, "/api/workspaces/A/billing/summary");
  await probe.settle(probe.requests[0], "owner-a");
  assert.equal(probe.current(), "owner-a");
  await probe.render(workspace("A", false));
  assert.equal(probe.renders[0], undefined);
  assert.equal(probe.current(), undefined);
  assert.equal(probe.requests.length, 1);
});

test("settlement from a superseded workspace cannot surface after a view, auth or role change", async (t) => {
  for (const [name, change, expectedPath, expectedGeneration] of [
    [
      "Workspace B",
      (probe) => probe.render(workspace("B")),
      "/api/workspaces/B/billing/summary",
      1,
    ],
    ["Personal", (probe) => probe.render(PERSONAL), "/api/billing/summary", 1],
    ["new sign-in at A", (probe) => probe.signIn(2), "/api/workspaces/A/billing/summary", 2],
    ["role loss", (probe) => probe.render(workspace("A", false))],
    ["unmount", (probe) => probe.unmount()],
    [
      "revisit A",
      async (probe) => {
        await probe.render(workspace("B"));
        await probe.render(workspace("A"));
      },
      "/api/workspaces/A/billing/summary",
      1,
    ],
  ]) {
    await t.test(name, async (subtest) => {
      const probe = await setup(subtest);
      await probe.signIn(1);
      await probe.render(workspace("A"));
      await probe.refresh();
      await change(probe);
      assert.equal(probe.current(), undefined);
      if (expectedPath) {
        const active = probe.requests.at(-1);
        assert.equal(active.path, expectedPath);
        assert.equal(active.expectedAuthGeneration, expectedGeneration);
        await probe.settle(active, "current");
      } else {
        assert.equal(probe.requests.length, 2);
      }
      await probe.settle(probe.requests[1], "stale");
      await probe.settle(probe.requests[0], new Error("stale failure"));
      assert.equal(probe.current(), expectedPath ? "current" : undefined);
      assert.ok(!probe.renders.includes("stale"));
    });
  }
});

test("the latest refresh wins when two requests settle in reverse order", async (t) => {
  const probe = await setup(t);
  await probe.signIn(1);
  await probe.render(PERSONAL);
  await probe.settle(probe.requests[0], "original");
  await probe.refresh();
  await probe.refresh();
  await probe.settle(probe.requests[2], "newest");
  await probe.settle(probe.requests[1], "older");
  assert.equal(probe.current(), "newest");
  assert.ok(!probe.renders.includes("older"));
  await probe.refresh();
  await probe.settle(probe.requests[3], new Error("unavailable"));
  assert.equal(probe.current(), undefined);
});

test("Personal billing refreshes on purchase, plan and cadence changes, but not word usage", async (t) => {
  const { root, vite, requests, signIn } = await setup(t);
  const { usePersonalPlanBilling } = await vite.ssrLoadModule("/hooks/usePersonalPlanBilling.ts");
  const amounts = [];
  function Personal({ usage }) {
    const { state } = usePersonalPlanBilling({
      enabled: true,
      view: "personal",
      signedIn: true,
      usage,
      coveringWorkspaceNames: [],
      businessAction: { kind: "none" },
      hasWorkspacePlanAction: false,
    });
    amounts.push(state.details.find((row) => row.labelKey === "details.nextInvoice")?.value.amount);
    return null;
  }
  const render = (usage) =>
    React.act(async () => root.render(React.createElement(Personal, { usage })));
  const settle = (request, amount) =>
    React.act(async () =>
      request.resolve({
        success: true,
        data: { data: { next_invoice: { amount, currency: "usd" } } },
      })
    );
  const free = { status: "success", plan: "free", entitledWorkspaceIds: [] };
  const business = {
    ...free,
    plan: "business",
    subscriptionStatus: "active",
    isPersonallySubscribed: true,
    isSubscribed: true,
    billingInterval: "monthly",
  };
  const pro = { ...business, plan: "pro" };

  await signIn(1);
  await render(free);
  await render(business);
  assert.equal(requests.length, 2);
  await settle(requests[1], 5000);
  assert.equal(amounts.at(-1), 5000);
  await render(pro);
  assert.equal(amounts.at(-1), undefined);
  await render({ ...pro, billingInterval: "annual" });
  assert.equal(requests.length, 4);
  await settle(requests[3], 9600);
  await settle(requests[2], 1000);
  await settle(requests[0], 0);
  await render({ ...pro, billingInterval: "annual", wordsUsed: 42 });
  assert.equal(requests.length, 4);
  assert.equal(amounts.at(-1), 9600);
  assert.ok(!amounts.includes(1000));
  assert.ok(!amounts.includes(0));
});

test("plan views show only the current billing contact and amount across scope and permission changes", async (t) => {
  const toasts = [];
  globalThis.__summaryViewToasts = toasts;
  t.after(() => delete globalThis.__summaryViewToasts);
  const { container, root, vite, requests, signIn } = await setup(t, {
    "react-i18next":
      "export const useTranslation = () => ({ t: (key) => key, i18n: { language: 'en-US' } });",
    "/i18n": "export default { t: (key) => key };",
    "/lib/auth": "export const openAdminConsole = async () => {};",
    "/services/WorkspacesService": "export const WorkspacesService = {};",
    "/services/InvitationsService": "export const InvitationsService = {};",
    "/stores/workspaceStore":
      "export const useWorkspaceStore = (select) => select({ refresh: async () => {} });",
    "/ui/useToast":
      "export const useToast = () => ({ toast: (value) => globalThis.__summaryViewToasts.push(value) });",
  });
  const { WorkspaceBillingView } = await vite.ssrLoadModule(
    "/components/settings/billing/WorkspaceBillingView.tsx"
  );
  const { PersonalPlanView } = await vite.ssrLoadModule(
    "/components/settings/billing/PersonalPlanView.tsx"
  );
  const { usePersonalPlanBilling } = await vite.ssrLoadModule("/hooks/usePersonalPlanBilling.ts");
  const { resolveBillingView } = await vite.ssrLoadModule("/lib/plansBillingView.ts");
  const owner = {
    id: "workspace/A",
    name: "Acme",
    role: "owner",
    plan: "business",
    status: "active",
    stripe_subscription_id: "sub_fixture",
    seats: 5,
    seats_used: 2,
    member_count: 2,
  };

  function BillingViews({ request, selectedWorkspace }) {
    const view = resolveBillingView(request, {
      loaded: true,
      error: false,
      workspaces: [selectedWorkspace],
    });
    const { state } = usePersonalPlanBilling({
      enabled: true,
      view: view.kind,
      signedIn: true,
      usage: {
        status: "success",
        plan: "pro",
        isSubscribed: true,
        isPersonallySubscribed: true,
        entitledWorkspaceIds: [],
        billingInterval: "monthly",
      },
      businessAction: { kind: "none" },
      coveringWorkspaceNames: [],
    });
    if (view.kind !== "personal") {
      return React.createElement(WorkspaceBillingView, { view, onViewPersonal: () => {} });
    }
    return React.createElement(PersonalPlanView, { state, formatDate: (date) => date });
  }

  const workspaceRequest = { kind: "workspace", workspaceId: owner.id };
  const render = (request, selectedWorkspace = owner) =>
    React.act(async () =>
      root.render(React.createElement(BillingViews, { request, selectedWorkspace }))
    );
  const settleInvoice = (request, email, amount) =>
    React.act(async () =>
      request.resolve({
        success: true,
        data: {
          data: {
            billing_email: email,
            next_invoice: { date: null, amount, currency: "usd" },
          },
        },
      })
    );

  await signIn(1);
  const member = { ...owner, capabilities: { manage_billing: false } };
  await render(workspaceRequest, member);
  assert.equal(requests.length, 0);
  await render(PERSONAL);
  await render(workspaceRequest);
  assert.deepEqual(
    requests.map(({ path }) => path),
    ["/api/billing/summary", "/api/workspaces/workspace%2FA/billing/summary"]
  );
  await settleInvoice(requests[1], "owner@example.test", 14550);
  await settleInvoice(requests[0], "old@example.test", 15050);
  assert.match(container.textContent, /owner@example\.test/);
  assert.match(container.textContent, /\$145\.50/);
  assert.doesNotMatch(container.textContent, /old@example\.test|\$150\.50/);

  await render(PERSONAL);
  assert.doesNotMatch(container.textContent, /@example\.test|\$(145|150)\.50/);
  assert.equal(requests[2]?.path, "/api/billing/summary");
  await settleInvoice(requests[2], "personal@example.test", 2125);
  assert.match(container.textContent, /personal@example\.test/);
  assert.match(container.textContent, /\$21\.25/);

  await signIn(2);
  await render(workspaceRequest);
  await render(workspaceRequest, member);
  await React.act(async () => requests[3].reject(new Error("stale personal failure")));
  await settleInvoice(requests[4], "revoked@example.test", 50050);
  assert.doesNotMatch(container.textContent, /@example\.test|\$500\.50|billingDetails/);
  assert.match(container.textContent, /settingsPage\.billing\.workspace\.workspaceDetails/);
  assert.deepEqual(toasts, []);
  assert.deepEqual(
    requests.map(({ method, path, expectedAuthGeneration }) => [
      method,
      path,
      expectedAuthGeneration,
    ]),
    [
      ["GET", "/api/billing/summary", 1],
      ["GET", "/api/workspaces/workspace%2FA/billing/summary", 1],
      ["GET", "/api/billing/summary", 1],
      ["GET", "/api/billing/summary", 2],
      ["GET", "/api/workspaces/workspace%2FA/billing/summary", 2],
    ]
  );
});
