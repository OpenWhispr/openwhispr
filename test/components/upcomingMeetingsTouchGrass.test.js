const test = require("node:test");
const assert = require("node:assert/strict");
const React = require("react");
const { createRoot } = require("react-dom/client");
const { createRendererServer, installBrowserGlobals } = require("../lib/rendererTestHarness");
const { installInteractiveDom, findElement } = require("../lib/interactiveDom");

async function mountUpcomingMeetings(t) {
  let root;
  t.after(async () => {
    if (root) await React.act(async () => root.unmount());
  });
  installBrowserGlobals(t);
  const container = installInteractiveDom(t);
  const vite = await createRendererServer(t, {
    cachePrefix: "openwhispr-touch-grass-test-",
    mockModules: {
      "/hooks/useSystemAudioPermission": `export const useSystemAudioPermission = () => ({ granted: true });`,
      "/TouchGrass": `export default function TouchGrass() { return null; }`,
      "/ui/useToast": `
        export const toasts = [];
        export const useToast = () => ({ toast: (props) => toasts.push(props) });
      `,
      "/utils/grassRustle": `
        export const rustles = [];
        export const createGrassRustle = () => {
          const rustle = { disposed: false, brush() {}, dispose() { rustle.disposed = true; } };
          rustles.push(rustle);
          return rustle;
        };
      `,
    },
  });
  const { default: UpcomingMeetings } = await vite.ssrLoadModule(
    "/components/UpcomingMeetings.tsx"
  );
  const { rustles } = await vite.ssrLoadModule("/utils/grassRustle");
  const { toasts } = await vite.ssrLoadModule("/components/ui/useToast");
  root = createRoot(container);
  return { root, container, UpcomingMeetings, rustles, toasts, vite };
}

function eventLaterToday() {
  const start = new Date();
  start.setHours(23, 0, 0, 0);
  const end = new Date(start);
  end.setMinutes(30);
  return {
    id: "later-today",
    summary: "Planning",
    start_time: start.toISOString(),
    end_time: end.toISOString(),
  };
}

function eventTomorrow() {
  const start = new Date();
  start.setDate(start.getDate() + 1);
  start.setHours(10, 0, 0, 0);
  const end = new Date(start);
  end.setHours(11);
  return {
    id: "tomorrow",
    summary: "Standup",
    start_time: start.toISOString(),
    end_time: end.toISOString(),
  };
}

const byText = (text) => (element) => element.tagName === "BUTTON" && element.textContent === text;

test("a meeting synced into today leaves the grass and releases its rustle", async (t) => {
  const { root, container, UpcomingMeetings, rustles } = await mountUpcomingMeetings(t);
  const props = { isLoading: false, isConnected: true, onConnectCalendar: () => {} };

  await React.act(async () =>
    root.render(React.createElement(UpcomingMeetings, { ...props, events: [eventTomorrow()] }))
  );
  const touchGrass = findElement(container, byText("upcoming.touchGrass"));
  assert.ok(touchGrass, "the empty today card offers the grass");
  await React.act(async () =>
    touchGrass.dispatchEvent({ type: "click", bubbles: true, button: 0, preventDefault() {} })
  );
  assert.ok(findElement(container, byText("common.back")), "the grass is out");

  await React.act(async () =>
    root.render(
      React.createElement(UpcomingMeetings, {
        ...props,
        events: [eventLaterToday(), eventTomorrow()],
      })
    )
  );
  assert.equal(
    Boolean(findElement(container, byText("common.back"))),
    false,
    "Back goes with the grass"
  );
  assert.equal(rustles.length, 1);
  assert.equal(rustles[0].disposed, true, "the rustle audio is released");
});

test("a calendar join the org refuses to record explains why in the panel", async (t) => {
  const { root, container, UpcomingMeetings, toasts } = await mountUpcomingMeetings(t);
  globalThis.window.electronAPI.joinCalendarMeeting = async () => ({
    success: false,
    code: "POLICY_MEETING_RECORDING_DISABLED",
    error: "Meeting recording is disabled by your organization.",
  });
  await React.act(async () =>
    root.render(
      React.createElement(UpcomingMeetings, {
        isLoading: false,
        isConnected: true,
        onConnectCalendar: () => {},
        events: [eventLaterToday()],
      })
    )
  );
  // The button's icon leaves whitespace around its label.
  const takeNotes = findElement(
    container,
    (element) => element.tagName === "BUTTON" && element.textContent.trim() === "upcoming.takeNotes"
  );
  assert.ok(takeNotes, "the event offers to take notes");
  await React.act(async () =>
    takeNotes.dispatchEvent({ type: "click", bubbles: true, button: 0, preventDefault() {} })
  );
  assert.deepEqual(toasts, [{ title: "notes.meeting.recordingDisabledByOrg", variant: "default" }]);
});

test("with meeting recording off, a linked event only joins and a link-less one says why", async (t) => {
  const { root, container, UpcomingMeetings, vite } = await mountUpcomingMeetings(t);
  const { usePolicyStore } = await vite.ssrLoadModule("/stores/policyStore.ts");
  const opened = [];
  const joins = [];
  globalThis.window.electronAPI.openExternal = (url) => opened.push(url);
  globalThis.window.electronAPI.joinCalendarMeeting = async (id) => joins.push(id);
  usePolicyStore.setState({
    status: "managed",
    appVersion: "1.11.0",
    policy: { minAppVersion: null, features: { meetingRecordingEnabled: false } },
  });
  const linked = {
    ...eventLaterToday(),
    id: "linked",
    hangout_link: "https://meet.google.com/abc-defg-hij",
  };
  await React.act(async () =>
    root.render(
      React.createElement(UpcomingMeetings, {
        isLoading: false,
        isConnected: true,
        onConnectCalendar: () => {},
        events: [linked, eventLaterToday()],
      })
    )
  );
  const button = (label) =>
    findElement(
      container,
      (element) => element.tagName === "BUTTON" && element.textContent.trim() === label
    );

  assert.equal(button("upcoming.joinAndTranscribe"), null, "nothing offers to transcribe");
  const join = button("meetingNotification.joinOnly");
  assert.ok(join, "the linked event can still be joined");
  await React.act(async () =>
    join.dispatchEvent({ type: "click", bubbles: true, button: 0, preventDefault() {} })
  );
  assert.deepEqual(opened, [linked.hangout_link]);
  assert.deepEqual(joins, [], "joining starts no recording");

  const takeNotes = button("upcoming.takeNotes");
  assert.ok(takeNotes, "the link-less event keeps its button");
  assert.notEqual(takeNotes.getAttribute("disabled") ?? takeNotes.disabled, undefined);
  const reasonId = takeNotes.getAttribute("aria-describedby");
  const reason = findElement(container, (element) => element.getAttribute?.("id") === reasonId);
  assert.equal(reason?.textContent, "notes.meeting.recordingDisabledByOrg");
  assert.ok(
    reason.hidden || reason.getAttribute("hidden") !== null,
    "read only as the description"
  );
});
