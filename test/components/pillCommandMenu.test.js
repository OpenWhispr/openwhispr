const test = require("node:test");
const assert = require("node:assert/strict");
const { createElement } = require("react");
const { renderToStaticMarkup } = require("react-dom/server");
const { createRendererServer, installBrowserGlobals } = require("../lib/rendererTestHarness");

// The harness renders i18n keys verbatim (no i18next instance is initialized),
// so assertions match on the raw translation key rather than resolved copy.
async function renderMenu(t, props) {
  installBrowserGlobals(t);
  const vite = await createRendererServer(t, {
    cachePrefix: "openwhispr-pill-command-menu-test-",
  });
  const mod = await vite.ssrLoadModule("/components/dictation/PillCommandMenu.tsx");
  return renderToStaticMarkup(
    createElement(mod.PillCommandMenu, {
      buttonRef: { current: null },
      align: "right",
      isRecording: false,
      agentAllowed: true,
      meetingAllowed: true,
      isHovered: false,
      setWindowInteractivity: () => {},
      onToggleListening: () => {},
      onAskAssistant: () => {},
      onStartMeeting: () => {},
      onHide: () => {},
      onClose: () => {},
      ...props,
    })
  );
}

test("the command menu hides Ask Assistant while a recording is active", async (t) => {
  const idleMarkup = await renderMenu(t, { isRecording: false });
  assert.match(idleMarkup, /askAssistant/);

  const recordingMarkup = await renderMenu(t, { isRecording: true });
  assert.doesNotMatch(recordingMarkup, /askAssistant/);
});

// #2064: a menu always anchored on the pill's right edge hung past the window's left edge (and
// was clipped) whenever the pill docked at the left or center.
test("the command menu anchors on the pill's docked side", async (t) => {
  const menuClasses = async (align) => {
    const markup = await renderMenu(t, { align });
    return markup.match(/^<div class="([^"]*)"/)[1].split(" ");
  };

  const right = await menuClasses("right");
  assert.ok(right.includes("right-0"));
  assert.ok(!right.includes("left-0"));

  const left = await menuClasses("left");
  assert.ok(left.includes("left-0"));
  assert.ok(!left.includes("right-0"));

  const center = await menuClasses("center");
  assert.ok(center.includes("left-1/2") && center.includes("-translate-x-1/2"));

  // The dock is a physical screen edge, so a logical anchor would flip sides in RTL.
  for (const classes of [right, left, center]) {
    assert.ok(!classes.includes("end-0") && !classes.includes("start-0"));
  }
});

test("the command menu offers a meeting recording only while idle and allowed", async (t) => {
  assert.match(await renderMenu(t, {}), /startMeetingRecording/);
  assert.doesNotMatch(await renderMenu(t, { isRecording: true }), /startMeetingRecording/);
  assert.doesNotMatch(await renderMenu(t, { meetingAllowed: false }), /startMeetingRecording/);
});
