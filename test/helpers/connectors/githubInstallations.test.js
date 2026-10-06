const test = require("node:test");
const assert = require("node:assert/strict");
const { NOW, BINDING, fakeGithubFetch, json } = require("./githubFixtures");

const loadInstallations = () => import("../../../src/helpers/connectors/githubInstallations.js");
const loadApi = () => import("../../../src/helpers/connectors/githubApi.js");

const INSTALLATIONS = "GET /user/installations";
const reposOf = (id) => `GET /user/installations/${id}/repositories`;
const TOKEN = "ghu-1";

function repo(fullName, updatedAt, extra = {}) {
  const [owner, name] = fullName.split("/");
  return {
    id: fullName.length,
    name,
    full_name: fullName,
    owner: { login: owner, id: 1 },
    private: false,
    updated_at: updatedAt,
    ...extra,
  };
}

const installation = (id, login) => ({ id, account: { login }, repository_selection: "selected" });
const next = (path, page) => ({
  link: `<https://api.github.com${path}?per_page=100&page=${page}>; rel="next", <https://api.github.com${path}?per_page=100&page=9>; rel="last"`,
});
const installationsPage = (installations, headers = {}) =>
  json({ total_count: installations.length, installations }, 200, headers);
const reposPage = (repositories, headers = {}) =>
  json({ total_count: repositories.length, repositories }, 200, headers);

const ACME_API = repo("acme/api", "2026-09-27T10:00:00Z", { private: true });
const ACME_WEB = repo("acme/web", "2026-09-20T10:00:00Z");
// Issues turned off: a 410 on its issues means that, not a deleted issue.
const DANA_API = repo("dana/api", "2026-09-25T10:00:00Z", { has_issues: false });
const DANA_NOTES = repo("dana/notes", "2026-09-28T09:00:00Z");

// Two installations (an org and the user), the first split over two pages,
// and the org's repositories split over two pages.
function twoInstallations() {
  return {
    [INSTALLATIONS]: [
      installationsPage([installation(1, "acme")], next("/user/installations", 2)),
      installationsPage([installation(2, "dana")]),
    ],
    [reposOf(1)]: [
      reposPage([ACME_WEB], next("/user/installations/1/repositories", 2)),
      reposPage([ACME_API]),
    ],
    [reposOf(2)]: [reposPage([DANA_API, DANA_NOTES])],
  };
}

// One installation with one page: every read is exactly two requests.
function oneInstallation() {
  return {
    [INSTALLATIONS]: [installationsPage([installation(2, "dana")])],
    [reposOf(2)]: [reposPage([DANA_API, DANA_NOTES])],
  };
}

async function setup(script, { clock = { now: NOW } } = {}) {
  const [{ createGithubInstallations }, { createGithubApi }] = await Promise.all([
    loadInstallations(),
    loadApi(),
  ]);
  const github = fakeGithubFetch(script);
  const api = createGithubApi({
    fetchImpl: github.fetchImpl,
    sleep: async () => {},
    now: () => clock.now,
  });
  const installations = createGithubInstallations({ api, now: () => clock.now });
  return { installations, github, clock };
}

test("lists every installed repository across installations and pages, most recently updated first", async () => {
  const { installations, github } = await setup(twoInstallations());

  const listed = await installations.list(BINDING, TOKEN);

  assert.equal(listed.ok, true);
  assert.deepEqual(listed.repos, [
    {
      owner: "dana",
      name: "notes",
      fullName: "dana/notes",
      hasIssues: true,
      archived: false,
      canPush: false,
      updatedAt: "2026-09-28T09:00:00Z",
    },
    {
      owner: "acme",
      name: "api",
      fullName: "acme/api",
      hasIssues: true,
      archived: false,
      canPush: false,
      updatedAt: "2026-09-27T10:00:00Z",
    },
    {
      owner: "dana",
      name: "api",
      fullName: "dana/api",
      hasIssues: false,
      archived: false,
      canPush: false,
      updatedAt: "2026-09-25T10:00:00Z",
    },
    {
      owner: "acme",
      name: "web",
      fullName: "acme/web",
      hasIssues: true,
      archived: false,
      canPush: false,
      updatedAt: "2026-09-20T10:00:00Z",
    },
  ]);
  const pages = github.calls.map((call) => [call.path, call.query.page ?? "1"]);
  assert.deepEqual(pages.slice(0, 2), [
    ["/user/installations", "1"],
    ["/user/installations", "2"],
  ]);
  // Each installation's repositories are read side by side.
  assert.deepEqual(pages.slice(2).sort(), [
    ["/user/installations/1/repositories", "1"],
    ["/user/installations/1/repositories", "2"],
    ["/user/installations/2/repositories", "1"],
  ]);
  assert.equal(listed.truncated, false);
  for (const call of github.calls) {
    assert.equal(call.query.per_page, "100");
    assert.equal(call.authorization, "Bearer ghu-1");
  }
});

test("an archived repo, and the user's push access, come from the listing", async () => {
  const { installations } = await setup({
    [INSTALLATIONS]: [installationsPage([installation(2, "dana")])],
    [reposOf(2)]: [
      reposPage([
        { ...DANA_NOTES, archived: true, permissions: { push: false, pull: true } },
        { ...DANA_API, permissions: { push: true } },
      ]),
    ],
  });

  const { repos } = await installations.list(BINDING, TOKEN);

  assert.deepEqual(
    repos.map((repo) => [repo.fullName, repo.archived, repo.canPush]),
    [
      ["dana/notes", true, false],
      ["dana/api", false, true],
    ]
  );
});

test("an installation with more repositories than OpenWhispr reads marks the list cut", async () => {
  const { installations } = await setup({
    [INSTALLATIONS]: [installationsPage([installation(2, "dana")])],
    // Every page links to another, so the read stops at its page cap.
    [reposOf(2)]: [reposPage([DANA_API], next("/user/installations/2/repositories", 2))],
  });

  const listed = await installations.list(BINDING, TOKEN);

  assert.equal(listed.ok, true);
  assert.equal(listed.truncated, true);
  // Its own code: the repo may be installed after all.
  assert.deepEqual(await installations.resolveRepo(BINDING, TOKEN, "dana/far"), {
    ok: false,
    errorCode: "repo_unlisted",
  });
});

test("repository entries without an owner, name or full name are skipped", async () => {
  const { installations } = await setup({
    [INSTALLATIONS]: [installationsPage([installation(1, "acme"), { account: {} }])],
    [reposOf(1)]: [reposPage([ACME_API, { name: "ghost" }, { ...ACME_WEB, owner: null }, null])],
  });

  const listed = await installations.list(BINDING, TOKEN);

  assert.deepEqual(
    listed.repos.map((entry) => entry.fullName),
    ["acme/api"]
  );
});

test("the list is kept for 60 seconds per login, then read again", async () => {
  const { installations, github, clock } = await setup(oneInstallation());
  await installations.list(BINDING, TOKEN);
  assert.equal(github.calls.length, 2);

  clock.now = NOW + 60 * 1000 - 1;
  assert.equal((await installations.list(BINDING, TOKEN)).repos.length, 2);
  assert.equal(github.calls.length, 2);

  clock.now = NOW + 60 * 1000;
  await installations.list(BINDING, TOKEN);
  assert.equal(github.calls.length, 4);
});

test("another login, or a cleared cache, reads the list again", async () => {
  const { installations, github } = await setup(oneInstallation());
  await installations.list(BINDING, TOKEN);
  assert.equal(github.calls.length, 2);

  // A reconnect gives the slot a new generation: never the old login's list.
  await installations.list({ ...BINDING, generation: 2 }, TOKEN);
  assert.equal(github.calls.length, 4);
  await installations.list({ ...BINDING, ownerAccountId: "acct-2" }, TOKEN);
  assert.equal(github.calls.length, 6);

  installations.clear(BINDING);
  await installations.list(BINDING, TOKEN);
  assert.equal(github.calls.length, 8);
});

test("a reconnect's list replaces the old login's, which is read again if ever asked for", async () => {
  const { installations, github } = await setup(oneInstallation());
  await installations.list(BINDING, TOKEN);
  await installations.list({ ...BINDING, generation: 2 }, TOKEN);
  assert.equal(github.calls.length, 4);

  await installations.list(BINDING, TOKEN);
  assert.equal(github.calls.length, 6);
});

// GitHub answers only once the test lets it.
async function heldSetup(script = oneInstallation()) {
  const [{ createGithubInstallations }, { createGithubApi }] = await Promise.all([
    loadInstallations(),
    loadApi(),
  ]);
  const github = fakeGithubFetch(script);
  let release;
  const held = new Promise((resolve) => {
    release = resolve;
  });
  const signals = [];
  const api = createGithubApi({
    fetchImpl: async (url, init) => {
      signals.push(init.signal);
      await held;
      return github.fetchImpl(url, init);
    },
    sleep: async () => {},
    now: () => NOW,
  });
  const installations = createGithubInstallations({ api, now: () => NOW });
  const reads = () => github.calls.filter((call) => call.path === "/user/installations").length;
  return { installations, release, signals, reads };
}

test("lists asked for at once share one read", async () => {
  const { installations, release, reads } = await heldSetup();
  const controller = new AbortController();

  const lists = Promise.all([
    installations.list(BINDING, TOKEN),
    installations.list(BINDING, TOKEN, { signal: controller.signal }),
    installations.listFinding(BINDING, TOKEN, () => true),
  ]);
  release();

  assert.deepEqual(
    (await lists).map((listed) => listed.repos.length),
    [2, 2, 2]
  );
  assert.equal(reads(), 1);
});

test("a read someone still waits on isn't stopped when another caller gives up", async () => {
  const { installations, release, signals } = await heldSetup();
  const controller = new AbortController();

  const waited = installations.list(BINDING, TOKEN);
  const gaveUp = installations.list(BINDING, TOKEN, { signal: controller.signal });
  controller.abort();
  assert.equal((await gaveUp).errorCode, "timeout");
  assert.ok(signals.every((signal) => !signal.aborted));

  release();
  assert.equal((await waited).repos.length, 2);
});

test("a read in flight when the list is cleared never puts the old list back", async () => {
  const stale = await heldSetup();
  const landing = stale.installations.list(BINDING, TOKEN);
  await new Promise((resolve) => setImmediate(resolve));
  stale.installations.clear(BINDING);
  stale.release();
  await landing;
  await stale.installations.list(BINDING, TOKEN);
  assert.equal(stale.reads(), 2);

  // Asked for after the clear: a read of its own, not the one in flight.
  const fresh = await heldSetup();
  const before = fresh.installations.list(BINDING, TOKEN);
  await new Promise((resolve) => setImmediate(resolve));
  fresh.installations.clear(BINDING);
  const after = fresh.installations.list(BINDING, TOKEN);
  fresh.release();
  await Promise.all([before, after]);
  assert.equal(fresh.reads(), 2);
});

test("a failed read is reported, never cached, and never half a list", async () => {
  const outage = await setup({
    [INSTALLATIONS]: [json({ message: "Server Error" }, 502), installationsPage([])],
  });
  const failed = await outage.installations.list(BINDING, TOKEN);
  assert.equal(failed.ok, false);
  assert.equal(failed.outcome, "unknown");
  assert.equal(failed.errorCode, "http_502");
  assert.deepEqual(await outage.installations.list(BINDING, TOKEN), {
    ok: true,
    repos: [],
    truncated: false,
  });

  const partial = await setup({
    [INSTALLATIONS]: [installationsPage([installation(1, "acme"), installation(2, "dana")])],
    [reposOf(1)]: [reposPage([ACME_API])],
    [reposOf(2)]: [json({ message: "Bad credentials" }, 401)],
  });
  const listed = await partial.installations.list(BINDING, TOKEN);
  assert.equal(listed.ok, false);
  assert.equal(listed.errorCode, "unauthorized");
});

test("a read the caller gave up on reports a timeout and is never cached, even when it lands", async () => {
  const [{ createGithubInstallations }, { createGithubApi }] = await Promise.all([
    loadInstallations(),
    loadApi(),
  ]);
  const github = fakeGithubFetch(oneInstallation());
  let release;
  const held = new Promise((resolve) => {
    release = resolve;
  });
  const signals = [];
  // GitHub answers only once the test lets it, after the caller gave up.
  const api = createGithubApi({
    fetchImpl: async (url, init) => {
      signals.push(init.signal);
      await held;
      return github.fetchImpl(url, init);
    },
    sleep: async () => {},
    now: () => NOW,
  });
  const installations = createGithubInstallations({ api, now: () => NOW });
  const controller = new AbortController();

  const pending = installations.list(BINDING, TOKEN, { signal: controller.signal });
  controller.abort();
  assert.deepEqual(await pending, { ok: false, outcome: "unknown", errorCode: "timeout" });
  // The request itself is stopped, not left paging through GitHub.
  assert.ok(signals.length > 0 && signals.every((signal) => signal.aborted));

  release();
  await new Promise((resolve) => setImmediate(resolve));
  const fresh = await installations.list(BINDING, TOKEN);
  assert.equal(fresh.repos.length, 2);
  // The late answer wasn't kept: the next list read GitHub again.
  assert.equal(github.calls.filter((call) => call.path === "/user/installations").length, 2);
});

test("a repo is resolved by owner/name in any case, or by a bare name only one repo has", async () => {
  const { installations } = await setup(twoInstallations());

  assert.deepEqual(await installations.resolveRepo(BINDING, TOKEN, "ACME/Api"), {
    ok: true,
    repo: {
      owner: "acme",
      name: "api",
      fullName: "acme/api",
      hasIssues: true,
      archived: false,
      canPush: false,
      updatedAt: "2026-09-27T10:00:00Z",
    },
  });
  assert.equal(
    (await installations.resolveRepo(BINDING, TOKEN, " notes ")).repo.fullName,
    "dana/notes"
  );
  assert.equal((await installations.resolveRepo(BINDING, TOKEN, "WEB")).repo.fullName, "acme/web");
});

test("a bare name two installed repos share is a question listing owner/name", async () => {
  const { installations } = await setup(twoInstallations());

  assert.deepEqual(await installations.resolveRepo(BINDING, TOKEN, "api"), {
    ok: false,
    clarification: {
      message: "Several installed repositories are named api. Ask the user which one.",
      candidates: ["acme/api", "dana/api"],
    },
  });
});

// One installation listing `repositories`, cut at the read limit when
// `truncated` (every later page is empty and links to another).
function installedOnly(repositories, { truncated = false } = {}) {
  const more = next("/user/installations/2/repositories", 2);
  return {
    [INSTALLATIONS]: [installationsPage([installation(2, "acme")])],
    [reposOf(2)]: truncated
      ? [reposPage(repositories, more), reposPage([], more)]
      : [reposPage(repositories)],
  };
}

test("a bare name as said aloud finds the repo it nearly names, an exact name first", async () => {
  const OPEN_WHISPR = repo("acme/open-whispr", "2026-09-27T10:00:00Z");
  const { installations } = await setup(installedOnly([OPEN_WHISPR, ACME_WEB]));
  for (const input of ["open whispr", "openwhispr", "Open_Whispr", "open"]) {
    assert.equal(
      (await installations.resolveRepo(BINDING, TOKEN, input)).repo?.fullName,
      "acme/open-whispr",
      input
    );
  }

  const both = await setup(
    installedOnly([OPEN_WHISPR, repo("acme/openwhispr", "2026-09-26T10:00:00Z")])
  );
  assert.equal(
    (await both.installations.resolveRepo(BINDING, TOKEN, "OpenWhispr")).repo.fullName,
    "acme/openwhispr"
  );

  // An owner/name is never matched loosely.
  assert.equal(
    (await both.installations.resolveRepo(BINDING, TOKEN, "acme/open whispr")).errorCode,
    "not_installed"
  );
});

test("a bare name that nearly names several repos is a question", async () => {
  const { installations } = await setup(
    installedOnly([
      repo("acme/whisper-api", "2026-09-27T10:00:00Z"),
      repo("acme/whisper-web", "2026-09-26T10:00:00Z"),
      repo("acme/docs", "2026-09-25T10:00:00Z"),
    ])
  );

  assert.deepEqual(await installations.resolveRepo(BINDING, TOKEN, "whisper"), {
    ok: false,
    clarification: {
      message: "Several installed repositories match whisper. Ask the user which one.",
      candidates: ["acme/whisper-api", "acme/whisper-web"],
    },
  });
});

test("a list cut at the read limit finds only an exact name, since a looser one may be unread", async () => {
  const { installations } = await setup(
    installedOnly([repo("acme/open-whispr", "2026-09-27T10:00:00Z")], { truncated: true })
  );

  assert.deepEqual(await installations.resolveRepo(BINDING, TOKEN, "open whispr"), {
    ok: false,
    errorCode: "repo_unlisted",
  });
  assert.equal(
    (await installations.resolveRepo(BINDING, TOKEN, "Open-Whispr")).repo.fullName,
    "acme/open-whispr"
  );
});

test("with no repo named, one installed repo is used and several are a question", async () => {
  const single = await setup({
    [INSTALLATIONS]: [installationsPage([installation(2, "dana")])],
    [reposOf(2)]: [reposPage([DANA_NOTES])],
  });
  assert.equal(
    (await single.installations.resolveRepo(BINDING, TOKEN)).repo.fullName,
    "dana/notes"
  );
  assert.equal(
    (await single.installations.resolveRepo(BINDING, TOKEN, "  ")).repo.fullName,
    "dana/notes"
  );

  const several = await setup(twoInstallations());
  assert.deepEqual(await several.installations.resolveRepo(BINDING, TOKEN, undefined), {
    ok: false,
    clarification: {
      message: "Ask the user which repository to use.",
      candidates: ["dana/notes", "acme/api", "dana/api", "acme/web"],
    },
  });
});

test("for a new issue, the question leaves out archived repos and ones with issues turned off", async () => {
  const script = twoInstallations();
  script[reposOf(2)] = [
    reposPage([
      DANA_API,
      DANA_NOTES,
      repo("dana/old", "2026-09-26T10:00:00Z", { archived: true }),
      repo("old/api", "2026-09-10T10:00:00Z", { archived: true }),
    ]),
  ];
  const { installations } = await setup(script);
  const forNewIssue = { forNewIssue: true };

  assert.deepEqual(
    (await installations.resolveRepo(BINDING, TOKEN, undefined, forNewIssue)).clarification
      .candidates,
    ["dana/notes", "acme/api", "acme/web"]
  );
  // dana/api has issues off and old/api is archived: of three repos named
  // api, acme/api is the one that can take the issue, so there's no question.
  assert.equal(
    (await installations.resolveRepo(BINDING, TOKEN, "api", forNewIssue)).repo.fullName,
    "acme/api"
  );
  // Anything else (a search) is offered every repo.
  assert.deepEqual((await installations.resolveRepo(BINDING, TOKEN)).clarification.candidates, [
    "dana/notes",
    "acme/api",
    "dana/old",
    "dana/api",
    "acme/web",
    "old/api",
  ]);
  // Naming a repo still finds it: prepare says why it can't take the issue.
  assert.equal(
    (await installations.resolveRepo(BINDING, TOKEN, "dana/old", forNewIssue)).repo.fullName,
    "dana/old"
  );
});

test("for a new issue, no repo that can take one is a refusal, never an empty question", async () => {
  const { installations } = await setup(
    installedOnly([
      repo("acme/api", "2026-09-27T10:00:00Z", { archived: true }),
      repo("dana/api", "2026-09-26T10:00:00Z", { has_issues: false }),
      repo("acme/web", "2026-09-25T10:00:00Z", { archived: true }),
    ])
  );
  const forNewIssue = { forNewIssue: true };

  assert.deepEqual(await installations.resolveRepo(BINDING, TOKEN, undefined, forNewIssue), {
    ok: false,
    errorCode: "issues_disabled",
    message:
      "None of the installed repositories can take a new issue: each is archived or has issues turned off.",
  });
  assert.deepEqual(await installations.resolveRepo(BINDING, TOKEN, "api", forNewIssue), {
    ok: false,
    errorCode: "issues_disabled",
    message:
      "None of the installed repositories named api can take a new issue: each is archived or has issues turned off.",
  });
});

test("a suspended installation is skipped, so its 403 never fails the others", async () => {
  const { installations, github } = await setup({
    [INSTALLATIONS]: [
      installationsPage([
        { ...installation(1, "acme"), suspended_at: "2026-09-01T00:00:00Z" },
        installation(2, "dana"),
      ]),
    ],
    [reposOf(1)]: [json({ message: "This installation has been suspended" }, 403)],
    [reposOf(2)]: [reposPage([DANA_NOTES])],
  });

  const listed = await installations.list(BINDING, TOKEN);

  assert.equal(listed.ok, true);
  assert.deepEqual(
    listed.repos.map((entry) => entry.fullName),
    ["dana/notes"]
  );
  assert.equal(
    github.calls.filter((call) => call.path === "/user/installations/1/repositories").length,
    0
  );
});

test("a repo the App isn't installed on is named in the refusal; none installed is its own refusal", async () => {
  const { installations } = await setup(twoInstallations());
  // The connector words the refusal, with the App's install link.
  assert.deepEqual(await installations.resolveRepo(BINDING, TOKEN, "acme/secret"), {
    ok: false,
    errorCode: "not_installed",
  });
  assert.equal(
    (await installations.resolveRepo(BINDING, TOKEN, "infra")).errorCode,
    "not_installed"
  );

  const none = await setup({ [INSTALLATIONS]: [installationsPage([])] });
  for (const input of [undefined, "acme/api", "api"]) {
    assert.deepEqual(
      await none.installations.resolveRepo(BINDING, TOKEN, input),
      { ok: false, errorCode: "no_repositories" },
      String(input)
    );
  }
});

test("resolving a repo passes a failed list read through", async () => {
  const { installations } = await setup({ [INSTALLATIONS]: [json({ message: "x" }, 401)] });

  const refused = await installations.resolveRepo(BINDING, TOKEN, "acme/api");

  assert.equal(refused.ok, false);
  assert.equal(refused.outcome, "failed");
  assert.equal(refused.errorCode, "unauthorized");
});

test("a repo missing from a list older than 5 s is looked for once more, and a younger list is trusted", async () => {
  const { REFETCH_AFTER_MS } = await loadInstallations();
  assert.equal(REFETCH_AFTER_MS, 5000);
  const installedLater = () => ({
    [INSTALLATIONS]: [installationsPage([installation(2, "dana")])],
    [reposOf(2)]: [reposPage([DANA_NOTES]), reposPage([DANA_NOTES, ACME_WEB])],
  });
  const reads = (github) =>
    github.calls.filter((call) => call.path === "/user/installations").length;

  for (const input of ["acme/web", "web"]) {
    const { installations, github, clock } = await setup(installedLater());
    await installations.list(BINDING, TOKEN);

    clock.now = NOW + REFETCH_AFTER_MS - 1;
    assert.equal(
      (await installations.resolveRepo(BINDING, TOKEN, input)).errorCode,
      "not_installed",
      input
    );
    assert.equal(reads(github), 1, input);

    clock.now = NOW + REFETCH_AFTER_MS;
    assert.equal(
      (await installations.resolveRepo(BINDING, TOKEN, input)).repo.fullName,
      "acme/web",
      input
    );
    assert.equal(reads(github), 2, input);
  }

  // Found in the cached list: never read again.
  const { installations, github, clock } = await setup(installedLater());
  await installations.list(BINDING, TOKEN);
  clock.now = NOW + REFETCH_AFTER_MS;
  assert.equal(
    (await installations.resolveRepo(BINDING, TOKEN, "notes")).repo.fullName,
    "dana/notes"
  );
  assert.equal(reads(github), 1);
});

test("with no repository installed yet, an older list is read again before refusing", async () => {
  const { installations, clock } = await setup({
    [INSTALLATIONS]: [installationsPage([]), installationsPage([installation(2, "dana")])],
    [reposOf(2)]: [reposPage([DANA_NOTES])],
  });
  await installations.list(BINDING, TOKEN);
  clock.now = NOW + 5000;

  assert.equal((await installations.resolveRepo(BINDING, TOKEN)).repo.fullName, "dana/notes");
  assert.equal(
    (await installations.listFinding(BINDING, TOKEN, (repos) => repos.length > 0)).repos.length,
    1
  );
});
