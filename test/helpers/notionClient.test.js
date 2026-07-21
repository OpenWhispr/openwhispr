const test = require("node:test");
const assert = require("node:assert/strict");

const {
  NOTION_API_VERSION,
  NotionClient,
  findTitleProperty,
  normalizeUuid,
} = require("../../src/helpers/notionClient");

function response(status, data, headers = {}) {
  return {
    status,
    ok: status >= 200 && status < 300,
    headers: { get: (name) => headers[name.toLowerCase()] ?? null },
    json: async () => data,
  };
}

test("retries 429 responses using Retry-After and sends the current API version", async () => {
  const calls = [];
  const waits = [];
  const client = new NotionClient(
    { refresh: async () => "access-token" },
    {
      fetch: async (url, options) => {
        calls.push({ url, options });
        return calls.length === 1
          ? response(429, { code: "rate_limited" }, { "retry-after": "2" })
          : response(200, { object: "list", results: [] });
      },
      sleep: async (milliseconds) => waits.push(milliseconds),
    }
  );

  await client.request(1, "/search", { method: "POST", body: {} });
  assert.equal(calls.length, 2);
  assert.deepEqual(waits, [2000]);
  assert.equal(calls[0].options.headers["Notion-Version"], NOTION_API_VERSION);
  assert.equal(calls[0].options.headers.Authorization, "Bearer access-token");
  assert.equal(calls[0].options.useSessionCookies, false);
});

test("refreshes once and retries after a 401", async () => {
  const refreshCalls = [];
  const authHeaders = [];
  const client = new NotionClient(
    {
      refresh: async (_id, options) => {
        refreshCalls.push(options || {});
        return options?.force ? "rotated-token" : "initial-token";
      },
    },
    {
      fetch: async (_url, options) => {
        authHeaders.push(options.headers.Authorization);
        return authHeaders.length === 1
          ? response(401, { code: "unauthorized" })
          : response(200, { ok: true });
      },
      sleep: async () => {},
    }
  );

  assert.deepEqual(await client.request(7, "/users/me"), { ok: true });
  assert.deepEqual(authHeaders, ["Bearer initial-token", "Bearer rotated-token"]);
  assert.deepEqual(refreshCalls, [{}, { force: true }]);
});

test("does not replay a mutation when the outcome is unknown", async () => {
  let calls = 0;
  const waits = [];
  const client = new NotionClient(
    { refresh: async () => "access-token" },
    {
      fetch: async () => {
        calls += 1;
        throw new Error("connection reset after upload");
      },
      sleep: async (milliseconds) => waits.push(milliseconds),
    }
  );

  await assert.rejects(
    () =>
      client.createPage(1, {
        dataSourceId: "source",
        titleProperty: "Name",
        title: "Page title",
      }),
    (error) => error.code === "OUTCOME_UNKNOWN" && error.outcomeUnknown === true
  );
  assert.equal(calls, 1);
  assert.deepEqual(waits, []);
});

test("uses exponential backoff when a retryable response has no Retry-After header", async () => {
  const waits = [];
  let calls = 0;
  const client = new NotionClient(
    { refresh: async () => "access-token" },
    {
      fetch: async () => {
        calls += 1;
        return calls === 1
          ? response(503, { code: "service_unavailable" })
          : response(200, { ok: true });
      },
      sleep: async (milliseconds) => waits.push(milliseconds),
    }
  );

  assert.deepEqual(await client.request(1, "/users/me"), { ok: true });
  assert.deepEqual(waits, [500]);
});

test("normalizes database URLs and finds the live title property", () => {
  assert.equal(
    normalizeUuid("https://www.notion.so/workspace/0123456789abcdef0123456789abcdef?v=abc"),
    "01234567-89ab-cdef-0123-456789abcdef"
  );
  assert.deepEqual(
    findTitleProperty({
      properties: { Name: { id: "title", type: "title" }, Tags: { type: "multi_select" } },
    }),
    { name: "Name", id: "title" }
  );
});

test("creates pages under a data source with only the live title property", async () => {
  let request;
  const client = new NotionClient(
    { refresh: async () => "token" },
    {
      fetch: async (url, options) => {
        request = { url, options, body: JSON.parse(options.body) };
        return response(200, { id: "page", url: "https://notion.so/page" });
      },
      sleep: async () => {},
    }
  );

  await client.createPage(1, {
    dataSourceId: "source",
    titleProperty: "Name",
    title: "Page title",
  });

  assert.equal(request.url.endsWith("/pages"), true);
  assert.deepEqual(request.body.parent, { data_source_id: "source" });
  assert.deepEqual(Object.keys(request.body.properties), ["Name"]);
  assert.equal(request.body.properties.Name.title[0].text.content, "Page title");
  assert.equal("type" in request.body.properties.Name, false);
});
