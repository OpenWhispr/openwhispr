const test = require("node:test");
const assert = require("node:assert/strict");
const React = require("react");
const { createRendererServer, installHappyDom } = require("../lib/rendererTestHarness");

test("only a header drag moves the modal; controls, releases, blur and unmount stay safe", async (t) => {
  let root;
  t.after(() => root && React.act(() => root.unmount()));
  const dom = await installHappyDom(t);
  const drags = [];
  dom.electronAPI = { agentWindowSetDragging: (active) => drags.push(active) };
  const vite = await createRendererServer(t, { cachePrefix: "openwhispr-agent-modal-drag-" });
  const { AgentModal } = await vite.ssrLoadModule("/components/agent/AgentModal.tsx");
  const { createRoot } = require("react-dom/client");
  const host = dom.document.createElement("div");
  dom.document.body.append(host);
  root = createRoot(host);
  await React.act(() =>
    root.render(
      React.createElement(AgentModal, {
        bare: false,
        glow: "none",
        conversationId: null,
        onNewChat() {},
        onSelectChat() {},
        onCollapse() {},
        children: "Conversation",
        footer: "Input",
      })
    )
  );
  const header = host.querySelector("header");
  const captures = [];
  header.setPointerCapture = (id) => captures.push(id);
  const pointer = (target, type, x = 100, buttons = 1) =>
    React.act(() =>
      target.dispatchEvent(
        new dom.PointerEvent(type, {
          bubbles: true,
          cancelable: true,
          pointerId: 1,
          button: 0,
          buttons,
          clientX: x,
          clientY: 20,
        })
      )
    );

  for (const button of header.querySelectorAll("button")) {
    // Radix's own menu opening is covered elsewhere; inspect the header's
    // bubbling drag handler without opening a portal in this gesture test.
    button.addEventListener("pointerdown", (event) => event.preventDefault());
    await pointer(button.querySelector("svg") || button, "pointerdown");
    await pointer(header, "pointermove", 120);
    await pointer(header, "pointerup", 120, 0);
  }
  assert.deepEqual(captures, [], "header controls never capture a drag");
  await pointer(header, "pointerdown");
  await pointer(header, "pointermove", 101);
  await pointer(header, "pointerup", 101, 0);
  assert.deepEqual(drags, [], "a click does not move the window");

  await pointer(header, "pointerdown");
  await pointer(header, "pointermove", 120);
  await pointer(header, "pointermove", 125);
  assert.deepEqual(drags, [true]);
  await pointer(header, "pointerup", 125, 0);
  assert.deepEqual(drags, [true, false]);
  await pointer(header, "pointerdown");
  await pointer(header, "pointermove", 120);
  await React.act(() => dom.dispatchEvent(new dom.Event("blur")));
  assert.deepEqual(drags, [true, false, true, false]);
  await pointer(header, "pointerdown");
  await pointer(header, "pointermove", 120);
  await pointer(header, "lostpointercapture");
  assert.equal(drags.at(-1), false);
  await pointer(header, "pointerdown");
  await pointer(header, "pointermove", 120);
  await React.act(() => root.unmount());
  root = null;
  assert.equal(drags.at(-1), false);
});
