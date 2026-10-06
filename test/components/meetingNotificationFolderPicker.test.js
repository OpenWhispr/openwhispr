const test = require("node:test");
const assert = require("node:assert/strict");
const React = require("react");
const { createRendererServer } = require("../lib/rendererTestHarness");
const contexts = () => ({
  spaces: [
    { id: 1, kind: "private", name: "Private" },
    { id: 2, kind: "team", name: "Team" },
  ],
  folders: Array.from({ length: 8 }, (_, i) => ({
    id: i + 1,
    space_id: i === 6 ? 2 : 1,
    name: i === 0 ? "Meetings" : "Calls " + i,
    is_default: i === 0 ? 1 : 0,
  })),
  defaultDestination: { folderId: 1, spaceId: 1 },
  selectedDestination: null,
  recentDestinations: [],
  existingNote: null,
});
async function mount(t, overrides = {}, setupDom = () => {}) {
  let root;
  const original = {};
  let dom;
  t.after(async () => {
    if (root) await React.act(async () => root.unmount());
    await dom?.happyDOM.close();
    for (const [key, value] of Object.entries(original)) {
      if (value) Object.defineProperty(globalThis, key, value);
      else delete globalThis[key];
    }
  });
  const { Window } = await import("happy-dom");
  dom = new Window({ url: "http://localhost:5173" });
  for (const key of [
    "window",
    "document",
    "navigator",
    "HTMLElement",
    "HTMLInputElement",
    "Node",
    "NodeFilter",
    "CustomEvent",
    "MutationObserver",
    "getComputedStyle",
    "Element",
    "Event",
    "KeyboardEvent",
    "MouseEvent",
    "CompositionEvent",
    "localStorage",
    "requestAnimationFrame",
    "cancelAnimationFrame",
    "ResizeObserver",
  ]) {
    original[key] = Object.getOwnPropertyDescriptor(globalThis, key);
    Object.defineProperty(globalThis, key, {
      value:
        typeof dom[key] === "function" &&
        (key.includes("AnimationFrame") || key === "getComputedStyle")
          ? dom[key].bind(dom)
          : dom[key],
      writable: true,
      configurable: true,
    });
  }
  original.IS_REACT_ACT_ENVIRONMENT = Object.getOwnPropertyDescriptor(
    globalThis,
    "IS_REACT_ACT_ENVIRONMENT"
  );
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  setupDom(dom);
  const data = {
    detectionId: "event",
    source: "calendar",
    key: "event",
    event: { summary: "Investor call" },
    variant: "starting",
    joinUrl: "https://example.test",
  };
  let context = contexts();
  const calls = [];
  const callbacks = {};
  const api = {
    getMeetingNotificationData: async () => data,
    onMeetingNotificationData: (cb) => ((callbacks.data = cb), () => {}),
    meetingNotificationReady: async () => {},
    setNotificationInteractivity: async () => {},
    setMeetingNotificationSurface: async (s) => ({
      success: true,
      value: { width: 416, height: s.contentHeight },
    }),
    onMeetingNotificationSurfaceClosed: (cb) => ((callbacks.blur = cb), () => {}),
    onMeetingNotificationSurfaceResized: () => () => {},
    getMeetingNotificationDestination: async () => ({ success: true, value: context }),
    selectMeetingNotificationFolder: async (ref) => {
      calls.push(["select", ref]);
      context = { ...context, selectedDestination: ref, recentDestinations: [ref] };
      return { success: true, value: context };
    },
    createMeetingNotificationFolder: async (req) => {
      calls.push(["create", req]);
      const ref = { folderId: 99, spaceId: req.spaceId };
      context = {
        ...context,
        folders: [
          ...context.folders,
          { id: 99, space_id: req.spaceId, name: req.name, is_default: 0 },
        ],
      };
      return { success: true, value: { ...context, createdFolder: ref } };
    },
    meetingNotificationRespond: async (...args) => {
      calls.push(["start", ...args]);
      return { success: true, value: null };
    },
    ...overrides,
  };
  globalThis.window.electronAPI = api;
  const vite = await createRendererServer(t, {
    cachePrefix: "meeting-folder-picker-",
    noExternal: ["react-i18next"],
    mockModules: {
      "react-i18next": `import en from '/locales/en/translation.json';const t=(key,values={})=>{let s=key.split('.').reduce((v,k)=>v?.[k],en)??key;return String(s).replace(/{{(\\w+)}}/g,(_,k)=>values[k]??'');};export const useTranslation=()=>({t,i18n:{language:'en'}});`,
    },
  });
  const { default: Overlay } = await vite.ssrLoadModule(
    "/components/MeetingNotificationOverlay.tsx"
  );
  const { createRoot } = require("react-dom/client");
  const container = globalThis.document.createElement("div");
  globalThis.document.body.append(container);
  root = createRoot(container);
  await React.act(async () => {
    root.render(React.createElement(Overlay));
    await new Promise((r) => setTimeout(r, 30));
  });
  const byLabel = (label) => container.querySelector(`[aria-label="${label}"]`);
  const button = (text) =>
    [...container.querySelectorAll("button")].find((b) => b.textContent.trim() === text);
  const click = async (el) => {
    assert.ok(el, "control exists");
    await React.act(async () =>
      el.dispatchEvent(new globalThis.window.MouseEvent("click", { bubbles: true, detail: 1 }))
    );
  };
  const type = async (el, text) => {
    await React.act(async () => {
      const setter = Object.getOwnPropertyDescriptor(
        globalThis.window.HTMLInputElement.prototype,
        "value"
      ).set;
      setter.call(el, text);
      el.dispatchEvent(new globalThis.window.Event("input", { bubbles: true }));
    });
  };
  return {
    container,
    calls,
    api,
    callbacks,
    byLabel,
    button,
    click,
    type,
    setContext: (c) => (context = c),
  };
}

test("cold start honestly lists five folders and selection never starts a meeting", async (t) => {
  const c = await mount(t);
  await c.click(c.byLabel("Choose meeting folder"));
  assert.equal(c.container.querySelectorAll('[role="option"]').length, 5);
  assert.ok(!c.container.textContent.includes("Recently used"));
  await c.click(c.byLabel("Private / Calls 1"));
  assert.equal(c.calls.filter((x) => x[0] === "select").length, 1);
  assert.equal(c.calls.filter((x) => x[0] === "start").length, 0);
  await c.click(c.button("Join and transcribe"));
  assert.equal(c.calls.filter((x) => x[0] === "start").length, 1);
});

test("search reaches shared folders and creation starts Private with an unmatched name", async (t) => {
  const c = await mount(t);
  await c.click(c.byLabel("Choose meeting folder"));
  await c.type(c.byLabel("Search folders"), "Unique folder");
  await c.click(c.button("New folder"));
  assert.equal(c.byLabel("Name").value, "Unique folder");
  assert.ok(c.button("Private"));
  await c.click(c.button("Create & select"));
  assert.equal(c.calls[0][0], "create");
  assert.equal(c.calls[0][1].spaceId, 1);
  assert.equal(c.calls[1][0], "select");
  assert.equal(c.calls.filter((x) => x[0] === "start").length, 0);
});

test("canceling a delayed create ignores its late selection and keeps Start disabled until settlement", async (t) => {
  let resolve;
  const c = await mount(t, {
    createMeetingNotificationFolder: () => new Promise((r) => (resolve = r)),
  });
  await c.click(c.byLabel("Choose meeting folder"));
  await c.click(c.button("New folder"));
  await c.type(c.byLabel("Name"), "Late folder");
  await c.click(c.button("Create & select"));
  await c.click(c.button("Cancel"));
  assert.equal(c.button("Join and transcribe").disabled, true);
  await React.act(async () =>
    resolve({
      success: true,
      value: { ...contexts(), createdFolder: { folderId: 99, spaceId: 1 } },
    })
  );
  assert.equal(c.calls.length, 0);
  assert.equal(c.button("Join and transcribe").disabled, false);
});
module.exports = { mount, contexts };

test("two recents fill with three fallbacks and an outside selection remains visible", async (t) => {
  const c = await mount(t);
  c.setContext({
    ...contexts(),
    recentDestinations: [
      { folderId: 7, spaceId: 2 },
      { folderId: 6, spaceId: 1 },
    ],
    selectedDestination: { folderId: 8, spaceId: 1 },
  });
  await c.click(c.byLabel("Choose meeting folder"));
  assert.equal(c.container.querySelectorAll('[role="option"]').length, 6);
  assert.ok(c.byLabel("Team / Calls 6 · Shared"));
  assert.ok(c.byLabel("Private / Calls 7"));
  await c.type(c.byLabel("Search folders"), "Calls 6");
  assert.equal(c.container.querySelectorAll('[role="option"]').length, 1);
  await c.click(c.byLabel("Clear search"));
  assert.equal(c.container.querySelectorAll('[role="option"]').length, 6);
});

test("a successful create with a failed selection retries only selection", async (t) => {
  const c = await mount(t);
  let selections = 0;
  c.api.selectMeetingNotificationFolder = async (ref) => {
    selections++;
    c.calls.push(["select", ref]);
    return selections === 1
      ? { success: false, code: "FOLDER_UNAVAILABLE" }
      : { success: true, value: { ...contexts(), selectedDestination: ref } };
  };
  await c.click(c.byLabel("Choose meeting folder"));
  await c.click(c.button("New folder"));
  await c.type(c.byLabel("Name"), "Retry folder");
  await c.click(c.button("Create & select"));
  assert.ok(c.container.querySelector('[role="alert"]'));
  await c.click(c.button("Create & select"));
  const creates = c.calls.filter((x) => x[0] === "create");
  assert.equal(creates.length, 2);
  assert.equal(creates[1][1].requestId, creates[0][1].requestId);
  assert.equal(selections, 2);
  assert.equal(c.container.querySelector('[role="dialog"]'), null);
});

test("IME commit Enter cannot create; the next explicit Enter can", async (t) => {
  const c = await mount(t);
  await c.click(c.byLabel("Choose meeting folder"));
  await c.click(c.button("New folder"));
  const input = c.byLabel("Name");
  await c.type(input, "会議");
  await React.act(async () => {
    input.dispatchEvent(
      new globalThis.window.CompositionEvent("compositionstart", { bubbles: true })
    );
    input.dispatchEvent(
      new globalThis.window.CompositionEvent("compositionend", { bubbles: true })
    );
    input.dispatchEvent(
      new globalThis.window.KeyboardEvent("keydown", {
        key: "Enter",
        bubbles: true,
        cancelable: true,
      })
    );
    input.form.dispatchEvent(
      new globalThis.window.Event("submit", { bubbles: true, cancelable: true })
    );
  });
  assert.equal(c.calls.length, 0);
  await React.act(async () =>
    input.dispatchEvent(
      new globalThis.window.KeyboardEvent("keyup", { key: "Enter", bubbles: true })
    )
  );
  await c.click(c.button("Create & select"));
  assert.equal(c.calls[0][0], "create");
});

test("default Start remains available when destination loading fails", async (t) => {
  const c = await mount(t, {
    getMeetingNotificationDestination: async () => ({
      success: false,
      code: "FOLDERS_UNAVAILABLE",
    }),
  });
  await c.click(c.button("Join and transcribe"));
  assert.equal(c.calls.filter((x) => x[0] === "start").length, 1);
});

test("a failed dismiss never opens the folder picker", async (t) => {
  const c = await mount(t, {
    meetingNotificationRespond: async () => ({ success: false, code: "STALE_NOTIFICATION" }),
  });
  t.mock.timers.enable({ apis: ["setTimeout"] });
  await c.click(c.byLabel("Dismiss meeting notification"));
  await React.act(async () => t.mock.timers.tick(200));
  t.mock.timers.reset();
  assert.equal(c.container.querySelector('[role="dialog"]'), null);
});

test("a late existing root note replaces choices with an explanation in the same dropdown", async (t) => {
  const linked = {
    noteId: 4,
    spaceId: 2,
    folderId: null,
    spaceName: "Team",
    folderName: null,
    shared: true,
  };
  const c = await mount(t, {
    meetingNotificationRespond: async () => ({
      success: false,
      code: "LINKED_NOTE_CHANGED",
      context: { ...contexts(), existingNote: linked },
    }),
  });
  await c.click(c.button("Join and transcribe"));
  assert.equal(c.container.querySelectorAll('[role="dialog"]').length, 1);
  assert.equal(c.container.querySelector('[role="listbox"]'), null);
  assert.ok(c.container.textContent.includes("Team · Shared"));
  assert.ok(c.button("Join and transcribe"));
});

test("folder refresh cannot discard the intentional focus acknowledgment", async (t) => {
  const c = await mount(t);
  let focusReply;
  c.api.setMeetingNotificationSurface = async (state) =>
    state.focus === "request"
      ? new Promise((r) => (focusReply = r))
      : { success: true, value: { width: 416, height: 84 } };
  await c.click(c.byLabel("Choose meeting folder"));
  assert.ok(focusReply);
  await React.act(async () => focusReply({ success: true, value: { width: 416, height: 300 } }));
  assert.equal(globalThis.document.activeElement, c.byLabel("Search folders"));
});

test("pointer Create works after accepting an IME candidate without keyup", async (t) => {
  const c = await mount(t);
  await c.click(c.byLabel("Choose meeting folder"));
  await c.click(c.button("New folder"));
  const input = c.byLabel("Name");
  await c.type(input, "会議");
  await React.act(async () => {
    input.dispatchEvent(
      new globalThis.window.CompositionEvent("compositionstart", { bubbles: true })
    );
    input.dispatchEvent(
      new globalThis.window.CompositionEvent("compositionend", { bubbles: true })
    );
  });
  await c.click(c.button("Create & select"));
  assert.equal(c.calls.filter((x) => x[0] === "create").length, 1);
});

test("captured card swipe keeps pointer interactivity until release", async (t) => {
  const interactivity = [];
  const c = await mount(t, {
    setNotificationInteractivity: async (value) => interactivity.push(value),
  });
  await React.act(async () => new Promise((r) => setTimeout(r, 60)));
  const surface = c.container.querySelector(".meeting-notification-window");
  surface.setPointerCapture = () => {};
  surface.hasPointerCapture = () => true;
  surface.releasePointerCapture = () => {};
  const event = (type, x) =>
    new globalThis.window.PointerEvent(type, {
      bubbles: true,
      isPrimary: true,
      button: 0,
      pointerId: 1,
      clientX: x,
    });
  await React.act(async () => surface.dispatchEvent(event("pointerdown", 30)));
  await React.act(async () =>
    surface.dispatchEvent(
      new globalThis.window.MouseEvent("mousemove", { bubbles: true, clientX: 50 })
    )
  );
  assert.equal(interactivity.at(-1), true);
  t.mock.timers.enable({ apis: ["setTimeout"] });
  await React.act(async () => surface.dispatchEvent(event("pointerup", 150)));
  const dismissals = () => c.calls.filter((x) => x[0] === "start" && x[2] === "dismiss").length;
  assert.equal(dismissals(), 0, "the card slides out before main closes the window");
  await React.act(async () => t.mock.timers.tick(200));
  t.mock.timers.reset();
  assert.equal(dismissals(), 1);
});

test("selection feedback uses 200/600/400 milliseconds and repeats from a fresh start", async (t) => {
  const c = await mount(t);
  t.mock.timers.enable({ apis: ["setTimeout"] });
  await c.click(c.byLabel("Choose meeting folder"));
  await c.click(c.byLabel("Private / Calls 1"));
  const trigger = () => c.byLabel("Choose meeting folder");
  assert.ok(trigger().classList.contains("feedback-enter"));
  await React.act(async () => t.mock.timers.tick(200));
  assert.ok(trigger().classList.contains("feedback-hold"));
  await React.act(async () => t.mock.timers.tick(600));
  assert.ok(trigger().classList.contains("feedback-exit"));
  await React.act(async () => t.mock.timers.tick(399));
  assert.ok(trigger().classList.contains("feedback-exit"));
  await c.click(trigger());
  await c.click(c.byLabel("Private / Calls 2"));
  await React.act(async () => t.mock.timers.tick(1));
  assert.ok(trigger().classList.contains("feedback-enter"));
  await React.act(async () => t.mock.timers.tick(1199));
  assert.ok(trigger().classList.contains("feedback-idle"));
  t.mock.timers.reset();
});

test("linked root explanation receives focus and Escape closes it", async (t) => {
  const c = await mount(t, {
    getMeetingNotificationDestination: async () => ({
      success: true,
      value: {
        ...contexts(),
        existingNote: {
          noteId: 4,
          spaceId: 1,
          folderId: null,
          spaceName: "Private",
          folderName: null,
          shared: false,
        },
      },
    }),
  });
  await c.click(c.byLabel("Choose meeting folder"));
  const dialog = c.container.querySelector('[role="dialog"]');
  assert.equal(globalThis.document.activeElement, dialog);
  await React.act(async () =>
    globalThis.document.activeElement.dispatchEvent(
      new globalThis.window.KeyboardEvent("keydown", {
        key: "Escape",
        bubbles: true,
        cancelable: true,
      })
    )
  );
  assert.equal(c.container.querySelector('[role="dialog"]'), null);
});

test("initial surface includes tall localized card layout before entrance animation", async (t) => {
  const reports = [];
  await mount(
    t,
    {
      setMeetingNotificationSurface: async (state) => {
        reports.push(state);
        return { success: true, value: { width: 416, height: state.contentHeight } };
      },
    },
    (dom) => {
      const p = dom.HTMLElement.prototype;
      for (const [key, value] of Object.entries({
        offsetWidth: 392,
        offsetHeight: 106,
        offsetLeft: 12,
        offsetTop: 12,
      })) {
        Object.defineProperty(p, key, {
          configurable: true,
          get() {
            return this.getAttribute("data-meeting-region") === "card" ? value : 0;
          },
        });
      }
      p.getBoundingClientRect = () => ({ x: 500, y: 12, width: 392, height: 106 });
    }
  );
  assert.ok(reports.length);
  assert.ok(reports.every((report) => report.contentHeight >= 130));
});

test("Shared folders appear alongside Private folders in the same search results", async (t) => {
  const c = await mount(t);
  await c.click(c.byLabel("Choose meeting folder"));
  assert.equal(c.container.querySelector('[role="group"][aria-label="Location"]'), null);
  await c.type(c.byLabel("Search folders"), "Calls");
  assert.equal(c.calls.length, 0);
  assert.ok(c.byLabel("Private / Calls 1"));
  assert.ok(c.byLabel("Team / Calls 6 · Shared"));
  assert.equal(c.container.querySelectorAll('#meeting-folder-results [role="option"]').length, 7);
  await c.click(c.byLabel("Team / Calls 6 · Shared"));
  assert.deepEqual(c.calls, [["select", { folderId: 7, spaceId: 2 }]]);
  await c.click(c.byLabel("Choose meeting folder"));
  await c.click(c.button("New folder"));
  assert.ok(c.button("Private"), "creation still starts Private after Shared selection");
});

test("search matches the visible teamspace and exact folder path", async (t) => {
  const c = await mount(t);
  await c.click(c.byLabel("Choose meeting folder"));
  await c.type(c.byLabel("Search folders"), "Team");
  assert.ok(c.byLabel("Team / Calls 6 · Shared"));
  await c.type(c.byLabel("Search folders"), "Team / Calls 6");
  await c.click(c.byLabel("Team / Calls 6 · Shared"));
  assert.deepEqual(c.calls, [["select", { folderId: 7, spaceId: 2 }]]);
});

test("existing and created selections keep the same visible card with confirmation only", async (t) => {
  const c = await mount(t);
  await React.act(async () => new Promise((r) => setTimeout(r, 70)));
  const card = c.container.querySelector('[data-meeting-region="card"]');
  const motion = card.parentElement;
  const surfaceCalls = [];
  c.api.setMeetingNotificationSurface = async (state) => {
    surfaceCalls.push(state);
    return { success: true, value: { width: 416, height: state.contentHeight } };
  };
  for (const create of [false, true]) {
    await c.click(c.byLabel("Choose meeting folder"));
    if (create) {
      await c.click(c.button("New folder"));
      await c.type(c.byLabel("Name"), "New stable folder");
      await c.click(c.button("Create & select"));
    } else await c.click(c.byLabel("Private / Calls 1"));
    assert.equal(c.container.querySelector('[data-meeting-region="card"]'), card);
    assert.equal(motion.style.opacity, "1");
    assert.equal(motion.style.transform, "translateX(0) scale(1)");
    assert.ok(c.byLabel("Choose meeting folder").classList.contains("feedback-enter"));
    assert.equal(surfaceCalls.at(-1).focus, "release");
    assert.equal(surfaceCalls.at(-1).mode, "closed");
  }
  assert.equal(c.calls.filter(([action]) => action === "start").length, 0);
});

test("matching a teamspace path does not prefill an existing destination as a new folder", async (t) => {
  const c = await mount(t);
  await c.click(c.byLabel("Choose meeting folder"));
  await c.type(c.byLabel("Search folders"), "Team / Calls 6");
  await c.click(c.button("New folder"));
  assert.equal(c.byLabel("Name").value, "");
});

test("location dropdown opens with the keyboard and Escape preserves the folder form", async (t) => {
  const c = await mount(t);
  await c.click(c.byLabel("Choose meeting folder"));
  await c.click(c.button("New folder"));
  const location = c.button("Private");
  await React.act(async () => {
    location.focus();
    location.dispatchEvent(
      new globalThis.window.KeyboardEvent("keydown", {
        key: "ArrowDown",
        bubbles: true,
        cancelable: true,
      })
    );
  });
  const menu = c.container.querySelector('[role="menu"]');
  assert.ok(menu, "location opens as a keyboard-accessible dropdown");
  await React.act(async () =>
    menu.dispatchEvent(
      new globalThis.window.KeyboardEvent("keydown", {
        key: "Escape",
        bubbles: true,
        cancelable: true,
      })
    )
  );
  assert.equal(c.container.querySelector('[role="menu"]'), null);
  assert.ok(c.byLabel("Name"), "Escape only dismisses the location menu");
  assert.equal(c.calls.length, 0);
});

test("choosing a Shared location keeps the draft and creates only on submit", async (t) => {
  const c = await mount(t);
  await c.click(c.byLabel("Choose meeting folder"));
  await c.click(c.button("New folder"));
  await c.type(c.byLabel("Name"), "Team planning");
  await React.act(async () =>
    c.button("Private").dispatchEvent(
      new globalThis.window.KeyboardEvent("keydown", {
        key: "ArrowDown",
        bubbles: true,
        cancelable: true,
      })
    )
  );
  const option = [...c.container.querySelectorAll('[role="menuitemradio"]')].find((el) =>
    el.textContent.includes("Team")
  );
  await c.click(option);
  assert.equal(c.container.querySelector('[role="menu"]'), null);
  assert.equal(c.byLabel("Name").value, "Team planning");
  assert.equal(c.calls.length, 0);
  await c.click(c.button("Create & select"));
  assert.equal(c.calls[0][0], "create");
  assert.equal(c.calls[0][1].spaceId, 2);
  assert.equal(c.calls[0][1].name, "Team planning");
});
