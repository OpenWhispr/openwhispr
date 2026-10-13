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
  root = createRoot(container);
  return { root, container, UpcomingMeetings, rustles };
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
