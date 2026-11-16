const test = require("node:test");
const assert = require("node:assert/strict");

const load = async () => {
  const [check, cloud] = await Promise.all([
    import("../../src/services/standInOwnershipCheck.ts"),
    import("../../src/services/cloudApi.ts"),
  ]);
  return { ...check, CloudApiError: cloud.CloudApiError };
};

const makeApi = (candidates) => {
  const resolved = [];
  return {
    resolved,
    api: {
      getStandInOwnershipCandidates: async () => candidates,
      resolveStandInOwnership: async (request) => {
        resolved.push(request);
        return { claimed: request.owned };
      },
    },
  };
};

const run = (checkStandInOwnership, options) =>
  checkStandInOwnership({
    accountId: "acct",
    authGeneration: 1,
    isCurrent: () => true,
    ...options,
  });

test("claims a note the cloud says the account owns", async () => {
  const { checkStandInOwnership } = await load();
  const { api, resolved } = makeApi([{ id: 4, cloud_id: "c4" }]);
  const result = await run(checkStandInOwnership, {
    api,
    get: async () => ({ my_permission: "owner" }),
  });
  assert.deepEqual(resolved, [{ noteId: 4, cloudId: "c4", owned: true, accountId: "acct" }]);
  assert.deepEqual(result, { claimed: 1, notOwned: 0 });
});

test("records shared and missing notes as not owned", async () => {
  const { checkStandInOwnership, CloudApiError } = await load();
  const { api, resolved } = makeApi([
    { id: 1, cloud_id: "shared" },
    { id: 2, cloud_id: "missing" },
  ]);
  const result = await run(checkStandInOwnership, {
    api,
    get: async (path) => {
      if (path.includes("missing")) throw new CloudApiError("nope", 404);
      return { my_permission: "editor" };
    },
  });
  assert.deepEqual(resolved.map((r) => [r.noteId, r.owned]).sort(), [
    [1, false],
    [2, false],
  ]);
  assert.deepEqual(result, { claimed: 0, notOwned: 2 });
});

test("records nothing on network, 401 and 5xx errors", async () => {
  const { checkStandInOwnership, CloudApiError } = await load();
  const errors = [
    new CloudApiError("offline", 0),
    new CloudApiError("expired", 401, "AUTH_EXPIRED"),
    new CloudApiError("down", 503),
  ];
  const { api, resolved } = makeApi([
    { id: 1, cloud_id: "a" },
    { id: 2, cloud_id: "b" },
    { id: 3, cloud_id: "c" },
  ]);
  const warn = console.warn;
  console.warn = () => {};
  try {
    await run(checkStandInOwnership, {
      api,
      get: async (path) => {
        throw errors[["a", "b", "c"].findIndex((id) => path.includes(`/${id}/`))];
      },
    });
  } finally {
    console.warn = warn;
  }
  assert.equal(resolved.length, 0);
});

test("stops when the account changes mid-check", async () => {
  const { checkStandInOwnership } = await load();
  const { api, resolved } = makeApi([{ id: 1, cloud_id: "a" }]);
  let current = true;
  await run(checkStandInOwnership, {
    api,
    isCurrent: () => current,
    get: async () => {
      current = false;
      return { my_permission: "owner" };
    },
  });
  assert.equal(resolved.length, 0);
});

test("asks at most three at a time", async () => {
  const { checkStandInOwnership } = await load();
  const candidates = Array.from({ length: 7 }, (_, index) => ({
    id: index,
    cloud_id: `c${index}`,
  }));
  const { api } = makeApi(candidates);
  let active = 0;
  let peak = 0;
  await run(checkStandInOwnership, {
    api,
    get: async () => {
      active++;
      peak = Math.max(peak, active);
      await new Promise((resolve) => setTimeout(resolve, 5));
      active--;
      return { my_permission: "viewer" };
    },
  });
  assert.equal(peak, 3);
});
