const test = require("node:test");
const assert = require("node:assert/strict");
const React = require("react");
const {
  createRendererServer,
  installBrowserGlobals,
  installHookDom,
} = require("../lib/rendererTestHarness");

// The resolver is pure and tested on its own; what this pins is the wiring.
// App hands this hook its own state, and a forgotten or swapped input — the
// assistant panel's mounted flag where the transcript's belongs, a dropped
// policy input — would refuse or run at exactly the wrong moment with every
// other test still green. SSR cannot run useEffect, so the hook is mounted for
// real and the registered IPC callback is invoked like the tray would.
async function mountTrayQuickActions(t, props) {
  // Registered before the browser globals, so it runs before their teardown:
  // node:test runs after-hooks in registration order and react-dom reads
  // `window` while unmounting.
  const rootRef = { current: null };
  t.after(async () => {
    if (rootRef.current) await React.act(async () => rootRef.current.unmount());
  });

  const listeners = {};
  const calls = { assistantOpens: 0, menuCloses: 0, refusals: [] };
  const electronAPI = {
    onOpenAssistantPanel: (callback) => {
      listeners.assistant = callback;
      return () => {
        delete listeners.assistant;
      };
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
  policyResolved: true,
  isRecording: false,
  liveTranscriptMounted: false,
};

test("an idle pill opens the assistant and closes the command menu", async (t) => {
  const { listeners, calls } = await mountTrayQuickActions(t, idle);

  await React.act(async () => listeners.assistant());

  assert.equal(calls.assistantOpens, 1);
  assert.equal(calls.menuCloses, 1);
  assert.deepEqual(calls.refusals, []);
});

test("a live dictation refuses rather than stealing the pill", async (t) => {
  const { listeners, calls, TRAY_REFUSAL_KEYS } = await mountTrayQuickActions(t, {
    ...idle,
    isRecording: true,
  });

  await React.act(async () => listeners.assistant());

  assert.deepEqual(calls.refusals, [TRAY_REFUSAL_KEYS.busy]);
  assert.equal(calls.assistantOpens, 0);
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
    policyResolved: false,
  });

  await React.act(async () => listeners.assistant());

  assert.deepEqual(calls.refusals, [TRAY_REFUSAL_KEYS.policyUnresolved]);
});

test("a resolved policy that really restricts the assistant says so", async (t) => {
  const { listeners, calls, TRAY_REFUSAL_KEYS } = await mountTrayQuickActions(t, {
    ...idle,
    agentAllowed: false,
  });

  await React.act(async () => listeners.assistant());

  assert.deepEqual(calls.refusals, [TRAY_REFUSAL_KEYS.agentRestricted]);
});
