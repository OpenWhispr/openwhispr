const test = require("node:test");
const assert = require("node:assert/strict");
const React = require("react");
const { createRendererServer } = require("../lib/rendererTestHarness");
const { deferred } = require("../helpers/harness/deferred");
const {
  ENGLISH_I18N_MOCK,
  installHappyDom,
  interactions,
  readable,
} = require("../lib/happyDomDialog");

let Tab;
let CloudApiError;
let createRoot;
let happyWindow;
let ui;
const ADMIN = { id: "w1", name: "Acme", role: "admin", capabilities: { manage_members: true } };
const MEMBER = { ...ADMIN, role: "member", capabilities: { manage_members: false } };
const guest = (ids) => ({
  email: "guest@outside.test",
  name: "Guest",
  image: null,
  notes: ids.map((id) => ({ id, title: id, permission: "viewer", visibility: "invited" })),
});

test.before(async (t) => {
  ({ happyWindow, createRoot } = await installHappyDom());
  ui = interactions(happyWindow);
  const vite = await createRendererServer(t, {
    cachePrefix: "openwhispr-guests-access-",
    noExternal: ["react-i18next"],
    mockModules: {
      "react-i18next": ENGLISH_I18N_MOCK,
      "/i18n": "export default { t: (key) => key, language: 'en' };",
      "/ui/useToast":
        "export const useToast = () => ({ toast: (message) => globalThis.__guestToasts.push(message) });",
      "/InviteTeammateDialog": "export default function InviteTeammateDialog() { return null; }",
      "/services/GuestsService": `export const GuestsService = {
        list: (id) => globalThis.__listGuests(id),
        remove: (id, input) => globalThis.__removeGuest(id, input),
      };`,
    },
  });
  ({ default: Tab } = await vite.ssrLoadModule("/components/settings/WorkspaceGuestsTab.tsx"));
  ({ CloudApiError } = await vite.ssrLoadModule("/services/cloudApi.ts"));
});

test.after(async () => {
  await happyWindow.happyDOM.close();
});

async function mount(t, ids = ["n1", "n2"], firstLoad) {
  let guests = [guest(ids)];
  const listCalls = [];
  const pending = new Map(ids.map((id) => [id, deferred()]));
  globalThis.__guestToasts = [];
  globalThis.__listGuests = (id) => {
    listCalls.push(id);
    return firstLoad && listCalls.length === 1 ? firstLoad : Promise.resolve(guests);
  };
  globalThis.__removeGuest = (id, input) => {
    assert.equal(id, "w1");
    assert.deepEqual(input.emails, ["guest@outside.test"]);
    return pending.get(input.note_id).promise;
  };
  const container = happyWindow.document.createElement("div");
  happyWindow.document.body.append(container);
  const root = createRoot(container);
  t.after(async () => {
    await ui.act(() => root.unmount());
    await ui.settle();
    container.remove();
    delete globalThis.__guestToasts;
    delete globalThis.__listGuests;
    delete globalThis.__removeGuest;
  });
  const rerender = (workspace) =>
    ui.act(() => root.render(React.createElement(Tab, { workspace })));
  await rerender(ADMIN);
  const open = async () => {
    const trigger = container.querySelector('[aria-label$="shared with ⁨Guest⁩"]');
    assert.ok(trigger, "the guest's note menu exists");
    await ui.focus(trigger);
    await ui.press(trigger, "Enter");
    await ui.settle();
  };
  const press = async (id) => {
    const button = [...happyWindow.document.querySelectorAll('[role="menuitem"]')].find(
      (item) => readable(item.getAttribute("aria-label") ?? "") === `Remove from ${id}`
    );
    assert.ok(button, "the note's remove control exists");
    await ui.focus(button);
    await ui.click(button);
  };
  const setGuests = (next) => {
    guests = next;
  };
  const resolve = async (id, linkShared = []) => {
    await ui.act(() => {
      guests = guests
        .map((value) => ({ ...value, notes: value.notes.filter((note) => note.id !== id) }))
        .filter((value) => value.notes.length > 0);
      pending.get(id).resolve({
        removed: ["guest@outside.test"],
        not_found: [],
        skipped_members: [],
        link_shared_note_ids: linkShared,
      });
    });
    await ui.settle();
  };
  return { container, open, press, resolve, rerender, setGuests, pending, listCalls };
}

test("a permission downgrade discards admin-only notes before a failed refresh", async (t) => {
  const view = await mount(t, ["restricted-note"]);
  await view.open();
  assert.match(happyWindow.document.body.textContent, /restricted-note/);
  globalThis.__listGuests = async () => {
    throw new Error("offline");
  };
  await view.rerender(MEMBER);
  await ui.settle();
  assert.doesNotMatch(happyWindow.document.body.textContent, /restricted-note/);
  assert.match(happyWindow.document.body.textContent, /Couldn't load guests/);
});

test("a late admin response cannot replace the member's scoped list", async (t) => {
  const adminLoad = deferred();
  const view = await mount(t, ["restricted-note"], adminLoad.promise);
  view.setGuests([guest(["member-note"])]);
  await view.rerender(MEMBER);
  await ui.act(() => adminLoad.resolve([guest(["restricted-note"])]));
  await view.open();
  assert.match(happyWindow.document.body.textContent, /member-note/);
  assert.doesNotMatch(happyWindow.document.body.textContent, /restricted-note/);
});

test("a permission promotion reloads the expanded list", async (t) => {
  const view = await mount(t, ["member-note"]);
  await view.rerender(MEMBER);
  view.setGuests([guest(["member-note", "admin-note"])]);
  await view.rerender(ADMIN);
  await view.open();
  assert.match(happyWindow.document.body.textContent, /admin-note/);
});

for (const order of [
  ["n1", "n2"],
  ["n2", "n1"],
]) {
  test(`overlapping removals completing ${order.join(" then ")} focus the empty state`, async (t) => {
    const view = await mount(t);
    await view.open();
    await view.press("n1");
    await view.press("n2");
    for (const id of order) await view.resolve(id);
    assert.ok(
      happyWindow.document.activeElement === view.container.querySelector("[data-guests-empty]"),
      "focus stays on the empty state"
    );
  });
}

test("removals completing in the same render focus the empty state", async (t) => {
  const view = await mount(t);
  await view.open();
  await view.press("n1");
  await view.press("n2");
  view.setGuests([]);
  await ui.act(() => {
    for (const pending of view.pending.values()) {
      pending.resolve({
        removed: ["guest@outside.test"],
        not_found: [],
        skipped_members: [],
        link_shared_note_ids: [],
      });
    }
  });
  await ui.settle();
  assert.ok(
    happyWindow.document.activeElement === view.container.querySelector("[data-guests-empty]")
  );
});

test("a single last-note removal still focuses the empty state", async (t) => {
  const view = await mount(t, ["last-note"]);
  await view.open();
  await view.press("last-note");
  await view.resolve("last-note");
  assert.ok(
    happyWindow.document.activeElement === view.container.querySelector("[data-guests-empty]")
  );
});

test("a missing note refreshes the list using the API's actual 404 response", async (t) => {
  const view = await mount(t, ["deleted-note"]);
  await view.open();
  await view.press("deleted-note");
  view.setGuests([]);
  await ui.act(() =>
    view.pending
      .get("deleted-note")
      .resolve(Promise.reject(new CloudApiError("Note not found", 404)))
  );
  assert.equal(view.listCalls.length, 2);
  assert.ok(view.container.querySelector("[data-guests-empty]"));
  assert.equal(globalThis.__guestToasts.length, 0);
});

test("per-note removal explains the link access reported by the server", async (t) => {
  const view = await mount(t, ["link-note"]);
  await view.open();
  await view.press("link-note");
  await view.resolve("link-note", ["link-note"]);
  assert.match(globalThis.__guestToasts[0].description ?? "", /link.*sharing/);
  assert.ok(view.container.querySelector("[data-guests-empty]"));
});
