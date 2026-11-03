const test = require("node:test");
const assert = require("node:assert/strict");
const React = require("react");
const { createRendererServer } = require("../lib/rendererTestHarness");
const {
  ENGLISH_I18N_MOCK,
  installHappyDom,
  interactions,
  readable,
  text,
} = require("../lib/happyDomDialog");

// Mounts the real menu with the real Radix dropdown and dialog in happy-dom. The services and the
// store are fakes the tests steer; strings come from the English file, so a missing key shows up
// as a missing label.

let CloudApiError;
let AddToTeamspaceMenu;
let createRoot;
let happyWindow;
let ui;
let vite;

test.before(async (t) => {
  ({ happyWindow, createRoot } = await installHappyDom());
  ui = interactions(happyWindow);
  vite = await createRendererServer(t, {
    cachePrefix: "openwhispr-add-to-teamspace-menu-",
    noExternal: ["react-i18next"],
    mockModules: {
      "react-i18next": ENGLISH_I18N_MOCK,
      "/i18n": "export default { t: (key) => key, language: 'en' };",
      "/ui/useToast":
        "export const useToast = () => ({ toast: (toast) => globalThis.__toasts.push(toast) });",
      "/stores/workspaceStore": `
        export const useWorkspaceStore = Object.assign(
          (selector) => selector(globalThis.__store),
          { getState: () => globalThis.__store }
        );
      `,
      "/services/SpacesService": `
        export const SpacesService = {
          listInWorkspace: (id) => globalThis.__api.listInWorkspace(id),
          coverage: (id, userIds) => globalThis.__api.coverage(id, userIds),
        };
      `,
      "/services/spaceActions": `
        export const addPeopleToSpace = (id, userIds) => globalThis.__api.addPeopleToSpace(id, userIds);
        export const localSpaceIdFor = (id) => globalThis.__api.localSpaceIdFor(id);
      `,
    },
  });
  ({ CloudApiError } = await vite.ssrLoadModule("/services/cloudApi.ts"));
  ({ AddToTeamspaceMenu } = await vite.ssrLoadModule(
    "/components/workspace/AddToTeamspaceMenu.tsx"
  ));
});

test.after(async () => {
  await happyWindow.happyDOM.close();
});

const h = React.createElement;
const doc = () => happyWindow.document;

// ---- fixtures

const space = (id, name, emoji, overrides = {}) => ({
  id,
  workspace_id: "w1",
  name,
  description: null,
  emoji,
  member_count: 3,
  teams: [],
  ...overrides,
});

// Customer Calls has none of the selected people, Planning one of them, Engineering both.
const SPACES = [
  space("cloud-calls", "Customer Calls", "📞"),
  space("cloud-plan", "Planning", "🚀"),
  space("cloud-eng", "Engineering", "🔧"),
];
const COVERAGE = [
  { space_id: "cloud-plan", count: 1 },
  { space_id: "cloud-eng", count: 2 },
];

const WORKSPACE = { id: "w1", name: "Acme", role: "admin" };

const person = (userId, name) => ({
  user_id: userId,
  name,
  email: `${userId}@openronnie.com`,
  image: null,
  role: "member",
  joined_at: "2026-01-01T00:00:00Z",
});
const LUCAS = person("lucas", "Lucas");
const MASON = person("mason", "Mason");

const deferred = () => {
  let resolve;
  let reject;
  const promise = new Promise((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
};

// What a test steers: how the fakes answer. Each test gets its own calls log.
async function mount(
  t,
  {
    people = [LUCAS, MASON],
    spaces = SPACES,
    coverage = COVERAGE,
    onOpenTeamspace = true,
    api = {},
    localIds = { "cloud-eng": 42 },
  } = {}
) {
  const calls = [];
  const added = [];
  const opened = [];
  let currentSpaces = spaces;
  globalThis.__toasts = [];
  globalThis.__store = {
    refreshMembers: async (workspaceId) => {
      calls.push(["roster", workspaceId]);
    },
  };
  globalThis.__api = {
    listInWorkspace: async (workspaceId) => {
      calls.push(["list", workspaceId]);
      if (api.listInWorkspace) return api.listInWorkspace(workspaceId);
      return currentSpaces;
    },
    coverage: async (workspaceId, userIds) => {
      calls.push(["coverage", workspaceId, userIds]);
      if (api.coverage) return api.coverage(workspaceId, userIds);
      return coverage;
    },
    addPeopleToSpace: async (cloudSpaceId, userIds) => {
      calls.push(["add", cloudSpaceId, userIds]);
      if (api.addPeopleToSpace) return api.addPeopleToSpace(cloudSpaceId, userIds);
      return { added: userIds, already_members: [] };
    },
    localSpaceIdFor: async (cloudSpaceId) => {
      calls.push(["local", cloudSpaceId]);
      return localIds[cloudSpaceId] ?? null;
    },
  };

  const container = doc().createElement("div");
  doc().body.appendChild(container);
  const root = createRoot(container);
  t.after(async () => {
    await React.act(async () => root.unmount());
    container.remove();
    for (const name of ["__toasts", "__store", "__api"]) delete globalThis[name];
  });
  const props = {
    workspace: WORKSPACE,
    people,
    onAdded: () => added.push(people.map((member) => member.user_id)),
    onOpenTeamspace: onOpenTeamspace ? (localId) => opened.push(localId) : undefined,
  };
  await React.act(async () => {
    root.render(h(AddToTeamspaceMenu, props));
  });
  await ui.settle();
  return {
    calls,
    added,
    opened,
    callsTo: (name) => calls.filter(([call]) => call === name),
    // What the directory returns from the next read on.
    setSpaces: (next) => {
      currentSpaces = next;
    },
    rerender: async (nextPeople) => {
      await React.act(async () =>
        root.render(h(AddToTeamspaceMenu, { ...props, people: nextPeople }))
      );
      await ui.settle();
    },
  };
}

// ---- reading the screen

const trigger = () => doc().querySelector("button[aria-haspopup='menu']");
const rows = () => [...doc().querySelectorAll('[role="menuitemcheckbox"]')];
const rowFor = (name) => rows().find((row) => text(row).includes(name));
// The emoji is decoration beside the name, so `text` leaves it out; this reads it.
const emojiOf = (row) => row.querySelector(".font-emoji")?.textContent ?? null;
const menuText = () => {
  const menu = doc().querySelector('[role="menu"]');
  return menu ? text(menu) : null;
};
const dialogs = () => [...doc().querySelectorAll('[role="dialog"]')];
const dialogText = () => (dialogs().at(-1) ? text(dialogs().at(-1)) : null);
const dialogButton = (label) =>
  [...(dialogs().at(-1)?.querySelectorAll("button") ?? [])].find(
    (button) => text(button) === label
  );
const toastTitles = () => globalThis.__toasts.map((toast) => readable(toast.title ?? ""));

// Radix opens a dropdown on ArrowDown from its trigger.
async function openMenu() {
  await ui.press(trigger(), "ArrowDown");
  await ui.settle();
}

async function choose(name) {
  await ui.click(rowFor(name));
  await ui.settle();
}

// ---- the menu

test("the directory is read when the menu first opens, not before", async (t) => {
  const { callsTo } = await mount(t);

  assert.equal(text(trigger()), "Add to teamspace");
  assert.equal(callsTo("list").length, 0);
  assert.equal(callsTo("coverage").length, 0);

  await openMenu();
  assert.equal(callsTo("list").length, 1);
  assert.deepEqual(callsTo("coverage"), [["coverage", "w1", ["lucas", "mason"]]]);
});

test("the list says it is loading, then offers each teamspace with its emoji", async (t) => {
  const listing = deferred();
  await mount(t, { api: { listInWorkspace: () => listing.promise } });

  await openMenu();
  assert.equal(menuText(), "Loading teamspaces…");

  await React.act(async () => listing.resolve(SPACES));
  await ui.settle();
  assert.deepEqual(rows().map(text), ["Customer Calls", "Planning", "Engineering"]);
  assert.deepEqual(rows().map(emojiOf), ["📞", "🚀", "🔧"]);
});

test("a failed list says so and Try again reads it again", async (t) => {
  let attempts = 0;
  const { callsTo } = await mount(t, {
    api: {
      listInWorkspace: async () => {
        attempts += 1;
        if (attempts === 1) throw new CloudApiError("Cloud API request failed", 0);
        return SPACES;
      },
    },
  });

  await openMenu();
  assert.match(menuText(), /Couldn't load teamspaces/);
  const retry = [...doc().querySelectorAll('[role="menuitem"]')].find(
    (item) => text(item) === "Try again"
  );
  await ui.click(retry);
  await ui.settle();

  assert.equal(callsTo("list").length, 2);
  // The menu stayed open for the list to load into.
  assert.equal(rows().length, 3);
});

test("no teamspaces says so, and there is nothing to pick", async (t) => {
  await mount(t, { spaces: [] });

  await openMenu();
  const item = [...doc().querySelectorAll('[role="menuitem"]')].find(
    (candidate) => text(candidate) === "No teamspaces yet"
  );
  assert.ok(item, "the empty message");
  assert.equal(item.getAttribute("aria-disabled"), "true");
  assert.equal(rows().length, 0);
});

test("each teamspace shows none, some or all for the selected people", async (t) => {
  await mount(t);

  await openMenu();
  assert.equal(rowFor("Customer Calls").getAttribute("aria-checked"), "false");
  assert.equal(rowFor("Planning").getAttribute("aria-checked"), "mixed");
  assert.equal(rowFor("Engineering").getAttribute("aria-checked"), "true");

  // The box draws a dash for some, a tick for all, and nothing for none.
  const mark = (row) => row.querySelector("[data-icon]")?.getAttribute("data-icon") ?? null;
  assert.equal(mark(rowFor("Customer Calls")), null);
  assert.equal(mark(rowFor("Planning")), "minus");
  assert.equal(mark(rowFor("Engineering")), "check");
});

test("the boxes follow the people selected at each opening", async (t) => {
  const { callsTo, rerender } = await mount(t, {
    api: {
      coverage: async (_workspaceId, userIds) =>
        userIds.length === 1 ? [{ space_id: "cloud-plan", count: 1 }] : COVERAGE,
    },
  });

  await openMenu();
  assert.equal(rowFor("Planning").getAttribute("aria-checked"), "mixed");
  await ui.press(doc().querySelector('[role="menu"]'), "Escape");
  await ui.settle();

  await rerender([LUCAS]);
  await openMenu();
  assert.deepEqual(callsTo("coverage").at(-1), ["coverage", "w1", ["lucas"]]);
  // One person selected and one already in: everyone selected has access.
  assert.equal(rowFor("Planning").getAttribute("aria-checked"), "true");
  assert.equal(rowFor("Engineering").getAttribute("aria-checked"), "false");
});

test("a late answer for an earlier opening never overwrites the current boxes", async (t) => {
  const reads = [deferred(), deferred()];
  const { rerender } = await mount(t, { api: { coverage: () => reads.shift().promise } });
  const [first, second] = [...reads];

  await openMenu();
  await ui.press(doc().querySelector('[role="menu"]'), "Escape");
  await ui.settle();
  await rerender([LUCAS]);
  await openMenu();

  await React.act(async () => second.resolve([{ space_id: "cloud-plan", count: 1 }]));
  await ui.settle();
  // The first opening was for two people; its answer lands last and belongs to nobody now.
  await React.act(async () => first.resolve(COVERAGE));
  await ui.settle();

  assert.equal(rowFor("Planning").getAttribute("aria-checked"), "true");
  assert.equal(rowFor("Engineering").getAttribute("aria-checked"), "false");
});

test("a teamspace everyone is already in can't be picked", async (t) => {
  const { callsTo } = await mount(t);

  await openMenu();
  const engineering = rowFor("Engineering");
  assert.equal(engineering.getAttribute("aria-disabled"), "true");
  await ui.click(engineering);
  await ui.settle();

  assert.equal(callsTo("add").length, 0);
  assert.equal(dialogs().length, 0);
});

test("a failed coverage read leaves the boxes empty and adding still works", async (t) => {
  const { callsTo, added } = await mount(t, {
    api: {
      coverage: async () => {
        throw new CloudApiError("Cloud API request failed", 0);
      },
    },
  });

  await openMenu();
  assert.deepEqual(
    rows().map((row) => row.getAttribute("aria-checked")),
    ["false", "false", "false"]
  );
  await choose("Engineering");

  assert.deepEqual(callsTo("add"), [["add", "cloud-eng", ["lucas", "mason"]]]);
  assert.deepEqual(added, [["lucas", "mason"]]);
});

// ---- adding

test("choosing sends one request with everyone", async (t) => {
  const request = deferred();
  const { callsTo } = await mount(t, { api: { addPeopleToSpace: () => request.promise } });

  await openMenu();
  await choose("Customer Calls");

  assert.deepEqual(callsTo("add"), [["add", "cloud-calls", ["lucas", "mason"]]]);
  // The menu closed and a dialog holds the screen while it runs.
  assert.equal(doc().querySelector('[role="menu"]'), null);
  assert.match(dialogText(), /Adding 2 people…/);
  assert.match(dialogText(), /Keep this window open while they're added to Customer Calls\./);
  assert.equal(dialogButton("Adding…").disabled, true);
  assert.equal(dialogButton("Cancel"), undefined);

  await React.act(async () => request.resolve({ added: ["lucas", "mason"], already_members: [] }));
  await ui.settle();
  assert.equal(dialogs().length, 0);
});

test("success clears the selection and offers Open teamspace", async (t) => {
  const { added, opened, callsTo } = await mount(t, {
    localIds: { "cloud-calls": 7 },
    api: { addPeopleToSpace: async () => ({ added: ["lucas", "mason"], already_members: [] }) },
  });

  await openMenu();
  await choose("Customer Calls");

  assert.deepEqual(added, [["lucas", "mason"]]);
  assert.equal(dialogs().length, 0);
  assert.deepEqual(toastTitles(), ["Added 2 people to Customer Calls"]);
  assert.equal(globalThis.__toasts[0].actions.length, 1);
  assert.equal(globalThis.__toasts[0].actions[0].label, "Open teamspace");

  assert.deepEqual(opened, []);
  await React.act(async () => globalThis.__toasts[0].actions[0].onClick());
  // The page opens the teamspace as the local mirror knows it.
  assert.deepEqual(callsTo("local"), [["local", "cloud-calls"]]);
  assert.deepEqual(opened, [7]);
});

test("Open teamspace says so when the mirror has no copy yet", async (t) => {
  const { opened } = await mount(t, { localIds: {} });

  await openMenu();
  await choose("Customer Calls");
  await React.act(async () => globalThis.__toasts[0].actions[0].onClick());

  assert.deepEqual(opened, []);
  assert.equal(globalThis.__toasts.length, 2);
  assert.equal(globalThis.__toasts[1].variant, "destructive");
});

test("the toast has no Open teamspace action when the page can't open one", async (t) => {
  await mount(t, { onOpenTeamspace: false });

  await openMenu();
  await choose("Customer Calls");

  assert.deepEqual(toastTitles(), ["Added 2 people to Customer Calls"]);
  assert.equal(globalThis.__toasts[0].actions, undefined);
});

test("the toast counts who was added, or everyone when nobody new was", async (t) => {
  const answers = [
    { added: ["lucas"], already_members: ["mason"] },
    { added: [], already_members: ["lucas", "mason"] },
  ];
  await mount(t, { api: { addPeopleToSpace: async () => answers.shift() } });

  await openMenu();
  await choose("Customer Calls");
  assert.deepEqual(toastTitles(), ["Added 1 person to Customer Calls"]);

  await openMenu();
  await choose("Customer Calls");
  assert.deepEqual(toastTitles().at(-1), "Added 2 people to Customer Calls");
});

test("a failure keeps the selection and offers Try again", async (t) => {
  let attempts = 0;
  const { callsTo, added } = await mount(t, {
    api: {
      addPeopleToSpace: async (_id, userIds) => {
        attempts += 1;
        if (attempts === 1) throw new CloudApiError("Cloud API request failed", 0);
        return { added: userIds, already_members: [] };
      },
    },
  });

  await openMenu();
  await choose("Customer Calls");

  assert.match(dialogText(), /Couldn't add 2 people/);
  assert.match(
    dialogText(),
    /They haven't been added to Customer Calls\. Your selection is kept\. Check your connection and try again\./
  );
  assert.deepEqual(added, []);
  assert.deepEqual(toastTitles(), []);

  await ui.click(dialogButton("Try again"));
  await ui.settle();

  // The same request, to the same teamspace, with the same people.
  assert.deepEqual(callsTo("add"), [
    ["add", "cloud-calls", ["lucas", "mason"]],
    ["add", "cloud-calls", ["lucas", "mason"]],
  ]);
  assert.equal(dialogs().length, 0);
  assert.deepEqual(added, [["lucas", "mason"]]);
  assert.deepEqual(toastTitles(), ["Added 2 people to Customer Calls"]);
});

test("Cancel on a failure leaves the selection as it was", async (t) => {
  const { added } = await mount(t, {
    api: {
      addPeopleToSpace: async () => {
        throw new CloudApiError("Cloud API request failed", 0);
      },
    },
  });

  await openMenu();
  await choose("Customer Calls");
  await ui.click(dialogButton("Cancel"));
  await ui.settle();

  assert.equal(dialogs().length, 0);
  assert.deepEqual(added, []);
  assert.deepEqual(toastTitles(), []);
  // The menu still works for another try.
  await openMenu();
  assert.equal(rows().length, 3);
});

test("a retry after a lost answer succeeds", async (t) => {
  const answers = [
    () => {
      throw new CloudApiError("Cloud API request failed", 0);
    },
    () => ({ added: [], already_members: ["lucas", "mason"] }),
  ];
  const { added } = await mount(t, { api: { addPeopleToSpace: async () => answers.shift()() } });

  await openMenu();
  await choose("Customer Calls");
  assert.match(dialogText(), /Couldn't add 2 people/);
  await ui.click(dialogButton("Try again"));
  await ui.settle();

  // The first attempt did land; the second finds everyone in and still counts as done.
  assert.equal(dialogs().length, 0);
  assert.deepEqual(toastTitles(), ["Added 2 people to Customer Calls"]);
  assert.deepEqual(added, [["lucas", "mason"]]);
});

test("someone who left meanwhile shows the server's wording and reads the roster again", async (t) => {
  const { callsTo, added } = await mount(t, {
    api: {
      addPeopleToSpace: async () => {
        throw new CloudApiError(
          "Mason is no longer a member of Acme",
          400,
          "not_workspace_members",
          {
            user_ids: ["mason"],
          }
        );
      },
    },
  });

  await openMenu();
  await choose("Customer Calls");

  assert.match(dialogText(), /Couldn't add 2 people/);
  assert.match(dialogText(), /Mason is no longer a member of Acme/);
  assert.deepEqual(callsTo("roster"), [["roster", "w1"]]);
  assert.deepEqual(added, []);
  assert.ok(dialogButton("Try again"), "the selection is kept and can be retried");
});

// Built when the test runs: the error class is loaded from the Vite server in `before`.
for (const [label, makeError] of [
  ["deleted", () => new CloudApiError("Space not found", 404, "space_not_found")],
  ["archived", () => new CloudApiError("Space archived", 410, "space_archived")],
]) {
  test(`a teamspace ${label} meanwhile toasts and refreshes`, async (t) => {
    const { callsTo, added, setSpaces } = await mount(t, {
      api: {
        addPeopleToSpace: async () => {
          throw makeError();
        },
      },
    });

    await openMenu();
    assert.equal(rows().length, 3);
    setSpaces(SPACES.filter((candidate) => candidate.id !== "cloud-calls"));
    await choose("Customer Calls");

    // No dialog to retry on: the teamspace is gone, so a failure toast stands in for it.
    assert.equal(dialogs().length, 0);
    assert.deepEqual(toastTitles(), ["Couldn't add 2 people"]);
    assert.equal(globalThis.__toasts[0].variant, "destructive");
    assert.deepEqual(added, []);
    assert.equal(callsTo("list").length, 2, "the directory is read again");

    // The menu reopens on the next press, without the teamspace that went.
    await openMenu();
    assert.deepEqual(rows().map(text), ["Planning", "Engineering"]);
  });
}
