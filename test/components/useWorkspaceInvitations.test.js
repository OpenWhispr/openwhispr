const test = require("node:test");
const assert = require("node:assert/strict");
const React = require("react");
const { createRoot } = require("react-dom/client");
const {
  createRendererServer,
  installBrowserGlobals,
  installHookDom,
} = require("../lib/rendererTestHarness");

const mountedRoots = new Map();

const invitation = (id, email) => ({
  id,
  email,
  workspace_role: "member",
  team_ids: [],
  invited_by_user_id: "u1",
  expires_at: "2027-01-01T00:00:00.000Z",
  created_at: "2026-10-01T00:00:00.000Z",
  accepted_at: null,
  revoked_at: null,
});

// Each list call returns a promise the test settles by hand, so it controls which answer lands first.
function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

async function loadHook(t) {
  t.after(async () => {
    const root = mountedRoots.get(t);
    mountedRoots.delete(t);
    if (root) await React.act(async () => root.unmount());
    delete globalThis.__invitationListCalls;
    delete globalThis.__invitationListImpl;
    delete globalThis.__latestInvitations;
  });
  installBrowserGlobals(t);
  const container = installHookDom(t);
  globalThis.__invitationListCalls = [];
  globalThis.__invitationListImpl = async () => [];
  const vite = await createRendererServer(t, {
    cachePrefix: "openwhispr-workspace-invitations-hook-",
    mockModules: {
      "/services/InvitationsService": `
        export const InvitationsService = {
          list: (workspaceId) => {
            globalThis.__invitationListCalls.push(workspaceId);
            return globalThis.__invitationListImpl(workspaceId);
          },
        };
      `,
    },
  });
  const { useWorkspaceInvitations } = await vite.ssrLoadModule(
    "/components/settings/useWorkspaceInvitations.ts"
  );
  function Harness({ workspaceId, enabled }) {
    globalThis.__latestInvitations = useWorkspaceInvitations(workspaceId, enabled);
    return null;
  }
  const root = createRoot(container);
  mountedRoots.set(t, root);
  const mount = (workspaceId, enabled) =>
    React.act(async () => {
      root.render(React.createElement(Harness, { workspaceId, enabled }));
    });
  return { mount, state: () => globalThis.__latestInvitations };
}

test("an answer for a previous workspace is dropped", async (t) => {
  const { mount, state } = await loadHook(t);
  const first = deferred();
  const second = deferred();
  const answers = { w1: first, w2: second };
  globalThis.__invitationListImpl = (workspaceId) => answers[workspaceId].promise;

  await mount("w1", true);
  await mount("w2", true);
  assert.deepEqual(globalThis.__invitationListCalls, ["w1", "w2"]);

  // The newer workspace answers first, then the stale answer arrives late.
  await React.act(async () => second.resolve([invitation("i2", "two@example.com")]));
  await React.act(async () => first.resolve([invitation("i1", "one@example.com")]));

  assert.equal(state().status, "ready");
  assert.deepEqual(
    state().invitations.map((inv) => inv.id),
    ["i2"]
  );
});

test("a stale answer that lands before the current one does not show", async (t) => {
  const { mount, state } = await loadHook(t);
  const first = deferred();
  const second = deferred();
  const answers = { w1: first, w2: second };
  globalThis.__invitationListImpl = (workspaceId) => answers[workspaceId].promise;

  await mount("w1", true);
  await mount("w2", true);
  await React.act(async () => first.resolve([invitation("i1", "one@example.com")]));

  assert.equal(state().status, "loading");
  assert.deepEqual(state().invitations, []);

  await React.act(async () => second.resolve([invitation("i2", "two@example.com")]));
  assert.deepEqual(
    state().invitations.map((inv) => inv.id),
    ["i2"]
  );
});

test("disabled stays idle and never calls the API", async (t) => {
  const { mount, state } = await loadHook(t);

  await mount("w1", false);

  assert.equal(state().status, "idle");
  assert.deepEqual(state().invitations, []);
  assert.deepEqual(globalThis.__invitationListCalls, []);

  await mount("w1", true);
  assert.deepEqual(globalThis.__invitationListCalls, ["w1"]);
  assert.equal(state().status, "ready");
});

test("a failed first load is failed, and reload retries", async (t) => {
  const { mount, state } = await loadHook(t);
  globalThis.__invitationListImpl = async () => {
    throw new Error("offline");
  };

  await mount("w1", true);
  assert.equal(state().status, "failed");

  globalThis.__invitationListImpl = async () => [invitation("i1", "one@example.com")];
  await React.act(async () => state().reload());

  assert.equal(state().status, "ready");
  assert.equal(state().invitations.length, 1);
});

test("a failed reload keeps the list it had and stays ready", async (t) => {
  const { mount, state } = await loadHook(t);
  globalThis.__invitationListImpl = async () => [invitation("i1", "one@example.com")];
  await mount("w1", true);

  globalThis.__invitationListImpl = async () => {
    throw new Error("offline");
  };
  // reload resolves even though the list call rejects.
  await React.act(async () => state().reload());

  assert.equal(state().status, "ready");
  assert.deepEqual(
    state().invitations.map((inv) => inv.id),
    ["i1"]
  );
});

test("a reload from a previous workspace leaves the current list alone", async (t) => {
  const { mount, state } = await loadHook(t);
  globalThis.__invitationListImpl = async (workspaceId) => [
    invitation(`i-${workspaceId}`, `${workspaceId}@example.com`),
  ];
  await mount("w1", true);
  // A caller (a resend, a cancel) keeps the reload it got while w1 was showing.
  const staleReload = state().reload;

  const second = deferred();
  globalThis.__invitationListImpl = (workspaceId) =>
    workspaceId === "w2"
      ? second.promise
      : Promise.resolve([invitation("i-late", "late@example.com")]);
  await mount("w2", true);
  await React.act(async () => staleReload());
  await React.act(async () => second.resolve([invitation("i2", "two@example.com")]));

  // The stale reload never asked for w1 again, and w2's answer was not dropped.
  assert.deepEqual(globalThis.__invitationListCalls, ["w1", "w2"]);
  assert.equal(state().status, "ready");
  assert.deepEqual(
    state().invitations.map((inv) => inv.id),
    ["i2"]
  );
});
