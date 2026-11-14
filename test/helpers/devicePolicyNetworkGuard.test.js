const test = require("node:test");
const assert = require("node:assert/strict");
const { EventEmitter } = require("node:events");
const Module = require("node:module");

function fakeSession(name) {
  const handlers = {};
  return {
    name,
    handlers,
    webRequest: {
      onBeforeRequest: (filter, handler) => {
        handlers.request = handler === undefined ? null : handler;
      },
      onHeadersReceived: (filter, handler) => {
        handlers.headers = handler === undefined ? null : handler;
      },
    },
  };
}

const partitions = new Map();
const session = {
  defaultSession: fakeSession("default"),
  fromPartition: (name) => {
    if (!partitions.has(name)) partitions.set(name, fakeSession(name));
    return partitions.get(name);
  },
};
const originalLoad = Module._load;
Module._load = function patchedLoad(request, parent, isMain) {
  if (request === "electron") return { session, net: {}, app: { getPath: () => "" } };
  return originalLoad.call(this, request, parent, isMain);
};
const { installManagedNetworkGuard } = require("../../src/helpers/devicePolicyNetwork");
// The guard asks it for the asset session when installed.
require("../../src/helpers/downloadUtils");
Module._load = originalLoad;

const decide = (target, kind, url) =>
  new Promise((resolve) => target.handlers[kind]({ url }, ({ cancel }) => resolve(cancel)));

test("the guard covers the default session and later ones, but not asset or update downloads", async () => {
  const app = new EventEmitter();
  const allowed = new Set(["https://allowed.example/"]);
  const remove = installManagedNetworkGuard({ app, session, isAllowed: (url) => allowed.has(url) });

  for (const kind of ["request", "headers"]) {
    assert.equal(await decide(session.defaultSession, kind, "https://allowed.example/"), false);
    assert.equal(await decide(session.defaultSession, kind, "https://blocked.example/"), true);
  }
  const later = fakeSession("later");
  app.emit("session-created", later);
  assert.equal(await decide(later, "request", "https://blocked.example/"), true);

  // Model and update downloads keep their own sessions, outside the guard.
  for (const name of ["local-model-assets", "electron-updater"]) {
    app.emit("session-created", session.fromPartition(name));
    assert.equal(session.fromPartition(name).handlers.request, undefined, name);
  }

  remove();
  assert.equal(session.defaultSession.handlers.request, null);
  assert.equal(later.handlers.headers, null);
  app.emit("session-created", fakeSession("after"));
  assert.equal(app.listenerCount("session-created"), 0);
});
