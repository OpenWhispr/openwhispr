const test = require("node:test");
const assert = require("node:assert/strict");
const React = require("react");
const {
  createRendererServer,
  installBrowserGlobals,
  installHookDom,
} = require("../lib/rendererTestHarness");

// The window's transparent wrappers match the hook's selector; anything else is content.
const wrapper = { matches: () => true };
const pill = { matches: () => false };

test("main hears whether the pointer is over what the window shows, also after the window moves under it", async (t) => {
  const reports = [];
  installBrowserGlobals(t, {
    window: {
      electronAPI: { agentWindowSetPointerOverContent: (over) => reports.push(over) },
      screenX: 500,
      screenY: 300,
    },
  });
  const container = installHookDom(t);
  const vite = await createRendererServer(t, { cachePrefix: "openwhispr-agent-pointer-" });
  const { usePointerOverContent } = await vite.ssrLoadModule(
    "/components/agent/usePointerOverContent.ts"
  );
  function Harness({ enabled, arrangement }) {
    usePointerOverContent(enabled, arrangement);
    return null;
  }
  const { createRoot } = require("react-dom/client");
  const root = createRoot(container);
  // Installed after React has registered its own listeners on the root.
  const { document } = globalThis;
  const listeners = new Map();
  document.addEventListener = (type, listener) => listeners.set(type, listener);
  document.removeEventListener = (type) => listeners.delete(type);
  document.documentElement.addEventListener = (type, listener) =>
    listeners.set(`root:${type}`, listener);
  document.documentElement.removeEventListener = (type) => listeners.delete(`root:${type}`);
  const asked = [];
  let atPoint = pill;
  document.elementFromPoint = (x, y) => {
    asked.push([x, y]);
    return atPoint;
  };
  const render = (props) => React.act(async () => root.render(React.createElement(Harness, props)));
  const move = (target) => listeners.get("mousemove")({ screenX: 620, screenY: 770, target });

  await render({ enabled: false, arrangement: "pill" });
  assert.equal(listeners.size, 0, "off the platform that needs it, nothing listens");

  await render({ enabled: true, arrangement: "modal" });
  move(pill);
  move(pill);
  move(wrapper);
  move(pill);
  assert.deepEqual(reports, [true, false, true], "each change is reported once");

  // The window grew upward to the transcript's size: the still pointer is now over its
  // empty part, found from where it is on screen.
  globalThis.window.screenX = 380;
  globalThis.window.screenY = -150;
  atPoint = wrapper;
  await render({ enabled: true, arrangement: "pill:true:true" });
  assert.deepEqual(asked.at(-1), [240, 920]);
  assert.deepEqual(reports, [true, false, true, false]);

  move(pill);
  listeners.get("root:mouseleave")();
  assert.deepEqual(reports, [true, false, true, false, true, false]);

  await React.act(async () => root.unmount());
  assert.equal(listeners.size, 0);
});
