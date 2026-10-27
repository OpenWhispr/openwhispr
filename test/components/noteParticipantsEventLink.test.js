const test = require("node:test");
const assert = require("node:assert/strict");
const { createRendererServer } = require("../lib/rendererTestHarness");

// Opens the real note-header dropdown in happy-dom. Without an i18next
// instance, t() returns the key, so rows read as notes.eventLink.*.

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
  "ResizeObserver",
  "DOMRect",
];

const MOCKS = {
  "/stores/settingsStore": `
    export function useSettingsStore(selector) {
      return selector({ gcalConnected: true, mcalConnected: false, appleCalendarConnected: false });
    }
  `,
  "/stores/meetingRecordingStore": `
    export function syncSessionExpectedCountFromParticipants() {}
  `,
};

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

const dana = { email: "dana@x.com", displayName: "Dana", responseStatus: null, self: false };
const frank = { email: "frank@x.com", displayName: "Frank", responseStatus: null, self: false };
const eve = { email: "eve@x.com", displayName: "Eve", responseStatus: "accepted", self: false };
// The note's created_at in the SQLite UTC form, for 13:45 local time on the
// Standup's day, so the note's day matches in every time zone.
const NOTE_CREATED_AT = new Date(2026, 9, 20, 13, 45).toISOString().replace("T", " ").slice(0, 19);
const STANDUP = {
  id: "evt-standup",
  calendar_id: "cal",
  provider: "google",
  summary: "Team Standup",
  start_time: new Date(2026, 9, 20, 14, 15).toISOString(),
  end_time: new Date(2026, 9, 20, 15, 15).toISOString(),
  is_all_day: 0,
  status: "confirmed",
  hangout_link: "https://meet.google.com/abc-defg-hij",
  conference_data: null,
  attendees: JSON.stringify([dana, eve]),
  calendar_color: "#1A73E8",
};

async function mount(t, props, { events = [STANDUP] } = {}) {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  const calls = { updateNote: [], openExternal: [], joinCalendarMeeting: 0 };
  happyWindow.electronAPI = {
    searchContacts: async () => ({ success: true, contacts: [] }),
    upsertContact: () => {},
    updateNote: (...args) => calls.updateNote.push(args),
    openExternal: (url) => calls.openExternal.push(url),
    joinCalendarMeeting: () => {
      calls.joinCalendarMeeting += 1;
    },
    calendarGetLinkableEvents: async () => ({ success: true, events }),
  };
  const React = require("react");
  const { createRoot } = require("react-dom/client");
  const vite = await createRendererServer(t, { mockModules: MOCKS });
  const mod = await vite.ssrLoadModule("/components/notes/NoteParticipants.tsx");
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
      await new Promise((resolve) => setTimeout(resolve, 30));
    });
  const render = (overrides) =>
    act(() =>
      root.render(
        React.createElement(mod.default, {
          noteId: 7,
          participants: [dana],
          dateLabel: "Oct 20",
          dateTitle: "Oct 20, 2026 · 1:45 PM",
          noteCreatedAt: NOTE_CREATED_AT,
          linkedEventId: null,
          linkedEvent: null,
          canEdit: true,
          ownedByUser: true,
          ...props,
          ...overrides,
        })
      )
    );
  await render();
  const trigger = host.querySelector("button");
  await act(() => trigger.click());
  return { act, trigger, calls, render };
}

const savedParticipants = (call) => JSON.parse(call[1].participants);

// Strings and booleans only: printing a happy-dom element in a failed assert
// runs the test process out of memory.
const buttonWith = (text) =>
  [...happyWindow.document.querySelectorAll("button")].find((b) => b.textContent.includes(text));
const bodyText = () => happyWindow.document.body.textContent;
// This string has an inline fallback, which t() returns without an instance.
const attendeeInput = () =>
  !!happyWindow.document.querySelector('input[placeholder="Add attendees..."]');

test("an editor links an event and its guests merge in one write", async (t) => {
  const { act, calls } = await mount(t, { participants: [dana, frank] });

  await act(() => buttonWith("notes.eventLink.selectEvent").click());
  await act(() => buttonWith("Team Standup").click());

  assert.equal(calls.updateNote.length, 1);
  assert.equal(calls.updateNote[0][0], 7);
  assert.equal(calls.updateNote[0][1].calendar_event_id, "evt-standup");
  assert.deepEqual(
    savedParticipants(calls.updateNote[0]),
    [dana, frank, { ...eve, addedByEvent: "evt-standup" }],
    "existing attendees stay, in order, and only new guests are added, tagged with the event"
  );
  assert.equal(attendeeInput(), true, "back on the attendees view");
  assert.equal(bodyText().includes("Team Standup"), true);
});

// This user's copy of the event marks them `self`.
const me = { email: "me@x.com", displayName: "Me", responseStatus: "accepted", self: true };
const owner = { email: "owner@x.com", displayName: "Owner", responseStatus: null, self: true };
const STANDUP_WITH_ME = { ...STANDUP, attendees: JSON.stringify([owner, me, dana]) };

test("linking on the user's own note marks them from their calendar", async (t) => {
  const { act, calls } = await mount(t, { participants: [] }, { events: [STANDUP_WITH_ME] });

  await act(() => buttonWith("notes.eventLink.selectEvent").click());
  await act(() => buttonWith("Team Standup").click());

  assert.equal(savedParticipants(calls.updateNote[0]).find((p) => p.email === me.email).self, true);
});

test("linking on a teammate's note never marks the user as the one who recorded it", async (t) => {
  const { act, calls } = await mount(
    t,
    { participants: [owner, { ...me, self: false }], ownedByUser: false },
    { events: [{ ...STANDUP_WITH_ME, attendees: JSON.stringify([me, dana]) }] }
  );

  await act(() => buttonWith("notes.eventLink.selectEvent").click());
  await act(() => buttonWith("Team Standup").click());

  assert.deepEqual(
    savedParticipants(calls.updateNote[0]),
    [owner, { ...me, self: false }, { ...dana, addedByEvent: "evt-standup" }],
    "the owner stays the only self, whether this user was on the note already or not"
  );
});

test("on a teammate's note a newly added user is an ordinary attendee", async (t) => {
  const { act, calls } = await mount(
    t,
    { participants: [owner], ownedByUser: false },
    { events: [{ ...STANDUP_WITH_ME, attendees: JSON.stringify([me]) }] }
  );

  await act(() => buttonWith("notes.eventLink.selectEvent").click());
  await act(() => buttonWith("Team Standup").click());

  assert.deepEqual(savedParticipants(calls.updateNote[0]), [
    owner,
    { ...me, self: false, addedByEvent: "evt-standup" },
  ]);
});

test("on the user's own note, linking and removing leaves earlier rows as they were and keeps the user", async (t) => {
  const namelessDana = { ...dana, displayName: null };
  const room = {
    email: "room@x.com",
    displayName: "Room 4",
    responseStatus: null,
    self: false,
    resource: true,
  };
  const { act, calls } = await mount(
    t,
    { participants: [namelessDana] },
    { events: [{ ...STANDUP, attendees: JSON.stringify([me, dana, room]) }] }
  );

  await act(() => buttonWith("notes.eventLink.selectEvent").click());
  await act(() => buttonWith("Team Standup").click());
  await act(() => buttonWith("Team Standup").click());
  await act(() => buttonWith("notes.eventLink.removeEvent").click());

  assert.deepEqual(
    savedParticipants(calls.updateNote[0]),
    [namelessDana, me],
    "the room stays out and Dana's row isn't filled in from the event"
  );
  assert.deepEqual(
    savedParticipants(calls.updateNote[1]),
    [namelessDana, me],
    "removing the event takes off nothing it didn't add, and the user recorded the note"
  );
});

test("removing an event you just linked takes off its guests and keeps everyone else", async (t) => {
  const { act, calls } = await mount(t, { participants: [frank] });

  await act(() => buttonWith("notes.eventLink.selectEvent").click());
  await act(() => buttonWith("Team Standup").click());
  await act(() => buttonWith("Team Standup").click());
  await act(() => buttonWith("notes.eventLink.removeEvent").click());

  assert.equal(calls.updateNote.length, 2);
  assert.deepEqual(calls.updateNote[1][1], {
    participants: JSON.stringify([frank]),
    calendar_event_id: "",
  });
  assert.equal(/\bEve\b/.test(bodyText()), false, "the guest the event added is gone");
  assert.equal(bodyText().includes("Frank"), true);
});

test("switching to another event swaps the first event's guests for the new one's", async (t) => {
  const gail = { email: "gail@x.com", displayName: "Gail", responseStatus: null, self: false };
  const focus = {
    ...STANDUP,
    id: "evt-focus",
    summary: "Focus",
    hangout_link: null,
    attendees: JSON.stringify([gail]),
  };
  const { act, calls } = await mount(
    t,
    {
      participants: [frank, { ...gail, addedByEvent: "evt-focus" }],
      linkedEventId: "evt-focus",
      linkedEvent: focus,
    },
    { events: [focus, STANDUP] }
  );

  await act(() => buttonWith("Focus").click());
  await act(() => buttonWith("Team Standup").click());

  assert.equal(calls.updateNote.length, 1);
  assert.equal(calls.updateNote[0][1].calendar_event_id, "evt-standup");
  assert.deepEqual(savedParticipants(calls.updateNote[0]), [
    frank,
    { ...dana, addedByEvent: "evt-standup" },
    { ...eve, addedByEvent: "evt-standup" },
  ]);
});

test("picking the already-linked event changes nothing", async (t) => {
  const { act, calls } = await mount(t, {
    participants: [frank],
    linkedEventId: "evt-standup",
    linkedEvent: STANDUP,
  });

  await act(() => buttonWith("Team Standup").click());
  await act(() => buttonWith("Team Standup").click());

  assert.deepEqual(calls.updateNote, [], "guests the user removed don't come back");
  assert.equal(attendeeInput(), true);
});

test("the event list closes when edit rights turn out to be view-only", async (t) => {
  const { act, render, calls } = await mount(t);
  await act(() => buttonWith("notes.eventLink.selectEvent").click());
  assert.equal(attendeeInput(), false, "the event list is open");

  await render({ canEdit: false });

  assert.equal(attendeeInput(), true, "back on the attendees view");
  assert.equal(!!buttonWith("Team Standup"), false);
  assert.deepEqual(calls.updateNote, []);
});

test("Join opens the meeting link and never starts a recording", async (t) => {
  const { act, calls } = await mount(t, { linkedEventId: "evt-standup", linkedEvent: STANDUP });

  await act(() => buttonWith("notes.eventLink.join").click());

  assert.deepEqual(calls.openExternal, ["https://meet.google.com/abc-defg-hij"]);
  assert.equal(calls.joinCalendarMeeting, 0);
});

test("no Join without a meeting link", async (t) => {
  const plain = { ...STANDUP, hangout_link: null };
  await mount(t, { linkedEventId: "evt-standup", linkedEvent: plain }, { events: [plain] });

  assert.equal(bodyText().includes("Team Standup"), true);
  assert.equal(!!buttonWith("notes.eventLink.join"), false);
});

test("removing the event writes a blank link and keeps attendees it didn't add", async (t) => {
  const { act, calls } = await mount(t, {
    participants: [dana, frank, { ...eve, addedByEvent: "evt-standup" }],
    linkedEventId: "evt-standup",
    linkedEvent: STANDUP,
  });

  await act(() => buttonWith("Team Standup").click());
  await act(() => buttonWith("notes.eventLink.removeEvent").click());

  assert.deepEqual(calls.updateNote, [
    [7, { participants: JSON.stringify([dana, frank]), calendar_event_id: "" }],
  ]);
  assert.equal(bodyText().includes("notes.eventLink.selectEvent"), true);
  assert.equal(bodyText().includes("Dana"), true, "a guest who was on the note before stays");
  assert.equal(/\bEve\b/.test(bodyText()), false, "the guest the event added is gone");
});

test("a viewer sees the linked event but cannot change it", async (t) => {
  const { act, calls } = await mount(t, {
    canEdit: false,
    linkedEventId: "evt-standup",
    linkedEvent: STANDUP,
  });

  assert.equal(bodyText().includes("Team Standup"), true);
  assert.equal(!!buttonWith("Team Standup"), false, "the event row is not a button");
  await act(() => buttonWith("notes.eventLink.join").click());
  assert.deepEqual(calls.openExternal, ["https://meet.google.com/abc-defg-hij"]);
});

test("a viewer of an unlinked note sees no event row", async (t) => {
  await mount(t, { canEdit: false });

  assert.equal(bodyText().includes("notes.eventLink.selectEvent"), false);
});

test("an unresolved link shows the fallback, not a title", async (t) => {
  const { trigger } = await mount(t, {
    linkedEventId: '{"eventId":"e1"}',
    linkedEvent: null,
  });

  assert.equal(trigger.textContent.includes("Oct 20"), true);
  assert.equal(bodyText().includes("notes.eventLink.unavailable"), true);
  assert.equal(!!buttonWith("notes.eventLink.join"), false);
});

test("the capsule keeps the date while linked", async (t) => {
  const { trigger } = await mount(t, { linkedEventId: "evt-standup", linkedEvent: STANDUP });

  assert.equal(trigger.textContent.includes("Oct 20"), true);
  assert.equal(trigger.textContent.includes("Team Standup"), false);
});

test("a Google event opens in Google Calendar, beside Join", async (t) => {
  const linked = { ...STANDUP, web_link: "https://www.google.com/calendar/event?eid=abc" };
  const { act, calls } = await mount(
    t,
    { linkedEventId: linked.id, linkedEvent: linked },
    { events: [linked] }
  );

  const button = buttonWith("notes.eventLink.calendar");
  assert.equal(button.getAttribute("aria-label"), null, "the visible label is its name");
  assert.equal(button.getAttribute("title"), "notes.eventLink.openInGoogle");
  await act(() => button.click());
  assert.deepEqual(calls.openExternal, ["https://www.google.com/calendar/event?eid=abc"]);
});

test("an Outlook event without a meeting link offers Open in Outlook", async (t) => {
  const linked = {
    ...STANDUP,
    provider: "microsoft",
    hangout_link: null,
    web_link: "https://outlook.office365.com/owa/?itemid=abc",
  };
  await mount(t, { linkedEventId: linked.id, linkedEvent: linked }, { events: [linked] });

  assert.equal(!!buttonWith("notes.eventLink.openInOutlook"), true);
  assert.equal(!!buttonWith("notes.eventLink.join"), false);
});

test("an Apple event has no calendar button", async (t) => {
  const linked = { ...STANDUP, provider: "apple", web_link: "https://example.com/x" };
  await mount(t, { linkedEventId: linked.id, linkedEvent: linked }, { events: [linked] });

  assert.equal(!!buttonWith("notes.eventLink.calendar"), false);
  assert.equal(!!buttonWith("notes.eventLink.openInGoogle"), false);
});

test("Escape in the event list goes back to the attendees without closing the dropdown", async (t) => {
  const { act } = await mount(t);
  await act(() => buttonWith("notes.eventLink.selectEvent").click());
  const search = happyWindow.document.querySelector(
    'input[placeholder="notes.eventLink.searchPlaceholder"]'
  );
  assert.equal(!!search, true);

  await act(() =>
    search.dispatchEvent(
      new happyWindow.KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true })
    )
  );

  assert.equal(attendeeInput(), true, "the dropdown stays open on the attendees view");
  assert.equal(bodyText().includes("notes.eventLink.selectEvent"), true);
});

test("Escape on the attendees view still closes the dropdown", async (t) => {
  const { act } = await mount(t);
  assert.equal(attendeeInput(), true);

  await act(() =>
    happyWindow.document
      .querySelector('input[placeholder="Add attendees..."]')
      .dispatchEvent(
        new happyWindow.KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true })
      )
  );

  assert.equal(attendeeInput(), false);
});
