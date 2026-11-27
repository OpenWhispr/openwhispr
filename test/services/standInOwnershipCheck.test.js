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

const ownerAccess = ({ ownerId = "acct", grants = [] } = {}) => ({
  owner: { type: "user", id: ownerId },
  grants,
  my_permission: "owner",
});

const quietly = async (body) => {
  const warn = console.warn;
  console.warn = () => {};
  try {
    return await body();
  } finally {
    console.warn = warn;
  }
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
    get: async () => ownerAccess(),
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
      return ownerAccess();
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

test("records nothing for a 403 other than note_access_denied, such as SSO_REQUIRED", async () => {
  const { checkStandInOwnership, CloudApiError } = await load();
  const { api, resolved } = makeApi([
    { id: 1, cloud_id: "sso" },
    { id: 2, cloud_id: "bare" },
  ]);
  await quietly(() =>
    run(checkStandInOwnership, {
      api,
      get: async (path) => {
        if (path.includes("sso")) throw new CloudApiError("sso", 403, "SSO_REQUIRED");
        throw new CloudApiError("forbidden", 403);
      },
    })
  );
  assert.equal(resolved.length, 0);
});

test("records a 403 note_access_denied as not owned", async () => {
  const { checkStandInOwnership, CloudApiError } = await load();
  const { api, resolved } = makeApi([{ id: 1, cloud_id: "viewer" }]);
  const result = await run(checkStandInOwnership, {
    api,
    get: async () => {
      throw new CloudApiError("denied", 403, "note_access_denied");
    },
  });
  assert.deepEqual(
    resolved.map((r) => [r.noteId, r.owned]),
    [[1, false]]
  );
  assert.deepEqual(result, { claimed: 0, notOwned: 1 });
});

test("records nothing when the answer names no known permission", async () => {
  const { checkStandInOwnership } = await load();
  const { api, resolved } = makeApi([
    { id: 1, cloud_id: "missing" },
    { id: 2, cloud_id: "unknown" },
  ]);
  await quietly(() =>
    run(checkStandInOwnership, {
      api,
      get: async (path) => (path.includes("unknown") ? { my_permission: "admin" } : {}),
    })
  );
  assert.equal(resolved.length, 0);
});

test("records nothing when the owner the answer names is another account", async () => {
  const { checkStandInOwnership } = await load();
  const { api, resolved } = makeApi([{ id: 1, cloud_id: "c1" }]);
  await quietly(() =>
    run(checkStandInOwnership, { api, get: async () => ownerAccess({ ownerId: "someone" }) })
  );
  assert.equal(resolved.length, 0);
});

test("never claims a teamspace note the account owns", async () => {
  const { checkStandInOwnership } = await load();
  const { api, resolved } = makeApi([{ id: 1, cloud_id: "team" }]);
  const result = await run(checkStandInOwnership, {
    api,
    get: async () =>
      ownerAccess({
        grants: [
          {
            id: "scope:space:s1",
            principal: { type: "space", id: "s1" },
            permission: "editor",
            source: "space",
            inherited: true,
          },
        ],
      }),
  });
  assert.deepEqual(
    resolved.map((r) => [r.noteId, r.owned]),
    [[1, false]]
  );
  assert.deepEqual(result, { claimed: 0, notOwned: 1 });
});

test("claims an owned note scoped to a whole workspace, as the notes pull files it", async () => {
  const { checkStandInOwnership } = await load();
  const { api, resolved } = makeApi([{ id: 1, cloud_id: "legacy" }]);
  const result = await run(checkStandInOwnership, {
    api,
    get: async () =>
      ownerAccess({
        grants: [
          {
            id: "scope:workspace:w1",
            principal: { type: "workspace", id: "w1" },
            permission: "editor",
            source: "workspace",
            inherited: true,
          },
        ],
      }),
  });
  assert.deepEqual(
    resolved.map((r) => [r.noteId, r.owned]),
    [[1, true]]
  );
  assert.deepEqual(result, { claimed: 1, notOwned: 0 });
});

test("asks nothing once the account has already changed", async () => {
  const { checkStandInOwnership } = await load();
  const { api, resolved } = makeApi([{ id: 1, cloud_id: "a" }]);
  let asked = 0;
  await run(checkStandInOwnership, {
    api,
    isCurrent: () => false,
    get: async () => {
      asked++;
      return ownerAccess();
    },
  });
  assert.equal(asked, 0);
  assert.equal(resolved.length, 0);
});

test("one candidate that fails to resolve doesn't stop the others", async () => {
  const { checkStandInOwnership } = await load();
  const resolved = [];
  const api = {
    getStandInOwnershipCandidates: async () => [
      { id: 1, cloud_id: "a" },
      { id: 2, cloud_id: "b" },
      { id: 3, cloud_id: "c" },
      { id: 4, cloud_id: "d" },
    ],
    resolveStandInOwnership: async (request) => {
      if (request.noteId === 1) throw new Error("database busy");
      resolved.push(request.noteId);
      return { claimed: false };
    },
  };
  const result = await quietly(() =>
    run(checkStandInOwnership, { api, get: async () => ({ my_permission: "editor" }) })
  );
  assert.deepEqual(resolved.sort(), [2, 3, 4]);
  assert.deepEqual(result, { claimed: 0, notOwned: 3 });
});
