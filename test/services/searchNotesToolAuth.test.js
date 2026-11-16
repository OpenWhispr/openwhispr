const test = require("node:test");
const assert = require("node:assert/strict");
const { createCloudApiRequestHandler } = require("../../src/helpers/cloudApiRequest");
const { installBrowserGlobals } = require("../lib/rendererTestHarness");

const QUERY = "ACCOUNT_A_PRIVATE_QUERY_CANARY";
const deferred = () => {
  let resolve;
  const promise = new Promise((answer) => {
    resolve = answer;
  });
  return { promise, resolve };
};

async function setup(t, { teamCount = 11, respond, beforeIpc, validated = true } = {}) {
  const auth = await import("../../src/lib/authRequestContext.ts");
  auth.resetAuthRequestContextForTests();
  t.after(() => auth.resetAuthRequestContextForTests());
  let state = { token: "token-a", generation: 1 };
  const requests = [];
  const attempts = [];
  const teams = Array.from({ length: teamCount }, (_, index) => ({
    id: 100 + index,
    name: `Team ${index}`,
    kind: "team",
    cloud_space_id: `team-${index}`,
  }));
  const main = createCloudApiRequestHandler({
    getApiUrl: () => "https://api.openwhispr.test",
    getAppVersion: () => "1.0.0",
    tokenStore: { getState: () => ({ ...state }) },
    proxyFetch: async (_url, options) => {
      const request = {
        authorization: options.headers.Authorization,
        body: JSON.parse(options.body),
      };
      requests.push(request);
      if (respond) return respond(request, requests.length);
      return new Response(JSON.stringify({ notes: [] }));
    },
  });
  installBrowserGlobals(t, {
    window: {
      location: { origin: "https://desktop.test", search: "?panel=true" },
      electronAPI: {
        getSpaces: async () => teams,
        semanticSearchNotes: async () => [],
        searchNotes: async () => [],
        authGetTokenState: async () => ({ ...state }),
        cloudApiRequest: async (options) => {
          attempts.push(options);
          await beforeIpc?.(options, attempts.length);
          return main(options);
        },
      },
    },
  });
  const validate = async (userId, generation) => {
    state = { token: userId === "account-a" ? "token-a" : "token-b", generation };
    await auth.handleAuthRequestSuccess({
      data: { user: { id: userId }, session: { id: "session" } },
      response: new Response("{}"),
      request: {
        url: "https://auth.test/get-session",
        headers: { Authorization: `Bearer ${state.token}` },
        openWhisprAuthGeneration: generation,
      },
    });
    assert.equal(auth.commitValidatedAuthContext(generation, userId), true);
  };
  if (validated) await validate("account-a", 1);
  const { createSearchNotesTool } = await import("../../src/services/tools/searchNotesTool.ts");
  const { executeTool } = await import("../../src/services/tools/ToolRegistry.ts");
  const tool = createSearchNotesTool({
    useCloudSearch: true,
    scopeSpaceIds: teams.map((team) => team.id),
  });
  let completion;
  const execute = tool.execute;
  tool.execute = (...args) => (completion = execute(...args));
  return {
    requests,
    attempts,
    validate,
    run: (signal) => executeTool(tool, { query: QUERY }, { signal }),
    completed: () => completion,
  };
}

test("an aborted cloud search cannot publish after another account signs in", async (t) => {
  const batch = deferred();
  const started = deferred();
  const f = await setup(t, {
    respond: async (_request, count) => {
      if (count === 1) started.resolve();
      await batch.promise;
      return new Response(JSON.stringify({ notes: [] }));
    },
  });
  const controller = new AbortController();
  const result = f.run(controller.signal);
  await started.promise;
  controller.abort();
  assert.equal((await result).success, false);
  await f.validate("account-b", 2);
  batch.resolve();
  await f.completed();
  assert.equal(f.requests.length, 1);
  assert.ok(f.requests.every((request) => request.authorization === "Bearer token-a"));
  assert.equal(f.attempts.length, 1, "one cloud request only");
});

test("main rejects a replacement account between renderer checks and IPC dispatch", async (t) => {
  let f;
  f = await setup(t, {
    beforeIpc: async (_options, count) => {
      if (count === 1) await f.validate("account-b", 2);
    },
  });
  const result = await f.run(new AbortController().signal);
  assert.equal(f.requests.length, 0, "no old query reaches the replacement bearer");
  assert.ok(f.attempts.every((request) => request.expectedAuthGeneration === 1));
  assert.ok(f.requests.every((request) => request.authorization === "Bearer token-a"));
  assert.equal(result.success, false, "a changed account receives no old result");
});

for (const validated of [true, false]) {
  test(`account changes during the initial space read cannot adopt new credentials (${validated})`, async (t) => {
    const f = await setup(t, { validated });
    const spaces = deferred();
    const original = globalThis.window.electronAPI.getSpaces;
    globalThis.window.electronAPI.getSpaces = () => spaces.promise;
    const result = f.run(new AbortController().signal);
    await f.validate("account-b", 2);
    spaces.resolve(await original());
    assert.equal((await result).success, false);
    assert.deepEqual(f.requests, []);
  });
}

for (const phase of ["spaces", "semantic", "keyword", "protect"]) {
  test(`cancellation during ${phase} prevents fallback and result publication`, async (t) => {
    const { createSearchNotesTool } = await import("../../src/services/tools/searchNotesTool.ts");
    const f = await setup(t);
    const controller = new AbortController();
    const reads = [];
    const api = globalThis.window.electronAPI;
    const methods = {
      spaces: "getSpaces",
      semantic: "semanticSearchNotes",
      keyword: "searchNotes",
    };
    for (const [name, method] of Object.entries(methods)) {
      const original = api[method];
      api[method] = async (...args) => {
        reads.push(name);
        if (name === phase) controller.abort();
        return original(...args);
      };
    }
    const protectNotes = async () => {
      reads.push("protect");
      if (phase === "protect") controller.abort();
    };
    const tool = createSearchNotesTool({
      useCloudSearch: true,
      scopeSpaceIds: [100],
      protectNotes,
    });
    const result = await tool.execute({ query: QUERY }, { signal: controller.signal });
    assert.equal(result.success, false);
    assert.equal(result.data, null);
    assert.equal(reads.at(-1), phase);
    assert.equal(f.requests.length, phase === "spaces" ? 0 : 1);
  });
}

test("a single cloud request pins both account generation and exact scope", async (t) => {
  const f = await setup(t, {
    respond: async () =>
      new Response(
        JSON.stringify({
          notes: [
            { id: "note-first", title: "First", content: "body", score: 0.4, space_id: "team-10" },
            { id: "note-second", title: "Second", content: "body", score: 0.9, space_id: "team-0" },
          ],
        })
      ),
  });
  const result = await f.run(new AbortController().signal);
  assert.equal(result.success, true);
  assert.equal(f.requests.length, 1);
  assert.equal(f.requests[0].authorization, "Bearer token-a");
  assert.equal(f.attempts[0].expectedAuthGeneration, 1);
  assert.deepEqual(f.requests[0].body, {
    query: QUERY,
    limit: 5,
    scope: "all",
    space_ids: Array.from({ length: 11 }, (_, index) => `team-${index}`),
    private_workspace_id: null,
  });
  assert.deepEqual(
    result.data.map((note) => note.title),
    ["First", "Second"]
  );
});

test("an unvalidated search uses only local fallback", async (t) => {
  const f = await setup(t, { validated: false });
  const result = await f.run(new AbortController().signal);
  assert.equal(result.success, true);
  assert.deepEqual(result.data, []);
  assert.deepEqual(f.requests, []);
});

test("a previously cancelled call does not read spaces", async (t) => {
  const f = await setup(t);
  let reads = 0;
  globalThis.window.electronAPI.getSpaces = async () => {
    reads++;
    return [];
  };
  const controller = new AbortController();
  controller.abort();
  assert.equal((await f.run(controller.signal)).success, false);
  assert.equal(reads, 0);
});

test("cancellation while resolving cloud note links suppresses the result", async (t) => {
  const f = await setup(t, {
    teamCount: 1,
    respond: async (request) =>
      new Response(
        JSON.stringify({
          notes: [
            { id: "cloud-note", content: "body", score: 1, space_id: request.body.space_ids[0] },
          ],
        })
      ),
  });
  const controller = new AbortController();
  globalThis.window.electronAPI.getNoteForCloudRow = async () => {
    controller.abort();
    return { id: 1, space_id: 100 };
  };
  await f.run(controller.signal);
  assert.equal((await f.completed()).success, false);
  assert.equal(f.requests.length, 1);
});

test("NotesService keeps its unpinned call signature and fences an explicit old generation", async (t) => {
  const f = await setup(t);
  const { NotesService } = await import("../../src/services/NotesService.ts");
  await NotesService.search("current account query", 5, undefined, "team-0");
  assert.equal(f.requests.length, 1);
  assert.equal(f.requests[0].authorization, "Bearer token-a");
  await f.validate("account-b", 2);
  await assert.rejects(NotesService.search(QUERY, 5, undefined, "team-0", 1), {
    code: "AUTH_CONTEXT_CHANGED",
  });
  assert.equal(f.requests.length, 1, "the explicitly pinned query never leaves under B");
});
