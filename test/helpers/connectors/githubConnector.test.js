const test = require("node:test");
const assert = require("node:assert/strict");
const {
  NOW,
  CONNECTED,
  BINDING,
  fakeGithubFetch,
  json,
  reset,
  offline,
  hang,
  memoryCredentials,
} = require("./githubFixtures");
const { REFETCH_AFTER_MS } = require("../../../src/helpers/connectors/githubInstallations.js");

const INSTALLATIONS = "GET /user/installations";
const REPOSITORIES = "GET /user/installations/7/repositories";
const SEARCH = "GET /search/issues";
const LABELS = "GET /repos/acme/api/labels";
const CREATE = "POST /repos/acme/api/issues";
const ISSUE_45 = "GET /repos/acme/api/issues/45";
const COMMENT_45 = "POST /repos/acme/api/issues/45/comments";
const TOKEN = "POST /login/oauth/access_token";
const BOUND = { binding: BINDING };
const INSTALL_URL = "https://github.com/apps/openwhispr-dev/installations/new";

function repo(fullName, updatedAt) {
  const [owner, name] = fullName.split("/");
  return {
    name,
    full_name: fullName,
    owner: { login: owner },
    private: false,
    updated_at: updatedAt,
  };
}

// acme/api and dana/api share a bare name; most recently updated first is
// acme/api, dana/api, acme/web.
const INSTALLED_REPOS = [
  repo("acme/web", "2026-09-20T10:00:00Z"),
  repo("acme/api", "2026-09-27T10:00:00Z"),
  repo("dana/api", "2026-09-25T10:00:00Z"),
];
const installedScript = (repos = INSTALLED_REPOS) => ({
  [INSTALLATIONS]: [json({ total_count: 1, installations: [{ id: 7 }] })],
  [REPOSITORIES]: [json({ total_count: repos.length, repositories: repos })],
});
const NOTHING_INSTALLED = { [INSTALLATIONS]: [json({ total_count: 0, installations: [] })] };

function searchHit(fullName, number, extra = {}) {
  return {
    repository_url: `https://api.github.com/repos/${fullName}`,
    number,
    title: `Timeout on login ${number}`,
    state: "open",
    html_url: `https://github.com/${fullName}/issues/${number}`,
    updated_at: "2026-09-27T14:03:00Z",
    user: { login: "sam", email: "sam@example.test" },
    assignee: null,
    labels: [{ name: "bug" }],
    body: "Steps to reproduce",
    ...extra,
  };
}
const searchPage = (items, total = items.length) =>
  json({ total_count: total, incomplete_results: false, items });
const ISSUE = json({
  number: 45,
  title: "Timeout on login",
  state: "open",
  locked: false,
  html_url: "https://github.com/acme/api/issues/45",
});
const PULL = json({
  number: 45,
  title: "Fix the login timeout",
  state: "open",
  locked: false,
  html_url: "https://github.com/acme/api/pull/45",
  pull_request: { url: "https://api.github.com/repos/acme/api/pulls/45", merged_at: null },
});
const CREATED = json(
  { number: 212, html_url: "https://github.com/acme/api/issues/212", title: "Login times out" },
  201
);
const COMMENTED = json(
  { id: 9001, html_url: "https://github.com/acme/api/issues/45#issuecomment-9001" },
  201
);
const REFRESHED = json({
  access_token: "ghu-2",
  expires_in: 28800,
  refresh_token: "ghr-2",
  refresh_token_expires_in: 15897600,
  token_type: "bearer",
});
const UNAUTHORIZED = json({ message: "Bad credentials" }, 401);
const OTHER_LOGIN = { ...CONNECTED, userId: 43, login: "sam", accessToken: "ghu-other" };

async function setupGithub(
  script = {},
  {
    credential = CONNECTED,
    clientId = "Iv1.test-client",
    slug = "openwhispr-dev",
    statusTimeoutMs,
    clock = { now: NOW },
  } = {}
) {
  const [
    connectorModule,
    { createGithubApi },
    { createGithubAuth },
    { createGithubInstallations },
  ] = await Promise.all([
    import("../../../src/helpers/connectors/githubConnector.js"),
    import("../../../src/helpers/connectors/githubApi.js"),
    import("../../../src/helpers/connectors/githubAuth.js"),
    import("../../../src/helpers/connectors/githubInstallations.js"),
  ]);
  const github = fakeGithubFetch({ ...installedScript(), ...script });
  const statusChanges = [];
  const api = createGithubApi({
    fetchImpl: github.fetchImpl,
    sleep: async () => {},
    now: () => NOW,
  });
  const credentials = memoryCredentials(credential, { connectorId: "github" });
  const auth = createGithubAuth({
    api,
    credentials,
    getClientId: () => clientId,
    deviceFlow: {
      startDeviceAuthorization: async () => {
        throw new Error("not used in these tests");
      },
      pollForToken: async () => {
        throw new Error("not used in these tests");
      },
    },
    now: () => NOW,
  });
  const connector = connectorModule.createGithubConnector({
    api,
    auth,
    installations: createGithubInstallations({ api, now: () => clock.now }),
    credentials,
    getSlug: () => slug,
    notifyStatusChanged: () => statusChanges.push(Date.now()),
    ...(statusTimeoutMs === undefined ? {} : { statusTimeoutMs }),
  });
  return { connector, github, credentials, statusChanges, ...connectorModule };
}

// The status's repository count is read in the background; with the fake
// fetch answering in microtasks, one timer tick lets that read land.
const countReadLands = () => new Promise((resolve) => setTimeout(resolve, 20));

const hits = (github, key) => github.calls.filter((call) => `${call.method} ${call.path}` === key);
// How long `q` is in the request's query string.
const sentLength = (q) => new URLSearchParams({ q }).toString().length;
const writes = (github) => github.calls.filter((call) => call.method === "POST");
const slot = (credentials) => credentials.read("acct-1", "github").credential;

async function prepareIssue(connector, args = {}) {
  const prepared = await connector.prepare(
    "create_issue",
    { repo: "acme/api", title: "Login times out", body: "After 30 s.", ...args },
    BOUND
  );
  assert.equal(prepared.status, "ready", JSON.stringify(prepared));
  return prepared;
}

async function prepareComment(connector, args = {}) {
  const prepared = await connector.prepare(
    "comment",
    { target: "acme/api#45", body: "Looking into it.", ...args },
    BOUND
  );
  assert.equal(prepared.status, "ready", JSON.stringify(prepared));
  return prepared;
}

// --- declaration and parsing ---

test("GitHub declares one query and two approval actions with their editable fields", async () => {
  const { connector, MAX_TITLE_LENGTH, MAX_BODY_LENGTH, MAX_LABELS, MAX_RESULTS, SNIPPET_LENGTH } =
    await setupGithub();

  assert.equal(connector.id, "github");
  assert.deepEqual(connector.actions, {
    search_issues: { kind: "query" },
    create_issue: { kind: "approval", editable: { title: "line", body: "text" } },
    comment: { kind: "approval", editable: { body: "text" } },
  });
  assert.deepEqual(
    [MAX_TITLE_LENGTH, MAX_BODY_LENGTH, MAX_LABELS, MAX_RESULTS, SNIPPET_LENGTH],
    [256, 65536, 10, 10, 300]
  );
});

test("parseGithubTarget reads owner/repo#12 and github.com issue and pull links", async () => {
  const { parseGithubTarget } = await setupGithub();
  const acme12 = { ok: true, owner: "acme", repo: "api", number: 12 };

  for (const input of [
    "acme/api#12",
    " acme/api#12 ",
    "https://github.com/acme/api/issues/12",
    "https://github.com/acme/api/pull/12",
    "https://github.com/acme/api/pull/12/files",
    "https://github.com/acme/api/issues/12#issuecomment-1",
    "https://github.com/acme/api/pull/12?diff=split",
    "https://GitHub.com/acme/api/issues/12",
  ]) {
    assert.deepEqual(parseGithubTarget(input), acme12, input);
  }
  assert.deepEqual(parseGithubTarget("my-org/my.repo_2#7"), {
    ok: true,
    owner: "my-org",
    repo: "my.repo_2",
    number: 7,
  });
  for (const input of [
    "",
    null,
    42,
    "acme/api",
    "acme/api#",
    "acme/api#0",
    "acme/api#12a",
    "#12",
    "api#12",
    "acme/api/extra#12",
    "acme/..#12",
    "http://github.com/acme/api/issues/12",
    "https://gitlab.com/acme/api/issues/12",
    "https://github.com.evil.test/acme/api/issues/12",
    "https://user@github.com/acme/api/issues/12",
    "https://github.com/acme/api/commit/12",
    "https://github.com/acme/api/issues",
    "https://github.com/acme/api/issues/abc",
  ]) {
    assert.deepEqual(
      parseGithubTarget(input),
      { ok: false, errorCode: "invalid_reference" },
      String(input)
    );
  }
});

test("buildSearchQuery drops the user's repo:, org: and user: qualifiers and keeps the rest", async () => {
  const { buildSearchQuery } = await setupGithub();

  const built = buildSearchQuery({
    query: 'timeout repo:evil/secret -org:acme USER:someone repo:"x y" label:bug author:sam',
    type: "pr",
    state: "open",
    repos: ["acme/api"],
  });

  assert.deepEqual(built, {
    ok: true,
    q: "timeout label:bug author:sam is:pull-request state:open repo:acme/api",
    repos: ["acme/api"],
    truncated: false,
  });
  assert.equal(
    buildSearchQuery({ query: "crash", type: "issue", state: "all", repos: ["a/b"] }).q,
    "crash is:issue repo:a/b"
  );
  // A NOT left in front of a removed qualifier would negate the next word.
  assert.equal(
    buildSearchQuery({
      query: "crash NOT repo:evil/secret label:bug",
      type: "issue",
      repos: ["a/b"],
    }).q,
    "crash label:bug is:issue state:open repo:a/b"
  );
  assert.equal(
    buildSearchQuery({ query: "crash", type: "pr", repos: ["a/b"] }).q,
    "crash is:pull-request state:open repo:a/b"
  );
});

test("buildSearchQuery removes a scope qualifier in a group and leaves no operator dangling", async () => {
  const { buildSearchQuery } = await setupGithub();
  const words = (query) =>
    buildSearchQuery({ query, type: "issue", state: "all", repos: ["a/b"] }).q.replace(
      / is:issue repo:a\/b$/,
      ""
    );

  for (const [query, expected] of [
    ["(repo:evil/x) login", "login"],
    ["login (repo:evil/x)", "login"],
    ["login OR repo:evil/x", "login"],
    ["repo:evil/x OR login", "login"],
    ["repo:evil/x AND login", "login"],
    ["login AND repo:evil/x AND crash", "login AND crash"],
    ["login OR repo:evil/x OR crash", "login OR crash"],
    ["login (repo:evil/x OR crash)", "login ( crash)"],
    ["login (crash OR repo:evil/x)", "login (crash )"],
    ["login NOT (repo:evil/x) crash", "login crash"],
    ["login -(org:evil) crash", "login crash"],
    ["(NOT repo:evil/x) login", "login"],
    ["(repo:a/x OR org:evil) AND login", "login"],
    ['(repo:"evil/x") login', "login"],
    // Lower case "or" is a word to GitHub, so it stays.
    ["works or repo:evil/x", "works or"],
  ]) {
    assert.equal(words(query), expected, query);
    assert.doesNotMatch(words(query), /repo:|org:/, query);
  }
});

test("buildSearchQuery leaves a quoted phrase as written", async () => {
  const { buildSearchQuery } = await setupGithub();
  const q = (query) => buildSearchQuery({ query, type: "issue", state: "all", repos: ["a/b"] }).q;

  assert.equal(
    q('"quoted repo:a/b phrase" crash'),
    '"quoted repo:a/b phrase" crash is:issue repo:a/b'
  );
  assert.equal(q('"fails (sometimes" crash'), '"fails (sometimes" crash is:issue repo:a/b');
  // A quote left open would make the qualifiers added after it one phrase,
  // and hide a scope qualifier inside it.
  assert.equal(q('crash "repo:evil/x'), "crash is:issue repo:a/b");
  assert.equal(q('"login page" "timeout'), '"login page" timeout is:issue repo:a/b');
});

test("buildSearchQuery keeps the tool's type over one the query names", async () => {
  const { buildSearchQuery } = await setupGithub();
  const q = (query, type) => buildSearchQuery({ query, type, state: "all", repos: ["a/b"] }).q;

  for (const query of [
    "crash is:pr",
    "crash IS:PULL-REQUEST",
    "crash type:pr",
    "crash -is:issue",
  ]) {
    assert.equal(q(query, "issue"), "crash is:issue repo:a/b", query);
  }
  assert.equal(q("crash is:issue", "pr"), "crash is:pull-request repo:a/b");
  assert.equal(q("(is:pr OR label:bug) crash", "issue"), "( label:bug) crash is:issue repo:a/b");
  // Only the type: is:prime is a word, and other is: qualifiers pass.
  assert.equal(
    q("crash is:prime is:locked", "issue"),
    "crash is:prime is:locked is:issue repo:a/b"
  );
});

test("buildSearchQuery leaves no parenthesis without its pair", async () => {
  const { buildSearchQuery } = await setupGithub();
  const words = (query) =>
    buildSearchQuery({ query, type: "issue", state: "all", repos: ["a/b"] }).q.replace(
      / is:issue repo:a\/b$/,
      ""
    );

  for (const [query, expected] of [
    ["crash repo:evil/x)", "crash"],
    ["crash) login", "crash login"],
    ["(crash OR login", "crash OR login"],
    ["(crash OR (login) timeout", "crash OR (login) timeout"],
    ["(crash repo:evil/x) login", "(crash ) login"],
    ["crash repo:evil(x login)", "crash login"],
  ]) {
    assert.equal(words(query), expected, query);
  }
});

test("buildSearchQuery adds state:open only when the query names no state of its own", async () => {
  const { buildSearchQuery } = await setupGithub();
  const q = (query) => buildSearchQuery({ query, type: "pr", repos: ["a/b"] }).q;

  for (const query of [
    "crash is:closed",
    "crash IS:MERGED",
    "crash is:unmerged",
    "crash is:open",
    "crash state:closed",
    "crash -is:open",
    "(is:closed OR is:merged) crash",
  ]) {
    assert.equal(q(query), `${query} is:pull-request repo:a/b`, query);
  }
  for (const query of ["crash is:locked", "crash label:state:closed", "crash is:closedish"]) {
    assert.equal(q(query), `${query} is:pull-request state:open repo:a/b`, query);
  }
});

test("buildSearchQuery names repos in the order given until q would pass the request budget", async () => {
  const { buildSearchQuery } = await setupGithub();
  // GitHub's 256-character limit counts only the words: 30 installed repos
  // all fit, however long their qualifiers make q.
  const thirty = Array.from({ length: 30 }, (_, index) => `acme-organization/service-${index}`);
  const all = buildSearchQuery({ query: "login crash", type: "issue", repos: thirty });
  assert.deepEqual(all.repos, thirty);
  assert.equal(all.truncated, false);
  assert.ok(all.q.length > 256);

  const repos = Array.from({ length: 300 }, (_, index) => `acme-organization/service-${index}`);
  const built = buildSearchQuery({ query: "timeout", type: "issue", repos });

  assert.equal(built.ok, true);
  assert.equal(built.truncated, true);
  // The budget is the request URL's, so q counts as the query string sends it.
  assert.ok(sentLength(built.q) <= 4900, `${sentLength(built.q)}`);
  assert.deepEqual(built.repos, repos.slice(0, built.repos.length));
  assert.ok(built.repos.length > 30 && built.repos.length < 300);
  // The next repo would not have fitted.
  assert.ok(sentLength(`${built.q} repo:${repos[built.repos.length]}`) > 4900);
  // The query string encodes ! ' ( ) ~ as three characters each, which
  // encodeURIComponent leaves as one: that's what the request carries.
  assert.deepEqual(
    buildSearchQuery({ query: "!".repeat(1630), type: "issue", repos: ["acme/api"] }),
    { ok: false, errorCode: "too_long" }
  );

  // Six encoded bytes per character: 900 of them fit no repo, though q is
  // far shorter than the budget unencoded.
  const wide = buildSearchQuery({ query: "ü".repeat(900), type: "issue", repos: ["acme/api"] });
  // A search that leaves no room for even one repo would span every repo the
  // user can see, so it is refused instead.
  assert.deepEqual(wide, { ok: false, errorCode: "too_long" });
  assert.equal(
    buildSearchQuery({ query: "u".repeat(900), type: "issue", repos: ["acme/api"] }).ok,
    true
  );
});

// --- search ---

test("search scopes the query to the installed repos and returns compact results", async () => {
  const { connector, github } = await setupGithub({
    [SEARCH]: [
      searchPage([searchHit("acme/api", 45, { assignee: { login: "dana" } })]),
      searchPage([
        searchHit("dana/api", 7, {
          title: "Fix the timeout",
          state: "closed",
          html_url: "https://github.com/dana/api/pull/7",
          pull_request: { merged_at: "2026-09-26T09:00:00Z" },
          labels: ["auth", { name: "" }, { color: "fff" }],
        }),
        searchHit("acme/web", 3, {
          state: "closed",
          pull_request: { merged_at: null },
          body: null,
          user: null,
        }),
      ]),
    ],
  });

  const result = await connector.query("search_issues", { query: "timeout" }, BOUND);

  // A GitHub App user token can't search issues and pull requests together,
  // so a search for either is one of each.
  assert.deepEqual(
    hits(github, SEARCH).map((search) => search.query),
    ["is:issue", "is:pull-request"].map((type) => ({
      q: `timeout ${type} state:open repo:acme/api repo:dana/api repo:acme/web`,
      sort: "updated",
      order: "desc",
      per_page: "10",
    }))
  );
  assert.ok(hits(github, SEARCH).every((search) => search.authorization === "Bearer ghu-1"));
  assert.deepEqual(result, {
    status: "ok",
    truncated: false,
    items: [
      {
        reference: "acme/api#45",
        isPullRequest: false,
        title: "Timeout on login 45",
        state: "open",
        url: "https://github.com/acme/api/issues/45",
        updatedAt: "2026-09-27T14:03:00Z",
        assignee: "dana",
        author: "sam",
        labels: ["bug"],
        snippet: "Steps to reproduce",
      },
      {
        reference: "dana/api#7",
        isPullRequest: true,
        title: "Fix the timeout",
        state: "merged",
        url: "https://github.com/dana/api/pull/7",
        updatedAt: "2026-09-27T14:03:00Z",
        assignee: null,
        author: "sam",
        labels: ["auth"],
        snippet: "Steps to reproduce",
      },
      {
        reference: "acme/web#3",
        isPullRequest: true,
        title: "Timeout on login 3",
        state: "closed",
        url: "https://github.com/acme/web/issues/3",
        updatedAt: "2026-09-27T14:03:00Z",
        assignee: null,
        author: null,
        labels: ["bug"],
        snippet: "",
      },
    ],
  });
  // No email address from GitHub's user objects reaches the model.
  assert.doesNotMatch(JSON.stringify(result), /@example\.test/);
});

test("search results from repos the App isn't installed on are dropped", async () => {
  const { connector } = await setupGithub({
    [SEARCH]: [
      searchPage([
        searchHit("evil/secret", 1),
        searchHit("ACME/API", 2),
        searchHit("acme/api", 3, { repository_url: "https://api.github.com/repos/acme/api/extra" }),
        { ...searchHit("acme/api", 4), repository_url: undefined },
        searchHit("acme/api", 5),
      ]),
      searchPage([]),
    ],
  });

  const result = await connector.query("search_issues", { query: "timeout" }, BOUND);

  assert.deepEqual(
    result.items.map((item) => item.reference),
    ["acme/api#2", "acme/api#5"]
  );
});

test("snippets keep at most 300 characters, cut on a whole character, whitespace collapsed", async () => {
  const long = `${"a".repeat(298)}😀😀 tail`;
  const { connector } = await setupGithub({
    [SEARCH]: [
      searchPage([
        searchHit("acme/api", 1, { body: long, title: `  Spaced \n\n title ${"t".repeat(300)}` }),
        searchHit("acme/api", 2, { body: "line one\n\n  line two\t\tend" }),
      ]),
      searchPage([]),
    ],
  });

  const [first, second] = (await connector.query("search_issues", { query: "x" }, BOUND)).items;

  // Characters, as the spec counts them: an emoji is one, though two UTF-16
  // units.
  assert.equal([...first.snippet].length, 300);
  assert.equal(first.snippet, `${"a".repeat(298)}😀…`);
  assert.doesNotMatch(first.snippet, /[\uD800-\uDBFF](?![\uDC00-\uDFFF])/);
  assert.ok(first.title.length <= 256);
  assert.match(first.title, /^Spaced title t+…$/);
  assert.equal(second.snippet, "line one line two end");
});

test("an email address in a search result's title or body never reaches the model", async () => {
  const { connector } = await setupGithub({
    [SEARCH]: [
      searchPage([
        searchHit("acme/api", 1, {
          title: "Contact John.Doe+test@example.test about this",
          body: "mail sam@example.test for details, cc @alice",
        }),
      ]),
      searchPage([]),
    ],
  });

  const [item] = (await connector.query("search_issues", { query: "x" }, BOUND)).items;

  assert.equal(item.title, "Contact [email] about this");
  assert.equal(item.snippet, "mail [email] for details, cc @alice");
  assert.doesNotMatch(item.title, /@example\.test/);
  assert.doesNotMatch(item.snippet, /@example\.test/);
  // A GitHub mention has no local part before the @, so it stays as-is.
  assert.match(item.snippet, /@alice/);
});

test("an email address in a search result's label never reaches the model", async () => {
  const { connector } = await setupGithub({
    [SEARCH]: [
      searchPage([
        searchHit("acme/api", 1, { labels: [{ name: "owner: sam@example.test" }, "bug"] }),
      ]),
      searchPage([]),
    ],
  });

  const [item] = (await connector.query("search_issues", { query: "x" }, BOUND)).items;

  assert.deepEqual(item.labels, ["owner: [email]", "bug"]);
});

test("internationalized and full-width email addresses are redacted too", async () => {
  const { connector } = await setupGithub({
    [SEARCH]: [
      searchPage([
        searchHit("acme/api", 1, {
          title: "Ask josé@example.com",
          body: "or bob@exämple.com, or ｍａｒｙ＠example.com; left-pad@1.2.3 is a version",
        }),
      ]),
      searchPage([]),
    ],
  });

  const [item] = (await connector.query("search_issues", { query: "x" }, BOUND)).items;

  assert.equal(item.title, "Ask [email]");
  assert.equal(item.snippet, "or [email], or [email]; left-pad@1.2.3 is a version");
});

test("ten 65,536-character bodies built to slow the email redaction are read in well under a second", async () => {
  const hostile = ["a".repeat(65536), "a.".repeat(32768), `${"a".repeat(65000)}@x`];
  const page = searchPage(
    Array.from({ length: 10 }, (_, index) =>
      searchHit("acme/api", index + 1, { title: hostile[index % 3], body: hostile[index % 3] })
    )
  );
  const { connector } = await setupGithub({ [SEARCH]: [page, page] });

  const started = Date.now();
  const { items } = await connector.query("search_issues", { query: "x" }, BOUND);

  assert.ok(Date.now() - started < 1000, `${Date.now() - started} ms`);
  assert.equal(items.length, 10);
  assert.ok(items.every((item) => item.snippet.length <= 300 && item.title.length <= 256));
});

test("an address past the redacted window is never shown, and one inside it is redacted", async () => {
  const words = (count) => Array.from({ length: count }, () => "word").join(" ");
  const { connector } = await setupGithub({
    [SEARCH]: [
      searchPage([
        searchHit("acme/api", 1, { body: `${words(300)} late@example.test ${words(10)}` }),
        // Long addresses shrink to "[email]", so the excerpt reaches deep
        // into the window, up to the space it ends at.
        searchHit("acme/api", 2, {
          body: `${Array.from({ length: 40 }, (_, n) => `${"x".repeat(40)}${n}@example.test`).join(" ")} ${words(200)}`,
        }),
      ]),
      searchPage([]),
    ],
  });

  const [late, dense] = (await connector.query("search_issues", { query: "x" }, BOUND)).items;

  assert.equal(late.snippet, `${words(60)}…`);
  assert.ok(dense.snippet.length <= 300);
  // Cut short of the body, so it ends in "…" like any clipped snippet.
  assert.match(dense.snippet, /^(\[email\] )+\[email\]…$/);
  assert.doesNotMatch(dense.snippet, /@example\.test|x{5}/);
});

test("a named repo narrows the search to it, and the type and state reach the query", async () => {
  const { connector, github } = await setupGithub({ [SEARCH]: [searchPage([])] });

  const result = await connector.query(
    "search_issues",
    { query: "flaky test", repo: "ACME/API", type: "issue", state: "all" },
    BOUND
  );

  assert.deepEqual(result, { status: "ok", items: [], truncated: false });
  assert.equal(hits(github, SEARCH)[0].query.q, "flaky test is:issue repo:acme/api");
});

test("a search that can't name every installed repo says it was cut, and so does GitHub's own count", async () => {
  const many = Array.from({ length: 300 }, (_, index) =>
    repo(
      `acme-organization/service-${index}`,
      `2026-09-${String(28 - (index % 28)).padStart(2, "0")}T00:00:00Z`
    )
  );
  const cut = await setupGithub({ ...installedScript(many), [SEARCH]: [searchPage([])] });
  const result = await cut.connector.query("search_issues", { query: "timeout" }, BOUND);
  assert.equal(result.truncated, true);
  assert.ok(sentLength(hits(cut.github, SEARCH)[0].query.q) <= 4900);

  const more = await setupGithub({
    [SEARCH]: [searchPage([searchHit("acme/api", 1)], 57), searchPage([])],
  });
  assert.equal(
    (await more.connector.query("search_issues", { query: "x" }, BOUND)).truncated,
    true
  );
});

test("an ambiguous bare repo name is a question listing owner/name, with no search", async () => {
  const { connector, github } = await setupGithub();

  assert.deepEqual(await connector.query("search_issues", { query: "x", repo: "api" }, BOUND), {
    status: "needs_clarification",
    message: "Several installed repositories are named api. Ask the user which one.",
    candidates: ["acme/api", "dana/api"],
  });
  assert.equal(hits(github, SEARCH).length, 0);
});

test("a repo the App isn't installed on is named, with the install link, and not searched", async () => {
  const { connector, github } = await setupGithub();

  const result = await connector.query("search_issues", { query: "x", repo: "evil/secret" }, BOUND);

  assert.deepEqual(result, {
    status: "failed",
    errorCode: "not_installed",
    message: `The OpenWhispr GitHub App isn't installed on evil/secret. Tell the user to install it on that repository: ${INSTALL_URL}`,
  });
  assert.equal(hits(github, SEARCH).length, 0);

  const noSlug = await setupGithub({}, { slug: null });
  const plain = await noSlug.connector.query(
    "search_issues",
    { query: "x", repo: "evil/secret" },
    BOUND
  );
  assert.doesNotMatch(plain.message, /https:/);
  assert.match(plain.message, /Settings → Integrations → Connectors/);
});

test("with no installed repositories, search is refused with how to choose them", async () => {
  const { connector, github } = await setupGithub(NOTHING_INSTALLED);

  const result = await connector.query("search_issues", { query: "x" }, BOUND);

  assert.equal(result.status, "failed");
  assert.equal(result.errorCode, "no_repositories");
  assert.match(result.message, /choose repositories/);
  assert.equal(hits(github, SEARCH).length, 0);
});

test("a search with nothing to look for, too long, or an unknown state or type asks GitHub nothing", async () => {
  const { connector, github } = await setupGithub();

  assert.equal(
    (await connector.query("search_issues", { query: "  " }, BOUND)).status,
    "needs_clarification"
  );
  assert.equal((await connector.query("search_issues", {}, BOUND)).status, "needs_clarification");
  assert.equal(
    (await connector.query("search_issues", { query: "x".repeat(201) }, BOUND)).errorCode,
    "too_long"
  );
  // The model's own input, never GitHub's verdict.
  assert.equal(
    (await connector.query("search_issues", { query: "x", state: "closed" }, BOUND)).errorCode,
    "invalid_input"
  );
  assert.equal(
    (await connector.query("search_issues", { query: "x", type: "commit" }, BOUND)).errorCode,
    "invalid_input"
  );
  assert.equal(
    (await connector.query("list_repos", { query: "x" }, BOUND)).errorCode,
    "unknown_action"
  );
  assert.equal(github.calls.length, 0);
});

test("a 401 on search is refreshed once under the same login; a second means reconnect", async () => {
  const recovered = await setupGithub({
    [SEARCH]: [UNAUTHORIZED, searchPage([searchHit("acme/api", 1)])],
    [TOKEN]: [REFRESHED],
  });
  const result = await recovered.connector.query(
    "search_issues",
    { query: "x", type: "issue" },
    BOUND
  );
  assert.equal(result.items.length, 1);
  assert.deepEqual(
    hits(recovered.github, SEARCH).map((call) => call.authorization),
    ["Bearer ghu-1", "Bearer ghu-2"]
  );

  const gone = await setupGithub({ [SEARCH]: [UNAUTHORIZED], [TOKEN]: [REFRESHED] });
  const refused = await gone.connector.query("search_issues", { query: "x", type: "issue" }, BOUND);
  assert.equal(refused.errorCode, "reconnect_needed");
  assert.equal(slot(gone.credentials).needsReconnect, true);
  assert.equal(hits(gone.github, SEARCH).length, 2);
});

test("a search for either type merges the issue and pull-request searches, newest first, up to 10", async () => {
  const at = (day) => ({ updated_at: `2026-09-${day}T10:00:00Z` });
  const { connector } = await setupGithub({
    [SEARCH]: [
      searchPage(
        Array.from({ length: 6 }, (_, index) =>
          searchHit("acme/api", index + 1, at(10 + index * 2))
        )
      ),
      searchPage(
        Array.from({ length: 6 }, (_, index) =>
          searchHit("acme/api", index + 101, { ...at(11 + index * 2), pull_request: {} })
        )
      ),
    ],
  });

  const result = await connector.query("search_issues", { query: "x" }, BOUND);

  assert.deepEqual(
    result.items.map((item) => item.reference),
    [106, 6, 105, 5, 104, 4, 103, 3, 102, 2].map((number) => `acme/api#${number}`)
  );
  // Two results didn't fit.
  assert.equal(result.truncated, true);
});

test("a search for either type fails when either of its two searches does", async () => {
  const { connector } = await setupGithub({
    [SEARCH]: [searchPage([searchHit("acme/api", 1)]), json({ message: "Validation Failed" }, 422)],
  });

  const result = await connector.query("search_issues", { query: "x" }, BOUND);

  assert.equal(result.status, "failed");
  assert.equal(result.errorCode, "invalid");
});

test("a 401 on a token another request already replaced retries with the replacement, with no second refresh", async () => {
  const { connector, github, credentials } = await setupGithub({
    [SEARCH]: [
      {
        ...UNAUTHORIZED,
        // Another request's refresh lands while this one is out: GitHub has
        // already ended ghu-1 and handed out ghu-2.
        during: () =>
          credentials.save(
            "acct-1",
            "github",
            { ...CONNECTED, accessToken: "ghu-2", refreshToken: "ghr-2" },
            1
          ),
      },
      searchPage([searchHit("acme/api", 1)]),
    ],
    [TOKEN]: [REFRESHED],
  });

  const result = await connector.query("search_issues", { query: "x", type: "issue" }, BOUND);

  assert.equal(result.items.length, 1);
  assert.deepEqual(
    hits(github, SEARCH).map((call) => call.authorization),
    ["Bearer ghu-1", "Bearer ghu-2"]
  );
  // Refreshing again would have ended ghu-2 under the other request.
  assert.equal(hits(github, TOKEN).length, 0);
  assert.equal(slot(credentials).needsReconnect, false);
});

test("installations listing more repos than OpenWhispr reads mark a search cut, and a missing repo as maybe installed", async () => {
  const PAGED = {
    [INSTALLATIONS]: [json({ total_count: 1, installations: [{ id: 7 }] })],
    // Every page links to another, so restAll stops at its page cap.
    [REPOSITORIES]: [
      json({ total_count: 3000, repositories: INSTALLED_REPOS }, 200, {
        link: '<https://api.github.com/user/installations/7/repositories?page=2>; rel="next"',
      }),
    ],
  };
  const { connector } = await setupGithub({ ...PAGED, [SEARCH]: [searchPage([]), searchPage([])] });

  const searched = await connector.query("search_issues", { query: "x" }, BOUND);
  assert.equal(searched.truncated, true);

  // Its own code: the repo may be installed after all, so the message never
  // advises installing.
  const missing = await connector.query("search_issues", { query: "x", repo: "acme/far" }, BOUND);
  assert.equal(missing.errorCode, "repo_unlisted");
  assert.match(missing.message, /first 1,000 repositories/);
  assert.doesNotMatch(missing.message, /install it|https:/);
});

test("a rate-limited or unreachable search fails with its code", async () => {
  const limited = await setupGithub({
    [SEARCH]: [
      json({ message: "API rate limit exceeded" }, 403, {
        "x-ratelimit-remaining": "0",
        "retry-after": "60",
      }),
    ],
  });
  assert.equal(
    (await limited.connector.query("search_issues", { query: "x" }, BOUND)).errorCode,
    "rate_limited"
  );

  const down = await setupGithub({ [SEARCH]: [offline()] });
  const result = await down.connector.query("search_issues", { query: "x" }, BOUND);
  assert.equal(result.status, "failed");
  assert.equal(result.errorCode, "network");
  assert.equal(result.message, "Couldn't reach GitHub.");
});

test("a search GitHub answers 422 reads the installed repos fresh and searches once more", async () => {
  const INVALID = json({ message: "Validation Failed" }, 422);
  // acme/web was unticked on the install page after the cached list was read.
  const unticked = [
    json({ total_count: 3, repositories: INSTALLED_REPOS }),
    json({
      total_count: 2,
      repositories: INSTALLED_REPOS.filter((entry) => entry.full_name !== "acme/web"),
    }),
  ];

  const recovered = await setupGithub({
    [REPOSITORIES]: unticked,
    [SEARCH]: [INVALID, searchPage([searchHit("acme/api", 1)])],
  });
  const result = await recovered.connector.query(
    "search_issues",
    { query: "x", type: "issue" },
    BOUND
  );
  assert.equal(result.status, "ok");
  assert.equal(result.items.length, 1);
  assert.deepEqual(
    hits(recovered.github, SEARCH).map((search) => search.query.q),
    [
      "x is:issue state:open repo:acme/api repo:dana/api repo:acme/web",
      "x is:issue state:open repo:acme/api repo:dana/api",
    ]
  );
  assert.equal(hits(recovered.github, REPOSITORIES).length, 2);

  // A query GitHub refuses whatever the repos is refused after one retry.
  const refused = await setupGithub({ [SEARCH]: [INVALID] });
  assert.equal(
    (await refused.connector.query("search_issues", { query: "x", type: "issue" }, BOUND))
      .errorCode,
    "invalid"
  );
  assert.equal(hits(refused.github, SEARCH).length, 2);
  assert.equal(hits(refused.github, REPOSITORIES).length, 2);

  // A named repo is looked for in the fresh list, which no longer has it.
  const named = await setupGithub({ [REPOSITORIES]: unticked, [SEARCH]: [INVALID] });
  const missing = await named.connector.query(
    "search_issues",
    { query: "x", type: "issue", repo: "acme/web" },
    BOUND
  );
  assert.equal(missing.errorCode, "not_installed");
  assert.equal(hits(named.github, SEARCH).length, 1);
});

test("a search GitHub fails with a 5xx says GitHub had a problem, never that it refused", async () => {
  const { connector } = await setupGithub({ [SEARCH]: [json({ message: "Server Error" }, 502)] });

  const result = await connector.query("search_issues", { query: "x", type: "issue" }, BOUND);

  assert.equal(result.errorCode, "http_502");
  assert.equal(result.message, "GitHub had a problem answering. Try again later.");
});

// --- create_issue ---

test("prepare shows the issue card, with the repo's own labels and the ones it doesn't have", async () => {
  const { connector, github } = await setupGithub({
    [LABELS]: [json([{ name: "bug" }, { name: "Auth" }, { name: "docs" }])],
  });

  const prepared = await prepareIssue(connector, {
    title: "Login\ntimes out\r\n",
    labels: ["BUG", "auth", "urgent", "bug", " ", 7],
  });

  assert.deepEqual(prepared, {
    status: "ready",
    payload: {
      owner: "acme",
      repo: "api",
      title: "Login times out",
      body: "After 30 s.",
      labels: ["bug", "Auth"],
    },
    preview: {
      verbKey: "issue",
      destinationLabel: "acme/api",
      accountLabel: "@dana",
      body: "After 30 s.",
      fields: { title: "Login times out", body: "After 30 s." },
      notes: [
        { key: "connectors.approval.issue.notes.labels", values: { labels: "bug, Auth" } },
        {
          key: "connectors.approval.issue.notes.droppedLabels",
          values: { destination: "acme/api", labels: "urgent" },
        },
        { key: "connectors.approval.github.notes.labelsMayNotApply" },
      ],
    },
  });
  assert.equal(hits(github, LABELS)[0].query.per_page, "100");
  assert.equal(writes(github).length, 0);
});

test("someone who can push to the repo gets no 'labels may not apply' note", async () => {
  const { connector } = await setupGithub({
    ...installedScript(
      INSTALLED_REPOS.map((entry) =>
        entry.full_name === "acme/api" ? { ...entry, permissions: { push: true } } : entry
      )
    ),
    [LABELS]: [json([{ name: "bug" }])],
  });

  const prepared = await prepareIssue(connector, { labels: ["bug"] });

  assert.deepEqual(prepared.payload.labels, ["bug"]);
  assert.equal(
    prepared.preview.notes.some(
      (note) => note.key === "connectors.approval.github.notes.labelsMayNotApply"
    ),
    false
  );
});

test("after a 'not installed' answer, installing the App and asking again works without waiting out the cache", async () => {
  const onlyWeb = [repo("acme/web", "2026-09-20T10:00:00Z")];
  const script = () => ({
    [REPOSITORIES]: [
      json({ total_count: 1, repositories: onlyWeb }),
      json({ total_count: 3, repositories: INSTALLED_REPOS }),
    ],
    [ISSUE_45]: [ISSUE],
    [SEARCH]: [searchPage([searchHit("acme/api", 45)]), searchPage([])],
  });
  // The user installs the App from the refusal's link and asks again.
  const later = (clock) => {
    clock.now += 5000;
  };

  const createClock = { now: NOW };
  const created = await setupGithub(script(), { clock: createClock });
  assert.equal(
    (
      await created.connector.prepare(
        "create_issue",
        { repo: "acme/api", title: "Login times out" },
        BOUND
      )
    ).errorCode,
    "not_installed"
  );
  later(createClock);
  await prepareIssue(created.connector);

  const commentClock = { now: NOW };
  const commented = await setupGithub(script(), { clock: commentClock });
  assert.equal(
    (await commented.connector.prepare("comment", { target: "acme/api#45", body: "x" }, BOUND))
      .errorCode,
    "not_installed"
  );
  later(commentClock);
  await prepareComment(commented.connector);

  const searchClock = { now: NOW };
  const searched = await setupGithub(
    {
      [INSTALLATIONS]: [
        json({ total_count: 0, installations: [] }),
        json({ total_count: 1, installations: [{ id: 7 }] }),
      ],
      [SEARCH]: [searchPage([searchHit("acme/api", 45)]), searchPage([])],
    },
    { clock: searchClock }
  );
  assert.equal(
    (await searched.connector.query("search_issues", { query: "login" }, BOUND)).errorCode,
    "no_repositories"
  );
  later(searchClock);
  assert.equal(
    (await searched.connector.query("search_issues", { query: "login" }, BOUND)).items.length,
    1
  );
});

test("a repo unticked and ticked again on GitHub's page between prepare and Send still takes the issue", async () => {
  const clock = { now: NOW };
  const { connector, github } = await setupGithub(
    {
      [REPOSITORIES]: [
        json({ total_count: 3, repositories: INSTALLED_REPOS }),
        json({
          total_count: 2,
          repositories: INSTALLED_REPOS.filter((entry) => entry.full_name !== "acme/api"),
        }),
        json({ total_count: 3, repositories: INSTALLED_REPOS }),
      ],
      [CREATE]: [CREATED],
    },
    { clock }
  );
  const { payload } = await prepareIssue(connector);
  // Settings re-reads the list while acme/api is unticked.
  clock.now += REFETCH_AFTER_MS;
  await connector.getStatus();
  await countReadLands();
  clock.now += REFETCH_AFTER_MS;

  assert.equal((await connector.commit("create_issue", payload, {}, BOUND)).state, "sent");
  assert.equal(hits(github, CREATE).length, 1);
});

test("an archived repo takes no new issue or comment, at prepare or at Send", async () => {
  const archived = installedScript(
    INSTALLED_REPOS.map((entry) =>
      entry.full_name === "acme/api" ? { ...entry, archived: true } : entry
    )
  );
  const ARCHIVED = {
    status: "failed",
    errorCode: "archived",
    message: "acme/api is archived, so it can't take new issues or comments.",
  };

  const issue = await setupGithub(archived);
  assert.deepEqual(
    await issue.connector.prepare("create_issue", { repo: "acme/api", title: "Crash" }, BOUND),
    ARCHIVED
  );
  const comment = await setupGithub(archived);
  assert.deepEqual(
    await comment.connector.prepare("comment", { target: "acme/api#45", body: "x" }, BOUND),
    ARCHIVED
  );

  // Archived between prepare and Send: the Settings re-read picks it up.
  const clock = { now: NOW };
  const later = await setupGithub(
    {
      [REPOSITORIES]: [
        json({ total_count: 3, repositories: INSTALLED_REPOS }),
        archived[REPOSITORIES][0],
      ],
      [CREATE]: [CREATED],
    },
    { clock }
  );
  const { payload } = await prepareIssue(later.connector);
  clock.now += REFETCH_AFTER_MS;
  await later.connector.getStatus();
  await countReadLands();
  const sent = await later.connector.commit("create_issue", payload, {}, BOUND);
  assert.equal(sent.errorCode, "archived");
  assert.equal(writes(later.github).length, 0);
  for (const setup of [issue, comment]) assert.equal(writes(setup.github).length, 0);
});

test("more than 10 labels are refused before any request, and no labels means no labels request", async () => {
  const names = Array.from({ length: 11 }, (_, index) => `label-${index}`);
  const many = await setupGithub({ [LABELS]: [json(names.map((name) => ({ name })))] });
  assert.deepEqual(
    await many.connector.prepare("create_issue", { title: "x", labels: names }, BOUND),
    {
      status: "failed",
      errorCode: "too_many_labels",
      message: "Pick at most 10 labels for one issue.",
    }
  );
  assert.equal(many.github.calls.length, 0);
  // Ten distinct names, however many repeats, are within the limit.
  const ten = await prepareIssue(many.connector, { labels: [...names.slice(0, 10), "LABEL-0"] });
  assert.deepEqual(ten.payload.labels, names.slice(0, 10));

  const plain = await setupGithub();
  const noLabels = await prepareIssue(plain.connector);
  assert.deepEqual(noLabels.payload.labels, []);
  assert.deepEqual(noLabels.preview.notes, []);
  assert.equal(hits(plain.github, LABELS).length, 0);
});

test("labels past the 1,000 GitHub listed are kept as asked, never reported missing", async () => {
  const page = json([{ name: "bug" }], 200, {
    link: '<https://api.github.com/repos/acme/api/labels?per_page=100&page=2>; rel="next"',
  });
  const { connector, github } = await setupGithub({ [LABELS]: [page] });

  const prepared = await prepareIssue(connector, { labels: ["BUG", "area/billing"] });

  assert.equal(hits(github, LABELS).length, 10);
  assert.deepEqual(prepared.payload.labels, ["bug", "area/billing"]);
  assert.deepEqual(prepared.preview.notes.slice(0, 1), [
    {
      key: "connectors.approval.issue.notes.labels",
      values: { labels: "bug, area/billing" },
    },
  ]);
  assert.equal(
    prepared.preview.notes.some(
      (note) => note.key === "connectors.approval.issue.notes.droppedLabels"
    ),
    false
  );
});

test("a labels read GitHub can't find is about the repo, never an issue or pull request", async () => {
  const { connector, github } = await setupGithub({
    [LABELS]: [json({ message: "Not Found" }, 404)],
  });

  assert.deepEqual(
    await connector.prepare(
      "create_issue",
      { repo: "acme/api", title: "x", labels: ["bug"] },
      BOUND
    ),
    {
      status: "failed",
      errorCode: "labels_unavailable",
      message:
        "Couldn't read the labels in acme/api. Try again, or create the issue without labels.",
    }
  );
  // Still installed: the installations were read again to tell.
  assert.equal(hits(github, INSTALLATIONS).length, 2);

  const removed = await setupGithub({
    [REPOSITORIES]: [
      json({ total_count: 3, repositories: INSTALLED_REPOS }),
      json({ total_count: 1, repositories: [repo("acme/web", "2026-09-20T10:00:00Z")] }),
    ],
    [LABELS]: [json({ message: "Not Found" }, 404)],
  });
  assert.equal(
    (
      await removed.connector.prepare(
        "create_issue",
        { repo: "acme/api", title: "x", labels: ["bug"] },
        BOUND
      )
    ).errorCode,
    "not_installed"
  );
});

test("a repo with issues turned off takes no new issue, at prepare or at Send", async () => {
  const issuesOff = installedScript(
    INSTALLED_REPOS.map((entry) =>
      entry.full_name === "acme/api" ? { ...entry, has_issues: false } : entry
    )
  );
  const DISABLED = {
    status: "failed",
    errorCode: "issues_disabled",
    message: "Issues are turned off in acme/api, so it can't take a new issue.",
  };

  const prepared = await setupGithub(issuesOff);
  assert.deepEqual(
    await prepared.connector.prepare(
      "create_issue",
      { repo: "acme/api", title: "Crash", labels: ["bug"] },
      BOUND
    ),
    DISABLED
  );
  assert.equal(prepared.github.calls.filter((call) => call.path.startsWith("/repos/")).length, 0);

  // Turned off between prepare and Send: the Settings re-read picks it up.
  const clock = { now: NOW };
  const later = await setupGithub(
    {
      [REPOSITORIES]: [
        json({ total_count: 3, repositories: INSTALLED_REPOS }),
        issuesOff[REPOSITORIES][0],
      ],
      [CREATE]: [CREATED],
    },
    { clock }
  );
  const { payload } = await prepareIssue(later.connector);
  clock.now += REFETCH_AFTER_MS;
  await later.connector.getStatus();
  await countReadLands();
  assert.deepEqual(await later.connector.commit("create_issue", payload, {}, BOUND), {
    state: "failed",
    errorCode: DISABLED.errorCode,
    message: DISABLED.message,
  });
  assert.equal(writes(later.github).length, 0);

  // Its pull requests still take comments.
  const pull = await setupGithub({ ...issuesOff, [ISSUE_45]: [PULL] });
  assert.equal((await prepareComment(pull.connector)).status, "ready");
});

test("the question which repository takes an issue leaves out archived repos and ones with issues off", async () => {
  const { connector } = await setupGithub(
    installedScript([
      ...INSTALLED_REPOS,
      { ...repo("acme/old", "2026-09-28T10:00:00Z"), archived: true },
      { ...repo("acme/docs", "2026-09-28T09:00:00Z"), has_issues: false },
      { ...repo("old/api", "2026-09-28T08:00:00Z"), archived: true },
    ])
  );

  assert.deepEqual(await connector.prepare("create_issue", { title: "x" }, BOUND), {
    status: "needs_clarification",
    message: "Ask the user which repository to use. The issue can go in any of these.",
    candidates: ["acme/api", "dana/api", "acme/web"],
  });
  assert.deepEqual(
    (await connector.prepare("create_issue", { repo: "api", title: "x" }, BOUND)).candidates,
    ["acme/api", "dana/api"]
  );
  // A search can still look in every one of them.
  assert.deepEqual(
    (await connector.query("search_issues", { query: "x", repo: "api" }, BOUND)).candidates,
    ["old/api", "acme/api", "dana/api"]
  );
});

test("a new issue with one installed repo able to take it goes there; with none, prepare says why", async () => {
  const cannot = [
    { ...repo("acme/old", "2026-09-28T10:00:00Z"), archived: true },
    { ...repo("acme/docs", "2026-09-28T09:00:00Z"), has_issues: false },
  ];

  const one = await setupGithub(
    installedScript([...cannot, repo("acme/api", "2026-09-27T10:00:00Z")])
  );
  const prepared = await one.connector.prepare("create_issue", { title: "x" }, BOUND);
  assert.equal(prepared.status, "ready");
  assert.equal(prepared.preview.destinationLabel, "acme/api");

  const none = await setupGithub(installedScript(cannot));
  assert.deepEqual(await none.connector.prepare("create_issue", { title: "x" }, BOUND), {
    status: "failed",
    errorCode: "issues_disabled",
    message:
      "None of the installed repositories can take a new issue: each is archived or has issues turned off.",
  });
});

test("a missing, too long or oversized issue is refused before any request", async () => {
  const { connector, github } = await setupGithub();

  for (const [args, status, errorCode] of [
    [{ title: " \n " }, "needs_clarification", undefined],
    [{ title: undefined }, "needs_clarification", undefined],
    [{ title: "t".repeat(257) }, "failed", "too_long"],
    [{ body: "b".repeat(65537) }, "failed", "too_long"],
  ]) {
    const prepared = await connector.prepare(
      "create_issue",
      { repo: "acme/api", title: "ok", ...args },
      BOUND
    );
    assert.equal(prepared.status, status, JSON.stringify(args).slice(0, 40));
    assert.equal(prepared.errorCode, errorCode);
  }
  // 256 emoji are 256 characters, within GitHub's limit.
  assert.equal((await prepareIssue(connector, { title: "😀".repeat(256) })).status, "ready");
  assert.equal(github.calls.filter((call) => call.path.startsWith("/repos/")).length, 0);
});

test("an issue for an uninstalled repo names it; none installed says so; several unnamed ask which", async () => {
  const uninstalled = await setupGithub();
  const refused = await uninstalled.connector.prepare(
    "create_issue",
    { repo: "evil/secret", title: "x", labels: ["bug"] },
    BOUND
  );
  assert.equal(refused.errorCode, "not_installed");
  assert.match(refused.message, /evil\/secret/);
  assert.equal(
    uninstalled.github.calls.filter((call) => call.path.startsWith("/repos/")).length,
    0
  );

  const none = await setupGithub(NOTHING_INSTALLED);
  const nothing = await none.connector.prepare("create_issue", { title: "x" }, BOUND);
  assert.equal(nothing.errorCode, "no_repositories");

  const several = await setupGithub();
  assert.deepEqual(await several.connector.prepare("create_issue", { title: "x" }, BOUND), {
    status: "needs_clarification",
    message: "Ask the user which repository to use. The issue can go in any of these.",
    candidates: ["acme/api", "dana/api", "acme/web"],
  });
  const ambiguous = await several.connector.prepare(
    "create_issue",
    { repo: "api", title: "x" },
    BOUND
  );
  assert.deepEqual(ambiguous.candidates, ["acme/api", "dana/api"]);

  const one = await setupGithub(installedScript([repo("dana/notes", "2026-09-28T00:00:00Z")]));
  const onlyRepo = await one.connector.prepare("create_issue", { title: "x" }, BOUND);
  assert.equal(onlyRepo.preview.destinationLabel, "dana/notes");
});

test("Send creates the issue from the card's fields and reports its reference", async () => {
  const { connector, github } = await setupGithub({
    [LABELS]: [json([{ name: "bug" }])],
    [CREATE]: [CREATED],
  });
  const { payload } = await prepareIssue(connector, { labels: ["bug"] });

  const result = await connector.commit(
    "create_issue",
    payload,
    { title: "Login times out after 30 s", body: "Edited." },
    BOUND
  );

  assert.deepEqual(result, {
    state: "sent",
    url: "https://github.com/acme/api/issues/212",
    resultLabel: "acme/api#212",
  });
  const [created] = hits(github, CREATE);
  assert.deepEqual(created.json, {
    title: "Login times out after 30 s",
    body: "Edited.",
    labels: ["bug"],
  });
  assert.equal(created.authorization, "Bearer ghu-1");
});

test("the card's edits are checked again at Send, before any request", async () => {
  const { connector, github } = await setupGithub();
  const { payload } = await prepareIssue(connector);
  github.calls.length = 0;

  for (const [edits, errorCode] of [
    [{ title: "Two\nlines" }, "invalid"],
    [{ title: "   " }, "invalid"],
    [{ title: "t".repeat(257) }, "too_long"],
    [{ body: "b".repeat(65537) }, "too_long"],
  ]) {
    const result = await connector.commit("create_issue", payload, edits, BOUND);
    assert.equal(result.state, "failed");
    assert.equal(result.errorCode, errorCode, JSON.stringify(edits).slice(0, 30));
  }
  assert.equal(github.calls.length, 0);
});

test("Send refuses a repo removed from the App since prepare, before any write", async () => {
  const clock = { now: NOW };
  const { connector, github } = await setupGithub(
    {
      [REPOSITORIES]: [
        json({ total_count: INSTALLED_REPOS.length, repositories: INSTALLED_REPOS }),
        json({
          total_count: 2,
          repositories: INSTALLED_REPOS.filter((entry) => entry.full_name !== "acme/api"),
        }),
      ],
      [LABELS]: [json([])],
      [CREATE]: [CREATED],
    },
    { clock }
  );
  const { payload } = await prepareIssue(connector);
  // The user removes acme/api on GitHub's install page; Settings re-reads
  // the list when they come back.
  clock.now += REFETCH_AFTER_MS;
  await connector.getStatus();
  await countReadLands();

  const result = await connector.commit("create_issue", payload, {}, BOUND);

  assert.equal(result.state, "failed");
  assert.equal(result.errorCode, "not_installed");
  assert.equal(writes(github).length, 0);
});

test("a card never creates under a login other than the one it was prepared with", async () => {
  const { connector, github, credentials } = await setupGithub({ [CREATE]: [CREATED] });
  const { payload } = await prepareIssue(connector);
  credentials.replace("acct-1", "github", OTHER_LOGIN, 1);

  assert.deepEqual(await connector.commit("create_issue", payload, {}, BOUND), {
    state: "failed",
    errorCode: "connection_changed",
    message: "The GitHub connection changed, so nothing was done.",
  });
  assert.equal(writes(github).length, 0);
});

test("a create that may have reached GitHub is unknown, with the repo's issues to check", async () => {
  for (const reply of [
    json({ message: "Server Error" }, 502),
    reset(),
    json({ title: "no number" }, 201),
  ]) {
    const { connector, github } = await setupGithub({ [CREATE]: [reply] });
    const { payload } = await prepareIssue(connector);

    const result = await connector.commit("create_issue", payload, {}, BOUND);

    assert.equal(result.state, "unknown");
    assert.equal(result.checkUrl, "https://github.com/acme/api/issues");
    // Never repeated: GitHub has no idempotency key.
    assert.equal(hits(github, CREATE).length, 1);
  }
});

test("a create GitHub refused is failed with its reason", async () => {
  for (const [reply, errorCode] of [
    [offline(), "ENOTFOUND"],
    [json({ message: "Validation Failed" }, 422), "invalid"],
    [json({ message: "Issues are disabled" }, 410), "issues_disabled"],
    [json({ message: "Resource not accessible" }, 403), "forbidden"],
  ]) {
    const { connector } = await setupGithub({ [CREATE]: [reply] });
    const { payload } = await prepareIssue(connector);

    const result = await connector.commit("create_issue", payload, {}, BOUND);

    assert.equal(result.state, "failed");
    assert.equal(result.errorCode, errorCode);
  }
});

test("a 404 after the App was uninstalled from the repo reads as not installed", async () => {
  const { connector, github } = await setupGithub({
    [INSTALLATIONS]: [
      json({ total_count: 1, installations: [{ id: 7 }] }),
      json({ total_count: 1, installations: [{ id: 7 }] }),
    ],
    [REPOSITORIES]: [
      json({ total_count: 3, repositories: INSTALLED_REPOS }),
      json({ total_count: 1, repositories: [repo("acme/web", "2026-09-20T10:00:00Z")] }),
    ],
    [CREATE]: [json({ message: "Not Found" }, 404)],
  });
  const { payload } = await prepareIssue(connector);

  const result = await connector.commit("create_issue", payload, {}, BOUND);

  assert.equal(result.state, "failed");
  assert.equal(result.errorCode, "not_installed");
  assert.match(result.message, /acme\/api/);
  assert.equal(hits(github, CREATE).length, 1);
});

test("a 404 on a create in a repo that's still installed reads as no permission, never a missing issue", async () => {
  const { connector } = await setupGithub({ [CREATE]: [json({ message: "Not Found" }, 404)] });
  const { payload } = await prepareIssue(connector);

  assert.deepEqual(await connector.commit("create_issue", payload, {}, BOUND), {
    state: "failed",
    errorCode: "forbidden",
    message: "GitHub refused: the user may not be able to create issues in acme/api.",
  });
});

test("a 403 on a repo archived since the list was read reads as archived", async () => {
  const archivedList = json({
    total_count: 3,
    repositories: INSTALLED_REPOS.map((entry) =>
      entry.full_name === "acme/api" ? { ...entry, archived: true } : entry
    ),
  });
  const forbidden = json({ message: "Repository was archived so is read-only." }, 403);
  const ARCHIVED = {
    state: "failed",
    errorCode: "archived",
    message: "acme/api is archived, so it can't take new issues or comments.",
  };

  const issue = await setupGithub({
    [REPOSITORIES]: [json({ total_count: 3, repositories: INSTALLED_REPOS }), archivedList],
    [CREATE]: [forbidden],
  });
  const created = await prepareIssue(issue.connector);
  assert.deepEqual(
    await issue.connector.commit("create_issue", created.payload, {}, BOUND),
    ARCHIVED
  );

  const comment = await setupGithub({
    [REPOSITORIES]: [json({ total_count: 3, repositories: INSTALLED_REPOS }), archivedList],
    [ISSUE_45]: [ISSUE],
    [COMMENT_45]: [forbidden],
  });
  const commented = await prepareComment(comment.connector);
  assert.deepEqual(
    await comment.connector.commit("comment", commented.payload, {}, BOUND),
    ARCHIVED
  );
  assert.equal(hits(comment.github, COMMENT_45).length, 1);

  // Still writable: GitHub's own refusal stands.
  const refused = await setupGithub({ [CREATE]: [forbidden] });
  const card = await prepareIssue(refused.connector);
  assert.equal(
    (await refused.connector.commit("create_issue", card.payload, {}, BOUND)).errorCode,
    "forbidden"
  );
});

test("a 401 at Send is refreshed once under the same login, then the create goes through", async () => {
  const { connector, github } = await setupGithub({
    [CREATE]: [UNAUTHORIZED, CREATED],
    [TOKEN]: [REFRESHED],
  });
  const { payload } = await prepareIssue(connector);

  assert.equal((await connector.commit("create_issue", payload, {}, BOUND)).state, "sent");
  assert.deepEqual(
    hits(github, CREATE).map((call) => call.authorization),
    ["Bearer ghu-1", "Bearer ghu-2"]
  );
  assert.equal(hits(github, TOKEN)[0].form.client_secret, undefined);
});

// --- comment ---

test("prepare reads the issue and shows the comment card with its title", async () => {
  const { connector, github } = await setupGithub({ [ISSUE_45]: [ISSUE] });

  const prepared = await prepareComment(connector, {
    target: "https://github.com/ACME/api/issues/45#issuecomment-1",
  });

  assert.deepEqual(prepared, {
    status: "ready",
    payload: { owner: "acme", repo: "api", number: 45, body: "Looking into it." },
    preview: {
      verbKey: "comment",
      destinationLabel: "acme/api#45",
      accountLabel: "@dana",
      body: "Looking into it.",
      fields: { body: "Looking into it." },
      notes: [
        {
          key: "connectors.approval.comment.notes.targetTitle",
          values: { title: "Timeout on login" },
        },
      ],
    },
  });
  assert.equal(writes(github).length, 0);
});

test("a comment target can name just the repo, or just the number when one repo is installed", async () => {
  const web = await setupGithub({
    "GET /repos/acme/web/issues/45": [
      json({ ...ISSUE.body, html_url: "https://github.com/acme/web/issues/45" }),
    ],
  });
  const onWeb = await prepareComment(web.connector, { target: " WEB#45 " });
  assert.deepEqual(onWeb.payload, {
    owner: "acme",
    repo: "web",
    number: 45,
    body: "Looking into it.",
  });
  assert.equal(onWeb.preview.destinationLabel, "acme/web#45");

  const one = await setupGithub({
    ...installedScript([repo("acme/api", "2026-09-27T10:00:00Z")]),
    [ISSUE_45]: [ISSUE],
  });
  assert.equal(
    (await prepareComment(one.connector, { target: "#45" })).preview.destinationLabel,
    "acme/api#45"
  );

  const several = await setupGithub();
  assert.deepEqual(
    await several.connector.prepare("comment", { target: "#45", body: "x" }, BOUND),
    {
      status: "needs_clarification",
      message: "Ask the user which repository to use. The comment goes on #45 there.",
      candidates: ["acme/api", "dana/api", "acme/web"],
    }
  );
  assert.deepEqual(
    await several.connector.prepare("comment", { target: "api#45", body: "x" }, BOUND),
    {
      status: "needs_clarification",
      message:
        "Several installed repositories are named api. Ask the user which one. The comment goes on #45 there.",
      candidates: ["acme/api", "dana/api"],
    }
  );
  const missing = await several.connector.prepare(
    "comment",
    { target: "secret#1", body: "x" },
    BOUND
  );
  assert.equal(missing.errorCode, "not_installed");
  assert.match(missing.message, /installed on secret\./);
  assert.equal(several.github.calls.filter((call) => call.path.startsWith("/repos/")).length, 0);

  const bad = await setupGithub();
  for (const target of ["#0", "#", "api#", "#12a", "..#4", ".#4", "a b#4", "api#4#5", "acme/#4"]) {
    assert.deepEqual(
      await bad.connector.prepare("comment", { target, body: "x" }, BOUND),
      {
        status: "failed",
        errorCode: "invalid_reference",
        message:
          "Give the issue or pull request as owner/repo#123, repo#123, #123 or its github.com link.",
      },
      target
    );
  }
  assert.equal(bad.github.calls.length, 0);
});

test("a comment on a pull request says so on the card", async () => {
  const { connector } = await setupGithub({ [ISSUE_45]: [PULL] });

  const prepared = await prepareComment(connector, {
    target: "https://github.com/acme/api/pull/45",
  });

  assert.deepEqual(prepared.preview.notes, [
    {
      key: "connectors.approval.comment.notes.targetTitle",
      values: { title: "Fix the login timeout" },
    },
    { key: "connectors.approval.github.notes.pullRequest" },
  ]);
});

test("a comment on a locked, missing or uninstalled target, or a bad reference, is refused", async () => {
  const locked = await setupGithub({
    [ISSUE_45]: [json({ ...ISSUE.body, locked: true, active_lock_reason: "resolved" })],
  });
  assert.deepEqual(
    await locked.connector.prepare("comment", { target: "acme/api#45", body: "x" }, BOUND),
    {
      status: "failed",
      errorCode: "locked",
      message: "The conversation on acme/api#45 is locked, so it can't take new comments.",
    }
  );

  const missing = await setupGithub({ [ISSUE_45]: [json({ message: "Not Found" }, 404)] });
  assert.equal(
    (await missing.connector.prepare("comment", { target: "acme/api#45", body: "x" }, BOUND))
      .errorCode,
    "not_found"
  );

  const uninstalled = await setupGithub();
  const refused = await uninstalled.connector.prepare(
    "comment",
    { target: "evil/secret#1", body: "x" },
    BOUND
  );
  assert.equal(refused.errorCode, "not_installed");
  assert.match(refused.message, /evil\/secret/);
  assert.equal(
    uninstalled.github.calls.filter((call) => call.path.startsWith("/repos/")).length,
    0
  );

  const bad = await setupGithub();
  assert.equal(
    (await bad.connector.prepare("comment", { target: "the login bug", body: "x" }, BOUND))
      .errorCode,
    "invalid_reference"
  );
  assert.equal(
    (await bad.connector.prepare("comment", { target: "acme/api#45", body: "  " }, BOUND)).status,
    "needs_clarification"
  );
  assert.equal(
    (
      await bad.connector.prepare(
        "comment",
        { target: "acme/api#45", body: "b".repeat(65537) },
        BOUND
      )
    ).errorCode,
    "too_long"
  );
  assert.equal(bad.github.calls.length, 0);
});

test("a deleted issue reads as not found, and a repo with issues turned off as issues_disabled", async () => {
  const GONE = json({ message: "This issue was deleted" }, 410);
  const deleted = await setupGithub({ [ISSUE_45]: [GONE] });
  assert.deepEqual(
    await deleted.connector.prepare("comment", { target: "acme/api#45", body: "x" }, BOUND),
    { status: "failed", errorCode: "not_found", message: "acme/api#45 was deleted." }
  );

  const disabled = await setupGithub({
    ...installedScript(
      INSTALLED_REPOS.map((entry) =>
        entry.full_name === "acme/api" ? { ...entry, has_issues: false } : entry
      )
    ),
    [ISSUE_45]: [json({ message: "Issues are disabled for this repo" }, 410)],
  });
  assert.equal(
    (await disabled.connector.prepare("comment", { target: "acme/api#45", body: "x" }, BOUND))
      .errorCode,
    "issues_disabled"
  );
});

test("an issue deleted between the read and the post reads as deleted, not as issues turned off", async () => {
  const { connector } = await setupGithub({
    [ISSUE_45]: [ISSUE],
    [COMMENT_45]: [json({ message: "This issue was deleted" }, 410)],
  });
  const { payload } = await prepareComment(connector);

  assert.deepEqual(await connector.commit("comment", payload, {}, BOUND), {
    state: "failed",
    errorCode: "not_found",
    message: "acme/api#45 was deleted.",
  });
});

test("a locked conversation still takes a comment from someone who can push to the repo", async () => {
  const { connector } = await setupGithub({
    ...installedScript(
      INSTALLED_REPOS.map((entry) =>
        entry.full_name === "acme/api" ? { ...entry, permissions: { push: true } } : entry
      )
    ),
    [ISSUE_45]: [json({ ...ISSUE.body, locked: true, active_lock_reason: "too heated" })],
  });

  const prepared = await connector.prepare("comment", { target: "acme/api#45", body: "x" }, BOUND);

  assert.equal(prepared.status, "ready");
});

test("Send posts the card's comment and links to it", async () => {
  const { connector, github } = await setupGithub({
    [ISSUE_45]: [ISSUE],
    [COMMENT_45]: [COMMENTED],
  });
  const { payload } = await prepareComment(connector);

  const result = await connector.commit("comment", payload, { body: "On it, @sam." }, BOUND);

  assert.deepEqual(result, {
    state: "sent",
    url: "https://github.com/acme/api/issues/45#issuecomment-9001",
  });
  assert.deepEqual(hits(github, COMMENT_45)[0].json, { body: "On it, @sam." });
});

test("an edited comment is checked again at Send, and an issue locked since prepare is refused", async () => {
  const edited = await setupGithub({ [ISSUE_45]: [ISSUE] });
  const { payload } = await prepareComment(edited.connector);
  edited.github.calls.length = 0;
  assert.equal(
    (await edited.connector.commit("comment", payload, { body: " \n" }, BOUND)).errorCode,
    "invalid"
  );
  assert.equal(
    (await edited.connector.commit("comment", payload, { body: "b".repeat(65537) }, BOUND))
      .errorCode,
    "too_long"
  );
  assert.equal(edited.github.calls.length, 0);

  const lockedSince = await setupGithub({
    [ISSUE_45]: [ISSUE, json({ ...ISSUE.body, locked: true })],
  });
  const card = await prepareComment(lockedSince.connector);
  const result = await lockedSince.connector.commit("comment", card.payload, {}, BOUND);
  assert.equal(result.errorCode, "locked");
  assert.equal(writes(lockedSince.github).length, 0);
});

test("a comment target whose read answers a different issue is refused as not found", async () => {
  const wrongNumber = await setupGithub({
    [ISSUE_45]: [
      json({
        number: 12,
        title: "Wrong issue",
        state: "open",
        locked: false,
        html_url: "https://github.com/acme/api/issues/12",
      }),
    ],
  });
  assert.deepEqual(
    await wrongNumber.connector.prepare("comment", { target: "acme/api#45", body: "x" }, BOUND),
    {
      status: "failed",
      errorCode: "not_found",
      message: "GitHub couldn't find that issue or pull request in acme/api; it may have moved.",
    }
  );
  assert.equal(writes(wrongNumber.github).length, 0);

  const wrongRepo = await setupGithub({
    [ISSUE_45]: [
      json({
        number: 45,
        title: "Moved",
        state: "open",
        locked: false,
        // A redirected reply (GitHub 301s a transferred issue): same
        // number, but a different repo than the one asked about.
        html_url: "https://github.com/acme/other/issues/45",
      }),
    ],
  });
  assert.equal(
    (await wrongRepo.connector.prepare("comment", { target: "acme/api#45", body: "x" }, BOUND))
      .errorCode,
    "not_found"
  );
  assert.equal(writes(wrongRepo.github).length, 0);
});

test("a comment whose re-read at Send answers a different issue posts nothing", async () => {
  const { connector, github } = await setupGithub({
    [ISSUE_45]: [
      ISSUE,
      json({
        number: 99,
        title: "Different issue",
        state: "open",
        locked: false,
        html_url: "https://github.com/acme/api/issues/99",
      }),
    ],
  });
  const { payload } = await prepareComment(connector);

  const result = await connector.commit("comment", payload, {}, BOUND);

  assert.equal(result.state, "failed");
  assert.equal(result.errorCode, "not_found");
  assert.equal(writes(github).length, 0);
});

test("a comment that may have reached GitHub is unknown, with the issue to check", async () => {
  const { connector } = await setupGithub({
    [ISSUE_45]: [ISSUE],
    [COMMENT_45]: [json({ message: "Server Error" }, 500)],
  });
  const { payload } = await prepareComment(connector);

  assert.deepEqual(await connector.commit("comment", payload, {}, BOUND), {
    state: "unknown",
    errorCode: "http_500",
    checkUrl: "https://github.com/acme/api/issues/45",
  });
});

test("a comment card never posts under another login", async () => {
  const { connector, github, credentials } = await setupGithub({ [ISSUE_45]: [ISSUE] });
  const { payload } = await prepareComment(connector);
  credentials.replace("acct-1", "github", OTHER_LOGIN, 1);

  assert.equal(
    (await connector.commit("comment", payload, {}, BOUND)).errorCode,
    "connection_changed"
  );
  assert.equal(writes(github).length, 0);
});

// --- status and binding ---

test("the status shows the GitHub user, the installed repository count once read, and where to manage them", async () => {
  const { connector, statusChanges } = await setupGithub();

  const status = {
    connected: true,
    configured: true,
    accountLabel: "@dana",
    workspaceLabel: null,
    needsReconnect: false,
    manageUrl: INSTALL_URL,
  };
  // Not read yet for this login, rather than none installed.
  assert.deepEqual(await connector.getStatus(), { ...status, workspaceLabelPending: true });
  await countReadLands();
  assert.equal(statusChanges.length, 1);
  assert.deepEqual(await connector.getStatus(), { ...status, workspaceLabel: "3" });

  const none = await setupGithub(NOTHING_INSTALLED);
  await none.connector.getStatus();
  await countReadLands();
  assert.equal((await none.connector.getStatus()).workspaceLabel, "0");
});

test("a first repository count that can't be read still ends the wait, announced once", async () => {
  const { connector, github, credentials, statusChanges } = await setupGithub({
    [INSTALLATIONS]: [offline()],
  });

  assert.equal((await connector.getStatus()).workspaceLabelPending, true);
  await countReadLands();
  assert.equal(statusChanges.length, 1);

  // The announced status reads again; that failure changes nothing, so it
  // announces nothing and no status loop follows.
  const status = await connector.getStatus();
  await countReadLands();
  assert.equal(status.workspaceLabel, null);
  assert.equal("workspaceLabelPending" in status, false);
  assert.equal(statusChanges.length, 1);
  assert.equal(hits(github, INSTALLATIONS).length, 2);

  // A reconnect is a new login: its count is pending again.
  credentials.replace("acct-1", "github", OTHER_LOGIN, 1);
  assert.equal((await connector.getStatus()).workspaceLabelPending, true);
});

test("a repository count cut at the read limit says there are more", async () => {
  const { connector } = await setupGithub({
    [REPOSITORIES]: [
      json({ total_count: 1500, repositories: INSTALLED_REPOS }, 200, {
        link: '<https://api.github.com/user/installations/7/repositories?page=2>; rel="next"',
      }),
    ],
  });

  await connector.getStatus();
  await countReadLands();

  assert.equal((await connector.getStatus()).workspaceLabel, "30+");
});

test("getStatus never waits on GitHub, and reads the count once however many ask at once", async () => {
  const { connector, github } = await setupGithub({ [INSTALLATIONS]: [hang()] });

  const started = Date.now();
  const statuses = await Promise.all([connector.getStatus(), connector.getStatus()]);

  assert.ok(Date.now() - started < 500, `${Date.now() - started} ms`);
  assert.deepEqual(
    statuses.map((status) => [status.connected, status.accountLabel, status.workspaceLabel]),
    [
      [true, "@dana", null],
      [true, "@dana", null],
    ]
  );
  assert.equal(hits(github, INSTALLATIONS).length, 1);
});

test("a status re-reads the installed repositories once its list is 5 s old, never waiting out the 60s cache, and announces only a changed count", async () => {
  const clock = { now: NOW };
  const { connector, github, statusChanges } = await setupGithub(
    {
      [REPOSITORIES]: [
        json({ total_count: 3, repositories: INSTALLED_REPOS }),
        json({ total_count: 3, repositories: INSTALLED_REPOS }),
        json({ total_count: 1, repositories: [repo("acme/web", "2026-09-20T10:00:00Z")] }),
        offline(),
      ],
    },
    { clock }
  );

  for (const expected of [null, "3", "3", "1"]) {
    assert.equal((await connector.getStatus()).workspaceLabel, expected);
    await countReadLands();
    clock.now += REFETCH_AFTER_MS;
  }
  // A count that couldn't be read keeps the last one.
  assert.equal((await connector.getStatus()).workspaceLabel, "1");
  assert.equal(hits(github, REPOSITORIES).length, 4);
  assert.equal(statusChanges.length, 2);

  // Status broadcasts one after another (Slack connecting, a token saved,
  // the count's own) share a list younger than 5 s.
  const burst = await setupGithub();
  for (let read = 0; read < 3; read += 1) {
    await burst.connector.getStatus();
    await countReadLands();
  }
  assert.equal(hits(burst.github, REPOSITORIES).length, 1);
});

test("a repository read that hangs is given up after the bound, so the next status reads again", async () => {
  const { STATUS_REPOSITORIES_TIMEOUT_MS } = await setupGithub();
  assert.equal(STATUS_REPOSITORIES_TIMEOUT_MS, 5000);
  const { connector, github, statusChanges } = await setupGithub(
    { [INSTALLATIONS]: [hang()] },
    { statusTimeoutMs: 50 }
  );

  await connector.getStatus();
  await new Promise((resolve) => setTimeout(resolve, 100));
  assert.equal((await connector.getStatus()).workspaceLabel, null);
  await countReadLands();

  assert.equal(hits(github, INSTALLATIONS).length, 2);
  // Only the first read given up on is announced: the row stops waiting.
  assert.equal(statusChanges.length, 1);
});

test("a token refresh that hangs never holds up the status", async () => {
  const { connector } = await setupGithub(
    { [TOKEN]: [hang()] },
    { credential: { ...CONNECTED, expiresAt: NOW - 1 } }
  );

  const started = Date.now();
  const status = await connector.getStatus();

  assert.ok(Date.now() - started < 500, `${Date.now() - started} ms`);
  assert.equal(status.accountLabel, "@dana");
  assert.equal(status.workspaceLabel, null);
});

test("without a login the status says whether this build can connect; a login always can", async () => {
  const notConnected = await setupGithub({}, { credential: null });
  assert.deepEqual(await notConnected.connector.getStatus(), {
    connected: false,
    configured: true,
    accountLabel: null,
    workspaceLabel: null,
    needsReconnect: false,
    manageUrl: INSTALL_URL,
  });
  const unconfigured = await setupGithub({}, { credential: null, clientId: null, slug: null });
  assert.deepEqual(await unconfigured.connector.getStatus(), {
    connected: false,
    configured: false,
    accountLabel: null,
    workspaceLabel: null,
    needsReconnect: false,
  });
  const leftOver = await setupGithub({}, { clientId: null });
  assert.equal((await leftOver.connector.getStatus()).configured, true);
  // Without the App's slug the user could never choose repositories, so the
  // row stays hidden; a slug that isn't one builds no link either.
  const noSlug = await setupGithub({}, { credential: null, slug: null });
  assert.equal((await noSlug.connector.getStatus()).configured, false);
  const odd = await setupGithub({}, { credential: null, slug: "../evil" });
  assert.equal((await odd.connector.getStatus()).manageUrl, undefined);
  assert.equal((await odd.connector.getStatus()).configured, false);
});

test("a login that needs reconnecting reports it without asking GitHub", async () => {
  const { connector, github } = await setupGithub(
    {},
    { credential: { ...CONNECTED, needsReconnect: true } }
  );

  const status = await connector.getStatus();

  assert.equal(status.needsReconnect, true);
  assert.equal(status.workspaceLabel, null);
  assert.equal("workspaceLabelPending" in status, false);
  assert.equal(github.calls.length, 0);
});

test("the binding is the GitHub user id as a string with the slot's generation", async () => {
  const { connector } = await setupGithub();
  assert.deepEqual(await connector.getBinding(), BINDING);

  const none = await setupGithub({}, { credential: null });
  assert.equal(await none.connector.getBinding(), null);
});
