const test = require("node:test");
const assert = require("node:assert/strict");
const React = require("react");
const { createRendererServer, installHappyDom } = require("../lib/rendererTestHarness");

for (const surface of ["header", "pill", "modal pill"]) {
  test(`a ${surface} drag moves the window; controls, releases, blur and unmount stay safe`, async (t) => {
    let root;
    t.after(() => root && React.act(() => root.unmount()));
    const dom = await installHappyDom(t);
    const drags = [];
    dom.electronAPI = { agentWindowSetDragging: (active) => drags.push(active) };
    const vite = await createRendererServer(t, { cachePrefix: "openwhispr-agent-modal-drag-" });
    const { AgentModal } = await vite.ssrLoadModule("/components/agent/AgentModal.tsx");
    const { AgentPill } = await vite.ssrLoadModule("/components/agent/AgentPill.tsx");
    const pill = React.createElement(AgentPill, {
      controls: {
        waveform: false,
        thinking: false,
        waiting: false,
        buttons: ["mic", "keyboard", "close"],
      },
      recording: false,
      readLevel: () => 0,
      onAction() {},
      inModal: surface === "modal pill",
    });
    const { createRoot } = require("react-dom/client");
    const host = dom.document.createElement("div");
    dom.document.body.append(host);
    root = createRoot(host);
    await React.act(() =>
      root.render(
        surface === "pill"
          ? pill
          : React.createElement(AgentModal, {
              bare: false,
              glow: "none",
              conversationId: null,
              onNewChat() {},
              onSelectChat() {},
              onCollapse() {},
              children: "Conversation",
              footer: surface === "modal pill" ? pill : "Input",
            })
      )
    );
    const header =
      surface === "header"
        ? host.querySelector("header")
        : host.querySelector('button[aria-label="agentWindow.actions.speak"]').parentElement
            .parentElement;
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
}
