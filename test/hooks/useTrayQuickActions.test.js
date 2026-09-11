const test = require("node:test");
const assert = require("node:assert/strict");
const React = require("react");
const {
  createRendererServer,
  installBrowserGlobals,
  installHookDom,
} = require("../lib/rendererTestHarness");

// The resolvers are pure and tested on their own; what this pins is the wiring.
// App hands this hook its own state, and a forgotten or swapped input — the
// assistant panel's mounted flag where the transcript's belongs, a dropped
// policy input — would refuse or run at exactly the wrong moment with every
// other test still green. SSR cannot run useEffect, so the hook is mounted for
// real and the registered IPC callbacks are invoked like the tray would.
async function mountTrayQuickActions(t, props) {
  // Registered before the browser globals, so it runs before their teardown:
  // node:test runs after-hooks in registration order and react-dom reads
  // `window` while unmounting.
  const rootRef = { current: null };
  t.after(async () => {
    if (rootRef.current) await React.act(async () => rootRef.current.unmount());
  });

  const listeners = {};
  const calls = { acks: 0, manualMeetings: 0, assistantOpens: 0, menuCloses: 0, refusals: [] };
  const register = (name) => (callback) => {
    listeners[name] = callback;
    return () => {
      delete listeners[name];
    };
  };
  const electronAPI = {
    onOpenAssistantPanel: register("assistant"),
    onStartMeeting: register("meeting"),
    onTrayActionRefused: register("refused"),
    notifyDictationRendererReady: () => {
      calls.acks += 1;
    },
    startManualMeeting: async () => {
      calls.manualMeetings += 1;
    },
  };

  installBrowserGlobals(t, { window: { electronAPI } });
  const container = installHookDom(t);
  const vite = await createRendererServer(t, {
    cachePrefix: "openwhispr-tray-quick-actions-test-",
  });
  const [{ useTrayQuickActions }, { TRAY_REFUSAL_KEYS }] = await Promise.all([
    vite.ssrLoadModule("/hooks/useTrayQuickActions.js"),
    vite.ssrLoadModule("/helpers/trayActionPolicy.js"),
  ]);

  function Harness() {
    useTrayQuickActions({
      ...props,
      closeCommandMenu: () => {
        calls.menuCloses += 1;
      },
      openAssistantPanel: async () => {
        calls.assistantOpens += 1;
      },
      refuse: (messageKey) => calls.refusals.push(messageKey),
    });
    return null;
  }

  const { createRoot } = require("react-dom/client");
  const root = createRoot(container);
  await React.act(async () => root.render(React.createElement(Harness)));
  rootRef.current = root;

  return { listeners, calls, TRAY_REFUSAL_KEYS };
}

const idle = {
  agentAllowed: true,
  meetingAllowed: true,
  policyResolved: true,
  isRecording: false,
  liveTranscriptMounted: false,
};

test("mounting acks the renderer so main stops taking the meeting's own path", async (t) => {
  const { calls } = await mountTrayQuickActions(t, idle);

  assert.equal(calls.acks, 1);
});

test("an idle pill runs both quick actions and closes the command menu", async (t) => {
  const { listeners, calls } = await mountTrayQuickActions(t, idle);

  await React.act(async () => listeners.assistant());
  await React.act(async () => listeners.meeting());

  assert.equal(calls.assistantOpens, 1);
  assert.equal(calls.manualMeetings, 1);
  assert.equal(calls.menuCloses, 2);
  assert.deepEqual(calls.refusals, []);
});

test("a live dictation refuses both rather than stealing the microphone", async (t) => {
  const { listeners, calls, TRAY_REFUSAL_KEYS } = await mountTrayQuickActions(t, {
    ...idle,
    isRecording: true,
  });

  await React.act(async () => listeners.assistant());
  await React.act(async () => listeners.meeting());

  assert.deepEqual(calls.refusals, [TRAY_REFUSAL_KEYS.busy, TRAY_REFUSAL_KEYS.busy]);
  assert.equal(calls.assistantOpens, 0);
  assert.equal(calls.manualMeetings, 0);
});

// The transcript panel owns the pill exactly as a recording does, and it is the
// input most easily confused with the assistant panel's own mounted flag.
test("the transcript panel's flag gates the assistant item", async (t) => {
  const { listeners, calls, TRAY_REFUSAL_KEYS } = await mountTrayQuickActions(t, {
    ...idle,
    liveTranscriptMounted: true,
  });

  await React.act(async () => listeners.assistant());

  assert.deepEqual(calls.refusals, [TRAY_REFUSAL_KEYS.busy]);
  assert.equal(calls.assistantOpens, 0);
});

// Policy failing closed must not be reported as an org that restricted something.
test("an unresolved policy refuses without blaming the organization", async (t) => {
  const { listeners, calls, TRAY_REFUSAL_KEYS } = await mountTrayQuickActions(t, {
    ...idle,
    agentAllowed: false,
    meetingAllowed: false,
    policyResolved: false,
  });

  await React.act(async () => listeners.assistant());
  await React.act(async () => listeners.meeting());

  assert.deepEqual(calls.refusals, [
    TRAY_REFUSAL_KEYS.policyUnresolved,
    TRAY_REFUSAL_KEYS.policyUnresolved,
  ]);
});

test("a resolved policy that really restricts these says so", async (t) => {
  const { listeners, calls, TRAY_REFUSAL_KEYS } = await mountTrayQuickActions(t, {
    ...idle,
    agentAllowed: false,
    meetingAllowed: false,
  });

  await React.act(async () => listeners.assistant());
  await React.act(async () => listeners.meeting());

  assert.deepEqual(calls.refusals, [
    TRAY_REFUSAL_KEYS.agentRestricted,
    TRAY_REFUSAL_KEYS.meetingRestricted,
  ]);
});

// The listen item is refused in main, which can see gates this renderer cannot.
test("a refusal raised by the main process is surfaced here", async (t) => {
  const { listeners, calls } = await mountTrayQuickActions(t, idle);

  await React.act(async () => listeners.refused({ messageKey: "app.commandMenu.busyRecording" }));
  await React.act(async () => listeners.refused({}));

  assert.deepEqual(calls.refusals, ["app.commandMenu.busyRecording"]);
});
