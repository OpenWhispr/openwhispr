const test = require("node:test");
const assert = require("node:assert/strict");
const { createRendererServer } = require("../lib/rendererTestHarness");

// Mounts the real event list in happy-dom. Without an i18next instance, t()
// returns the key, so rows read as notes.eventLink.*.

const DOM_GLOBALS = [
  "document",
  "navigator",
  "Node",
  "Element",
  "HTMLElement",
  "MutationObserver",
  "getComputedStyle",
  "Event",
  "CustomEvent",
  "MouseEvent",
  "PointerEvent",
  "FocusEvent",
  "KeyboardEvent",
  "HTMLInputElement",
];

let happyWindow;

test.before(async () => {
  const { Window } = await import("happy-dom");
  happyWindow = new Window();
  const define = (name, value) =>
    Object.defineProperty(globalThis, name, { value, configurable: true, writable: true });
  define("window", happyWindow);
  for (const name of DOM_GLOBALS) define(name, happyWindow[name]);
  for (const name of ["requestAnimationFrame", "cancelAnimationFrame"]) {
    define(name, happyWindow[name].bind(happyWindow));
  }
});

test.after(async () => {
  await happyWindow.happyDOM.close();
});

async function mount(t, props) {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  const React = require("react");
  const { createRoot } = require("react-dom/client");
  const vite = await createRendererServer(t);
  const mod = await vite.ssrLoadModule("/components/notes/NoteEventPicker.tsx");
  const host = happyWindow.document.createElement("div");
  happyWindow.document.body.appendChild(host);
  const root = createRoot(host);
  t.after(async () => {
    await React.act(async () => root.unmount());
    host.remove();
  });
  const act = (callback) =>
    React.act(async () => {
      await callback();
      await new Promise((resolve) => setTimeout(resolve, 10));
    });
  const calls = { select: [], remove: 0, back: 0 };
  await act(() =>
    root.render(
      React.createElement(mod.default, {
        events: [],
        loadFailed: false,
        calendarConnected: true,
        noteDay: new Date(2026, 9, 20, 13, 45),
        linkedEventId: null,
        onSelect: (event) => calls.select.push(event),
        onRemove: () => {
          calls.remove += 1;
        },
        onBack: () => {
          calls.back += 1;
        },
        ...props,
      })
    )
  );
  return { act, host, calls };
}

const iso = (...parts) => new Date(...parts).toISOString();
const event = (id, summary, start, end) => ({
  id,
  calendar_id: "cal",
  provider: "google",
  summary,
  start_time: start,
  end_time: end,
  is_all_day: 0,
  status: "confirmed",
  attendees: null,
  calendar_color: "#1A73E8",
});
const EVENTS = [
  event("focus", "Focus", iso(2026, 9, 20, 10), iso(2026, 9, 20, 13)),
  event("standup", "Team Standup", iso(2026, 9, 20, 14, 15), iso(2026, 9, 20, 15, 15)),
  event("old", "Planning", iso(2026, 9, 18, 9), iso(2026, 9, 18, 10)),
];

// Booleans and strings only: printing a happy-dom element in a failed assert
// runs the test process out of memory.
const rowTexts = (host) => [...host.querySelectorAll("button")].map((b) => b.textContent.trim());
const rowWith = (host, text) =>
  [...host.querySelectorAll("button")].find((b) => b.textContent.includes(text));
const searchInput = (host) =>
  host.querySelector('input[placeholder="notes.eventLink.searchPlaceholder"]');
const type = (host, text) => {
  const input = searchInput(host);
  Object.getOwnPropertyDescriptor(happyWindow.HTMLInputElement.prototype, "value").set.call(
    input,
    text
  );
  input.dispatchEvent(new happyWindow.Event("input", { bubbles: true }));
};

test("opens on the note's day and filters by search", async (t) => {
  const { act, host } = await mount(t, { events: EVENTS });

  assert.equal(!!rowWith(host, "Focus"), true);
  assert.equal(!!rowWith(host, "Team Standup"), true);
  assert.equal(!!rowWith(host, "Planning"), false);

  await act(() => type(host, "stand"));
  assert.equal(!!rowWith(host, "Focus"), false);
  assert.match(rowWith(host, "Team Standup").textContent, / · /);

  await act(() => type(host, "plan"));
  assert.equal(!!rowWith(host, "Planning"), true, "search reaches other stored days");
});

test("marks the linked event and offers removal first", async (t) => {
  const { act, host, calls } = await mount(t, { events: EVENTS, linkedEventId: "standup" });

  const rows = rowTexts(host).filter((text) => text !== "");
  assert.equal(rows[0], "notes.eventLink.removeEvent");
  assert.equal(rowWith(host, "Team Standup").getAttribute("aria-current"), "true");
  assert.equal(rowWith(host, "Focus").hasAttribute("aria-current"), false);
  assert.equal(!!rowWith(host, "Team Standup").querySelector("svg[aria-hidden='true']"), true);
  assert.equal(rowWith(host, "Focus").querySelectorAll("svg").length, 0);

  await act(() => rowWith(host, "notes.eventLink.removeEvent").click());
  assert.equal(calls.remove, 1);
});

test("selecting an event hands it back", async (t) => {
  const { act, host, calls } = await mount(t, { events: EVENTS });

  await act(() => rowWith(host, "Focus").click());

  assert.deepEqual(
    calls.select.map((selected) => selected.id),
    ["focus"]
  );
});

test("shows the right empty state", async (t) => {
  const message = (host) => host.querySelector("p")?.textContent ?? null;
  const cases = [
    [{ calendarConnected: false }, "notes.eventLink.noCalendar"],
    [{ loadFailed: true }, "notes.eventLink.loadFailed"],
    [{ noteDay: new Date(Date.now() - 10 * 86_400_000) }, "notes.eventLink.outsideWindow"],
    [{ noteDay: new Date() }, "notes.eventLink.noEventsOnDay"],
  ];
  for (const [props, expected] of cases) {
    const { host } = await mount(t, props);
    assert.equal(message(host), expected);
    host.remove();
  }

  const { act, host } = await mount(t, { events: EVENTS });
  await act(() => type(host, "zzz"));
  assert.equal(message(host), "notes.eventLink.noResults");
});

test("shows a loading state until the events arrive", async (t) => {
  const { host } = await mount(t, { events: null });

  assert.equal(host.querySelector("[role='status']")?.textContent.trim(), "common.loading");
  assert.equal(host.querySelector("p"), null, "no empty-state message while loading");

  for (const props of [{ loadFailed: true }, { calendarConnected: false }]) {
    const other = await mount(t, { events: null, ...props });
    assert.equal(other.host.querySelector("[role='status']"), null);
    other.host.remove();
  }
});

test("the search box has an accessible name", async (t) => {
  const { host } = await mount(t, { events: EVENTS });

  assert.equal(searchInput(host).getAttribute("aria-label"), "notes.eventLink.searchPlaceholder");
});

const press = (target, key) =>
  target.dispatchEvent(new happyWindow.KeyboardEvent("keydown", { key, bubbles: true }));

test("Enter in a search picks the first match, and does nothing without one", async (t) => {
  const { act, host, calls } = await mount(t, { events: EVENTS });

  await act(() => press(searchInput(host), "Enter"));
  assert.deepEqual(calls.select, [], "an empty search box never links the day's first event");

  await act(() => type(host, "zzz"));
  await act(() => press(searchInput(host), "Enter"));
  assert.deepEqual(calls.select, []);

  await act(() => type(host, "stand"));
  await act(() => press(searchInput(host), "Enter"));
  assert.deepEqual(
    calls.select.map((selected) => selected.id),
    ["standup"]
  );
});

test("arrow keys move between the search box and the rows", async (t) => {
  const { act, host } = await mount(t, { events: EVENTS, linkedEventId: "standup" });
  const focused = () => happyWindow.document.activeElement?.textContent?.trim() ?? "";
  searchInput(host).focus();

  await act(() => press(happyWindow.document.activeElement, "ArrowDown"));
  assert.equal(focused(), "notes.eventLink.removeEvent");
  await act(() => press(happyWindow.document.activeElement, "ArrowDown"));
  assert.match(focused(), /^Focus/);
  await act(() => press(happyWindow.document.activeElement, "ArrowDown"));
  await act(() => press(happyWindow.document.activeElement, "ArrowDown"));
  assert.match(focused(), /^Team Standup/, "stops at the last row");

  for (let i = 0; i < 4; i += 1) {
    await act(() => press(happyWindow.document.activeElement, "ArrowUp"));
  }
  assert.equal(happyWindow.document.activeElement === searchInput(host), true, "stops at the box");
});

test("titles keep their own direction", async (t) => {
  const { host } = await mount(t, { events: EVENTS });

  assert.equal(rowWith(host, "Focus").querySelector("span[dir]")?.getAttribute("dir"), "auto");
});
