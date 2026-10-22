const test = require("node:test");
const assert = require("node:assert/strict");
const {
  allWordsArePersonal,
  buildPicker,
  defaultAddTarget,
  filterRows,
  listsShowingWord,
  resolveSharedAccessState,
  rowsForList,
  shareTargetsFor,
  shownPersonalWords,
  visiblePersonalWords,
} = require("../../src/components/dictionary/dictionaryViewModel.ts");

const ENGINEERING = "11111111-1111-4111-8111-111111111111";
const SALES = "22222222-2222-4222-8222-222222222222";

const t = (key, options = {}) =>
  key === "dictionary.shared.everyoneAt" ? `Everyone at ${options.workspace}` : key;

const workspace = (overrides = {}) => ({
  id: "ws",
  name: "Acme",
  plan: "business",
  status: "active",
  role: "member",
  ...overrides,
});

const entry = (cloudId, word, spaceId, overrides = {}) => ({
  cloudId,
  spaceId,
  word,
  addedByUserId: "u-ana",
  createdAt: "2026-10-01T00:00:00.000Z",
  updatedAt: "2026-10-01T00:00:00.000Z",
  ...overrides,
});

const snapshot = (entries, overrides = {}) => ({
  entries,
  hiddenIds: [],
  meta: {
    scopes: [
      { space_id: null, name: "Acme", member_count: 12, word_count: 0 },
      { space_id: ENGINEERING, name: "Engineering", member_count: 5, word_count: 0 },
      { space_id: SALES, name: "Sales", member_count: 4, word_count: 0 },
    ],
    contributors: [
      { user_id: "u-ana", name: "Ana", is_member: true },
      { user_id: "u-bob", name: "Bob", is_member: false },
      { user_id: "u-me", name: "Me", is_member: true },
    ],
    paused: false,
    syncedAt: "2026-10-01T00:00:00.000Z",
  },
  ...overrides,
});

const rowInput = (overrides = {}) => ({
  personal: [],
  movedPersonal: [],
  snapshot: null,
  workspaceName: "Acme",
  currentUserId: "u-me",
  access: "available",
  search: "",
  sort: "az",
  ...overrides,
});

const words = (rows) => rows.map((row) => row.word);

test("resolveSharedAccessState: status, workspace, plan and the server's paused flag", () => {
  const base = {
    status: "ready",
    signedIn: true,
    workspace: workspace({ role: "owner" }),
    serverPaused: null,
    hasWords: false,
  };
  assert.equal(resolveSharedAccessState({ ...base, status: "unavailable" }), "unavailable");
  assert.equal(resolveSharedAccessState({ ...base, workspace: null }), "noWorkspace");
  assert.equal(resolveSharedAccessState(base), "available");
  assert.equal(resolveSharedAccessState({ ...base, serverPaused: false }), "available");
});

test("signed out (or in a build without accounts) there is nothing shared to offer", () => {
  const input = { status: "ready", signedIn: false, serverPaused: null, hasWords: false };
  assert.equal(resolveSharedAccessState({ ...input, workspace: null }), "unavailable");
  assert.equal(resolveSharedAccessState({ ...input, workspace: workspace() }), "unavailable");
  // Signed in without a workspace keeps the Business upsell.
  assert.equal(
    resolveSharedAccessState({ ...input, signedIn: true, workspace: null }),
    "noWorkspace"
  );
});

test("SSO and lost access lock the shared lists ahead of any plan state", () => {
  const free = workspace({ plan: "free", role: "owner" });
  for (const status of ["ssoRequired", "noAccess"]) {
    const input = { status, signedIn: true, serverPaused: true, hasWords: true };
    assert.equal(resolveSharedAccessState({ ...input, workspace: workspace() }), status);
    assert.equal(resolveSharedAccessState({ ...input, workspace: free }), status);
    assert.equal(resolveSharedAccessState({ ...input, workspace: null }), "noWorkspace");
  }
});

test("paused workspace with words is paused, without words is an upgrade state", () => {
  const lapsed = (role) => workspace({ plan: "free", role });
  const input = { status: "ready", signedIn: true, serverPaused: true };
  assert.equal(
    resolveSharedAccessState({ ...input, workspace: lapsed("owner"), hasWords: true }),
    "paused"
  );
  assert.equal(
    resolveSharedAccessState({ ...input, workspace: lapsed("member"), hasWords: true }),
    "paused"
  );
  // The API flags every non-Business answer as paused, words or not.
  assert.equal(
    resolveSharedAccessState({ ...input, workspace: lapsed("owner"), hasWords: false }),
    "upgradeAdmin"
  );
  assert.equal(
    resolveSharedAccessState({ ...input, workspace: lapsed("member"), hasWords: false }),
    "upgradeMember"
  );
  const unpaused = {
    status: "ready",
    signedIn: true,
    workspace: lapsed("owner"),
    hasWords: true,
  };
  assert.equal(resolveSharedAccessState({ ...unpaused, serverPaused: false }), "upgradeAdmin");
  assert.equal(resolveSharedAccessState({ ...unpaused, serverPaused: null }), "upgradeAdmin");
});

test("upgrade state depends on whether the role can manage the workspace", () => {
  const input = { status: "ready", signedIn: true, serverPaused: null, hasWords: false };
  const free = (role) => workspace({ plan: "free", role });
  assert.equal(resolveSharedAccessState({ ...input, workspace: free("owner") }), "upgradeAdmin");
  assert.equal(resolveSharedAccessState({ ...input, workspace: free("admin") }), "upgradeAdmin");
  assert.equal(resolveSharedAccessState({ ...input, workspace: free("member") }), "upgradeMember");
  assert.equal(
    resolveSharedAccessState({ ...input, workspace: workspace({ status: "past_due" }) }),
    "upgradeMember"
  );
});

test("buildPicker orders groups and counts applying words", () => {
  const snap = snapshot(
    [
      entry("e1", "Qdrant", null),
      entry("e2", "Kubernetes", ENGINEERING),
      entry("e3", "Quota", SALES),
      entry("e4", "Secret", SALES),
    ],
    { hiddenIds: ["e4"] }
  );
  const picker = buildPicker({
    personal: ["OpenWhispr", "kubernetes"],
    movedPersonal: [],
    snapshot: snap,
    workspaceName: "Acme",
    access: "available",
    t,
  });
  assert.deepEqual(
    picker.map((item) => [item.key, item.group, item.locked, item.count]),
    [
      ["all", "top", false, 4],
      ["personal", "top", false, 2],
      ["allShared", "shared", false, 3],
      ["workspace", "shared", false, 1],
      [`space:${ENGINEERING}`, "shared", false, 1],
      [`space:${SALES}`, "shared", false, 1],
      ["hidden", "bottom", false, 1],
    ]
  );
  assert.equal(picker[3].label, "Everyone at Acme");
  assert.equal(picker[4].label, "Engineering");
});

test("buildPicker locks the shared entries unless access is available", () => {
  for (const access of ["unavailable", "noWorkspace", "upgradeAdmin", "upgradeMember", "paused"]) {
    const picker = buildPicker({
      personal: ["a"],
      movedPersonal: [],
      snapshot: snapshot([entry("e1", "Qdrant", null)]),
      workspaceName: "Acme",
      access,
      t,
    });
    for (const item of picker) {
      assert.equal(item.locked, item.group !== "top", `${access}/${item.key}`);
    }
  }
});

test("owner not in a space gets no space entry", () => {
  const snap = snapshot([entry("e1", "Qdrant", null)]);
  snap.meta.scopes = snap.meta.scopes.filter((scope) => scope.space_id === null);
  const picker = buildPicker({
    personal: [],
    movedPersonal: [],
    snapshot: snap,
    workspaceName: "Acme",
    access: "available",
    t,
  });
  assert.deepEqual(
    picker.map((item) => item.key),
    ["all", "personal", "allShared", "workspace", "hidden"]
  );
});

test("buildPicker counts are null before the shared lists are read", () => {
  const picker = buildPicker({
    personal: ["a", "b"],
    movedPersonal: [],
    snapshot: null,
    workspaceName: "Acme",
    access: "upgradeAdmin",
    t,
  });
  assert.deepEqual(
    picker.map((item) => [item.key, item.count]),
    [
      ["all", 2],
      ["personal", 2],
      ["allShared", null],
      ["workspace", null],
    ]
  );
});

test("without a workspace the picker names the workspace list generically and has no Hidden", () => {
  const picker = buildPicker({
    personal: [],
    movedPersonal: [],
    snapshot: null,
    workspaceName: "",
    access: "noWorkspace",
    t,
  });
  assert.equal(
    picker.find((item) => item.key === "workspace").label,
    "dictionary.shared.locked.workspaceTitle"
  );
  assert.equal(
    picker.find((item) => item.key === "hidden"),
    undefined
  );
  // A paused workspace still lists the words it hid.
  const paused = buildPicker({
    personal: [],
    movedPersonal: [],
    snapshot: snapshot([]),
    workspaceName: "Acme",
    access: "paused",
    t,
  });
  assert.ok(paused.find((item) => item.key === "hidden"));
});

test("a moved word leaves Personal only while its shared copy exists", () => {
  const personal = ["Qdrant", "OpenWhispr"];
  const withCopy = snapshot([entry("e1", "qdrant", null)]);
  assert.deepEqual(visiblePersonalWords(personal, ["Qdrant"], withCopy), ["OpenWhispr"]);
  assert.deepEqual(visiblePersonalWords(personal, ["Qdrant"], snapshot([])), personal);
  assert.deepEqual(visiblePersonalWords(personal, ["Qdrant"], null), personal);
  // Not moved: a teammate's identical word never hides the user's own.
  assert.deepEqual(visiblePersonalWords(personal, [], withCopy), personal);
  // A hidden copy still counts: the server retires the fallback on hide.
  const hiddenCopy = snapshot([entry("e1", "Qdrant", null)], { hiddenIds: ["e1"] });
  assert.deepEqual(visiblePersonalWords(personal, ["Qdrant"], hiddenCopy), ["OpenWhispr"]);
});

test("the Personal list follows the moved-word rule", () => {
  const input = rowInput({ personal: ["Qdrant", "Zed"], movedPersonal: ["Qdrant"] });
  const withCopy = snapshot([entry("e1", "Qdrant", null)]);
  assert.deepEqual(words(rowsForList("personal", { ...input, snapshot: withCopy })), ["Zed"]);
  assert.deepEqual(words(rowsForList("personal", { ...input, snapshot: snapshot([]) })), [
    "Qdrant",
    "Zed",
  ]);
});

test("All words never lists a word twice", () => {
  const moved = rowsForList(
    "all",
    rowInput({
      personal: ["Qdrant"],
      movedPersonal: ["Qdrant"],
      snapshot: snapshot([entry("e1", "Qdrant", null)]),
    })
  );
  assert.equal(moved.length, 1);
  assert.equal(moved[0].kind, "shared");
  assert.equal(moved[0].badge, "Acme");

  const personalWins = rowsForList(
    "all",
    rowInput({
      personal: ["OpenWhispr"],
      snapshot: snapshot([entry("e1", "openwhispr", null)]),
    })
  );
  assert.equal(personalWins.length, 1);
  assert.equal(personalWins[0].kind, "personal");
  assert.equal(personalWins[0].word, "OpenWhispr");
  assert.equal(personalWins[0].badge, null);
});

test("All words: a space row beats a workspace row, hidden words are left out", () => {
  const rows = rowsForList(
    "all",
    rowInput({
      snapshot: snapshot(
        [
          entry("e1", "Qdrant", null),
          entry("e2", "QDRANT", ENGINEERING),
          entry("e3", "Secret", null),
        ],
        { hiddenIds: ["e3"] }
      ),
    })
  );
  assert.equal(rows.length, 1);
  assert.equal(rows[0].entryId, "e2");
  assert.equal(rows[0].badge, "Engineering");
  // The one row stands for both copies, so hiding or deleting it reaches each.
  assert.deepEqual(rows[0].entryIds, ["e2", "e1"]);
  assert.equal(rows[0].otherLists, 1);
});

test("All shared shows one row per list entry", () => {
  const rows = rowsForList(
    "allShared",
    rowInput({
      personal: ["Qdrant"],
      snapshot: snapshot(
        [
          entry("e1", "Qdrant", ENGINEERING),
          entry("e2", "Qdrant", SALES),
          entry("e3", "Qdrant", null),
          entry("e4", "Hidden", null),
        ],
        { hiddenIds: ["e4"] }
      ),
    })
  );
  assert.deepEqual(rows.map((row) => [row.entryId, row.badge]).sort(), [
    ["e1", "Engineering"],
    ["e2", "Sales"],
    ["e3", "Acme"],
  ]);
});

test("single lists show their own entries, attribution and no badge", () => {
  const snap = snapshot([
    entry("e1", "Mine", null, { addedByUserId: "u-me" }),
    entry("e2", "Theirs", null, { addedByUserId: "u-ana" }),
    entry("e3", "Gone", null, { addedByUserId: "u-bob" }),
    entry("e4", "Orphan", null, { addedByUserId: null }),
    entry("e5", "Elsewhere", ENGINEERING),
  ]);
  const rows = rowsForList("workspace", rowInput({ snapshot: snap }));
  assert.deepEqual(
    rows.map((row) => [row.word, row.attribution, row.badge]),
    [
      ["Gone", "former", null],
      ["Mine", "you", null],
      ["Orphan", "former", null],
      ["Theirs", { name: "Ana" }, null],
    ]
  );
  const space = rowsForList(`space:${ENGINEERING}`, rowInput({ snapshot: snap }));
  assert.deepEqual(words(space), ["Elsewhere"]);
});

test("former member attribution", () => {
  const snap = snapshot([
    entry("e1", "FromBob", null, { addedByUserId: "u-bob" }),
    entry("e2", "FromNobody", null, { addedByUserId: null }),
    entry("e3", "FromStranger", null, { addedByUserId: "u-unknown" }),
  ]);
  const rows = rowsForList("workspace", rowInput({ snapshot: snap }));
  assert.deepEqual(
    rows.map((row) => row.attribution),
    ["former", "former", "former"]
  );
});

test("hidden lists hidden entries only", () => {
  const snap = snapshot([entry("e1", "Shown", null), entry("e2", "Tucked", ENGINEERING)], {
    hiddenIds: ["e2"],
  });
  const rows = rowsForList("hidden", rowInput({ personal: ["Mine"], snapshot: snap }));
  assert.deepEqual(
    rows.map((row) => [row.word, row.entryId, row.badge]),
    [["Tucked", "e2", "Engineering"]]
  );
  assert.deepEqual(words(rowsForList("workspace", rowInput({ snapshot: snap }))), ["Shown"]);
  assert.deepEqual(words(rowsForList(`space:${ENGINEERING}`, rowInput({ snapshot: snap }))), []);
});

test("search is a case-insensitive substring match", () => {
  const rows = rowsForList(
    "all",
    rowInput({
      personal: ["OpenWhispr", "Supabase"],
      snapshot: snapshot([entry("e1", "Whisperer", null)]),
      search: " WHISP ",
    })
  );
  assert.deepEqual(words(rows), ["OpenWhispr", "Whisperer"]);
});

test("sort: a-z and z-a ignore case, newest and oldest use createdAt with personal rows last", () => {
  const snap = snapshot([
    entry("e1", "banana", null, { createdAt: "2026-10-02T00:00:00.000Z" }),
    entry("e2", "Apple", ENGINEERING, { createdAt: "2026-10-03T00:00:00.000Z" }),
    entry("e3", "cherry", SALES, { createdAt: "2026-10-01T00:00:00.000Z" }),
  ]);
  const run = (sort) =>
    words(rowsForList("all", rowInput({ personal: ["Zulu"], snapshot: snap, sort })));
  assert.deepEqual(run("az"), ["Apple", "banana", "cherry", "Zulu"]);
  assert.deepEqual(run("za"), ["Zulu", "cherry", "banana", "Apple"]);
  assert.deepEqual(run("newest"), ["Apple", "banana", "cherry", "Zulu"]);
  assert.deepEqual(run("oldest"), ["cherry", "banana", "Apple", "Zulu"]);
});

test("newest and oldest order personal words by when they were added, after dated words", () => {
  const snap = snapshot([
    entry("e1", "banana", null, { createdAt: "2026-10-02T00:00:00.000Z" }),
    entry("e2", "Apple", ENGINEERING, { createdAt: "2026-10-03T00:00:00.000Z" }),
  ]);
  // The settings array keeps insertion order: Zulu first, then Mike, then Alpha.
  const personal = ["Zulu", "Mike", "Alpha"];
  const run = (list, sort) =>
    words(rowsForList(list, rowInput({ personal, snapshot: snap, sort })));
  assert.deepEqual(run("personal", "newest"), ["Alpha", "Mike", "Zulu"]);
  assert.deepEqual(run("personal", "oldest"), ["Zulu", "Mike", "Alpha"]);
  assert.deepEqual(run("all", "newest"), ["Apple", "banana", "Alpha", "Mike", "Zulu"]);
  assert.deepEqual(run("all", "oldest"), ["banana", "Apple", "Zulu", "Mike", "Alpha"]);
});

test("filterRows keeps the sorted order and rowsForList matches it", () => {
  const input = rowInput({ personal: ["beta", "Alpha", "alphabet"], sort: "az" });
  const sorted = rowsForList("personal", input);
  assert.deepEqual(words(filterRows(sorted, "ALPHA")), ["Alpha", "alphabet"]);
  assert.deepEqual(
    words(rowsForList("personal", { ...input, search: "alpha" })),
    words(filterRows(sorted, "alpha"))
  );
});

test("case variants of a personal word get their own row keys", () => {
  const rows = rowsForList("personal", rowInput({ personal: ["Supabase", "supabase"] }));
  assert.equal(new Set(rows.map((row) => row.key)).size, 2);
});

test("shared words dictation leaves out are flagged; personal words never are", () => {
  const long = "x".repeat(65);
  const rows = rowsForList(
    "all",
    rowInput({
      personal: ["{{template}}"],
      snapshot: snapshot([
        entry("e1", "Kubernetes", null),
        entry("e2", long, null),
        entry("e3", "a <b> tag", null),
      ]),
    })
  );
  const used = Object.fromEntries(rows.map((row) => [row.word, row.usedInDictation]));
  assert.deepEqual(used, {
    "{{template}}": true,
    Kubernetes: true,
    [long]: false,
    "a <b> tag": false,
  });
});

test("All words is personal-only while no shared word applies", () => {
  const withWords = snapshot([entry("e1", "Kubernetes", null)]);
  assert.equal(allWordsArePersonal(withWords, "available"), false);
  assert.equal(allWordsArePersonal(withWords, "upgradeMember"), true);
  assert.equal(allWordsArePersonal(snapshot([]), "available"), true);
  assert.equal(
    allWordsArePersonal(
      snapshot([entry("e1", "Kubernetes", null)], { hiddenIds: ["e1"] }),
      "available"
    ),
    true
  );
});

test("defaultAddTarget: the open list's target, else the last used one", () => {
  assert.equal(defaultAddTarget("personal", `${SALES}`), "personal");
  assert.equal(defaultAddTarget("workspace", "personal"), null);
  assert.equal(defaultAddTarget(`space:${ENGINEERING}`, "personal"), ENGINEERING);
  for (const list of ["all", "allShared", "hidden"]) {
    assert.equal(defaultAddTarget(list, SALES), SALES);
    assert.equal(defaultAddTarget(list, "personal"), "personal");
    assert.equal(defaultAddTarget(list, undefined), "personal");
    // null is the workspace list, not "nothing remembered".
    assert.equal(defaultAddTarget(list, null), null);
  }
});

test("shareTargetsFor lists the workspace first, then spaces, with member counts", () => {
  const snap = snapshot([]);
  snap.meta.scopes.reverse();
  assert.deepEqual(shareTargetsFor(["Qdrant"], snap, "Acme", t), [
    { target: null, label: "Everyone at Acme", memberCount: 12, alreadyShared: false },
    { target: SALES, label: "Sales", memberCount: 4, alreadyShared: false },
    { target: ENGINEERING, label: "Engineering", memberCount: 5, alreadyShared: false },
  ]);
});

test("Already shared when the list has the word in another case", () => {
  const snap = snapshot([
    entry("e1", "qdrant", null),
    entry("e2", "Qdrant", ENGINEERING),
    entry("e3", "Kubernetes", ENGINEERING),
  ]);
  const byTarget = (given) =>
    Object.fromEntries(
      shareTargetsFor(given, snap, "Acme", t).map((item) => [
        String(item.target),
        item.alreadyShared,
      ])
    );
  assert.deepEqual(byTarget(["QDRANT"]), { null: true, [ENGINEERING]: true, [SALES]: false });
  // Every word must be there, not just one of them.
  assert.deepEqual(byTarget(["QDRANT", "Kubernetes"]), {
    null: false,
    [ENGINEERING]: true,
    [SALES]: false,
  });
  assert.deepEqual(byTarget([]), { null: false, [ENGINEERING]: false, [SALES]: false });
});

test("paused or locked: All words and Personal show personal words only, moved words included", () => {
  const snap = snapshot([entry("e1", "Qdrant", null), entry("e2", "Kubernetes", ENGINEERING)]);
  const base = {
    personal: ["OpenWhispr", "Qdrant"],
    movedPersonal: ["Qdrant"],
    snapshot: snap,
    workspaceName: "Acme",
  };
  for (const access of ["paused", "upgradeAdmin", "upgradeMember", "unavailable", "noWorkspace"]) {
    const picker = buildPicker({ ...base, access, t });
    const count = (key) => picker.find((item) => item.key === key).count;
    assert.equal(count("all"), 2, access);
    assert.equal(count("personal"), 2, access);
    // The dimmed shared entries keep the real snapshot's counts.
    assert.equal(count("allShared"), 2, access);
    assert.equal(count("workspace"), 1, access);
    const input = rowInput({ ...base, access });
    assert.deepEqual(words(rowsForList("all", input)), ["OpenWhispr", "Qdrant"], access);
    assert.deepEqual(words(rowsForList("personal", input)), ["OpenWhispr", "Qdrant"], access);
    assert.deepEqual(words(rowsForList("allShared", input)), ["Kubernetes", "Qdrant"], access);
  }
});

test("available: a moved word with a live shared copy leaves Personal and All words show shared rows", () => {
  const base = {
    personal: ["OpenWhispr", "Qdrant"],
    movedPersonal: ["Qdrant"],
    snapshot: snapshot([entry("e1", "Qdrant", null), entry("e2", "Kubernetes", ENGINEERING)]),
    workspaceName: "Acme",
  };
  const picker = buildPicker({ ...base, access: "available", t });
  assert.equal(picker.find((item) => item.key === "all").count, 3);
  assert.equal(picker.find((item) => item.key === "personal").count, 1);
  assert.deepEqual(words(rowsForList("personal", rowInput(base))), ["OpenWhispr"]);
});

test("shownPersonalWords is what Personal lists and clear-all and export act on", () => {
  const snap = snapshot([entry("e1", "Qdrant", null)]);
  const personal = ["OpenWhispr", "Qdrant"];
  assert.deepEqual(shownPersonalWords(personal, ["Qdrant"], snap, "available"), ["OpenWhispr"]);
  // A moved word applies at personal priority while shared words don't.
  for (const access of ["paused", "ssoRequired", "upgradeMember", "unavailable"]) {
    assert.deepEqual(shownPersonalWords(personal, ["Qdrant"], snap, access), personal, access);
    assert.deepEqual(
      words(
        rowsForList(
          "personal",
          rowInput({ personal, movedPersonal: ["Qdrant"], snapshot: snap, access })
        )
      ),
      shownPersonalWords(personal, ["Qdrant"], snap, access),
      access
    );
  }
});

test("listsShowingWord names the lists of a word's visible copies, while shared words apply", () => {
  const snap = {
    ...snapshot([
      entry("e1", "Qdrant", null),
      entry("e2", "qdrant", ENGINEERING),
      entry("e3", "Qdrant", SALES),
    ]),
    hiddenIds: ["e3"],
  };
  assert.deepEqual(listsShowingWord("QDRANT", snap, "available"), [null, ENGINEERING]);
  assert.deepEqual(listsShowingWord("Kubernetes", snap, "available"), []);
  assert.deepEqual(listsShowingWord("Qdrant", snap, "paused"), []);
});

test("All words groups spellings dictation treats as one word, Unicode forms included", () => {
  const composed = "Café";
  const decomposed = "Café";
  const rows = rowsForList(
    "all",
    rowInput({
      snapshot: snapshot([entry("e1", decomposed, ENGINEERING), entry("e2", composed, null)]),
    })
  );
  assert.equal(rows.length, 1);
  assert.deepEqual(rows[0].entryIds, ["e1", "e2"]);
  const withPersonal = rowsForList(
    "all",
    rowInput({ personal: [composed], snapshot: snapshot([entry("e1", decomposed, null)]) })
  );
  assert.deepEqual(
    withPersonal.map((row) => row.kind),
    ["personal"]
  );
});
