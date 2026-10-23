const test = require("node:test");
const assert = require("node:assert/strict");
const Module = require("node:module");
const { EventEmitter } = require("node:events");
const Registry = require("../../src/helpers/agentStreamRequestRegistry");

const handlersPath = require.resolve("../../src/helpers/ipcHandlers");
const originalLoad = Module._load;
const handlers = new Map();
const anything = () =>
  new Proxy(function () {}, {
    get: (_target, property) =>
      property === "then" ? undefined : property === Symbol.toPrimitive ? () => "" : anything(),
    apply: () => anything(),
  });
let target,
  capture,
  token = null,
  policyBlocked = false;
const electron = {
  app: { getPath: () => "/tmp", getVersion: () => "test" },
  ipcMain: {
    handle: (name, callback) => handlers.set(name, callback),
    on() {},
    removeHandler() {},
  },
  BrowserWindow: { getAllWindows: () => [], fromWebContents: () => null },
  screen: { getPrimaryDisplay: () => ({ workAreaSize: { width: 0, height: 0 } }) },
};
test.before(() => {
  Module._load = function (request, parent, isMain) {
    if (request === "electron") return electron;
    if (parent?.filename === handlersPath && request === "./screenContextCapture")
      return { getAccessStatus() {}, captureActiveDisplay: (...args) => capture(...args) };
    if (parent?.filename === handlersPath && request === "./tokenStore")
      return { get: () => token, getState: () => ({ generation: 1 }) };
    if (parent?.filename === handlersPath && request === "./workspacePolicyManager")
      return {
        createWorkspacePolicyManager: () => ({ getPolicy: async () => ({}) }),
        isScreenContextBlocked: () => policyBlocked,
      };
    if (
      parent?.filename === handlersPath &&
      !["./ipcSender", "./agentStreamRequestRegistry"].includes(request) &&
      (request.startsWith("./") || request.startsWith("../"))
    )
      return anything();
    return originalLoad.call(this, request, parent, isMain);
  };
  delete require.cache[handlersPath];
  const IPCHandlers = require(handlersPath);
  target = {
    _calendarAuthorizationRequests: new Registry(),
    windowManager: {},
    textEditMonitor: {},
  };
  target._cancelCalendarAuthorizations = () =>
    IPCHandlers.prototype._cancelCalendarAuthorizations?.call(target);
  IPCHandlers.prototype.setupHandlers.call(
    new Proxy(target, {
      get: (value, property) => (property in value ? value[property] : anything()),
    })
  );
});
test.after(() => {
  Module._load = originalLoad;
});
const sender = (id) => Object.assign(new EventEmitter(), { id, mainFrame: {} });
const event = (contents) => ({ sender: contents, senderFrame: contents.mainFrame });
const deferred = () => {
  let resolve;
  const promise = new Promise((done) => {
    resolve = done;
  });
  return { resolve, promise };
};

test("calendar IPC cancellation owns one request and cannot stop a newer attempt", async () => {
  for (const [channel, manager, method] of [
    ["gcal-start-oauth", "googleCalendarManager", "startOAuth"],
    ["mcal-start-oauth", "microsoftCalendarManager", "startOAuth"],
    ["acal-connect", "appleCalendarManager", "connect"],
  ]) {
    const gates = [deferred(), deferred()];
    const signals = [];
    target[manager] = {
      [method]: async (options) => {
        const index = signals.length;
        signals.push(options?.signal);
        await gates[index].promise;
        return { success: true, email: "calendar@test" };
      },
    };
    const owner = sender(1),
      stranger = sender(2);
    const first = handlers.get(channel)(event(owner), "old");
    const second = handlers.get(channel)(event(owner), "new");
    handlers.get("calendar-cancel-connect")?.(event(stranger), "new");
    handlers.get("calendar-cancel-connect")?.(event(owner), "old");
    assert.equal(signals[0]?.aborted ?? false, true);
    assert.equal(signals[1]?.aborted ?? false, false);
    gates[0].resolve();
    gates[1].resolve();
    assert.equal((await first).success, false);
    assert.equal((await second).success, true);
    gates.push(deferred());
    const legacy = handlers.get(channel)(event(owner));
    gates[2].resolve();
    assert.equal((await legacy).success, true);
  }
});

test("Control Panel capture hides only its caller and restores its prior visibility and focus", async () => {
  for (const outcome of ["success", "failure", "blocked", "closed", "unfocused", "other"]) {
    const contents = sender(1);
    const panel = Object.assign(new EventEmitter(), {
      webContents: contents,
      visible: true,
      destroyed: false,
      focused: outcome !== "unfocused",
      focusedAgain: false,
      isVisible() {
        return this.visible;
      },
      isDestroyed() {
        return this.destroyed;
      },
      isMinimized: () => false,
      isFocused() {
        return this.focused;
      },
      getBounds: () => ({ x: 10, y: 20, width: 600, height: 800 }),
      hide() {
        this.visible = false;
      },
      show() {
        this.visible = true;
      },
      showInactive() {
        this.visible = true;
      },
      focus() {
        this.focusedAgain = true;
      },
    });
    target.windowManager.controlPanelWindow = panel;
    policyBlocked = outcome === "blocked";
    token = policyBlocked ? "test" : null;
    let visibleDuringCapture;
    capture = async () => {
      visibleDuringCapture = panel.visible;
      if (outcome === "closed") panel.emit("close");
      return outcome === "failure" ? null : { data: "image", mediaType: "image/jpeg" };
    };
    const result = await handlers.get("capture-screen-context")(
      event(outcome === "other" ? sender(3) : contents)
    );
    assert.equal(visibleDuringCapture, outcome === "other", outcome);
    assert.equal(panel.visible, outcome !== "closed", outcome);
    assert.equal(panel.focusedAgain, !["closed", "unfocused", "other"].includes(outcome), outcome);
    assert.equal(result === null, outcome === "failure" || outcome === "blocked", outcome);
  }
});
