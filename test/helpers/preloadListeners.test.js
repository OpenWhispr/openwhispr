const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const vm = require("node:vm");
const { EventEmitter } = require("node:events");

function load() {
  let api;
  const ipc = new EventEmitter();
  ipc.invoked = [];
  ipc.invoke = (channel, ...args) => {
    ipc.invoked.push({ channel, args });
    return Promise.resolve({ success: true });
  };
  vm.runInNewContext(fs.readFileSync(require.resolve("../../preload.js"), "utf8"), {
    require: () => ({
      contextBridge: { exposeInMainWorld: (_name, value) => (api = value) },
      ipcRenderer: ipc,
    }),
    process,
  });
  return { api, ipc };
}

test("every named preload listener discards native event/sender and removes only its wrapper", () => {
  const { api, ipc } = load();
  const native = { sender: ipc, ports: [{ privileged: true }] };
  const payload = { type: "progress", model: "tiny", modelId: "fake", percent: 42 };
  const legacy = new Set([
    "onWhisperDownloadProgress",
    "onParakeetDownloadProgress",
    "onModelDownloadProgress",
    "onUpdateAvailable",
    "onUpdateNotAvailable",
    "onUpdateDownloaded",
    "onUpdateDownloadProgress",
    "onUpdateError",
    "onWindowsPushToTalkUnavailable",
  ]);
  for (const [name, subscribe] of Object.entries(api).filter(([name]) => name.startsWith("on"))) {
    const received = [];
    const dispose = subscribe((...args) => received.push(args));
    const [channel] = ipc.eventNames();
    assert.equal(typeof channel, "string", name);
    const other = () => {};
    ipc.on(channel, other);
    ipc.emit(channel, native, payload, "extra");
    assert.equal(received.length, 1, name);
    assert.equal(received[0].includes(native), false, name);
    assert.equal(received[0].includes(ipc), false, name);
    if (legacy.has(name)) {
      assert.equal(received[0][0], undefined, name);
      assert.equal(received[0][1], payload, name);
      assert.equal(received[0][2], "extra", name);
    } else if (received[0].length) {
      assert.equal(received[0][0], payload, name);
    }
    dispose();
    dispose();
    assert.equal(ipc.listenerCount(channel), 1, name);
    ipc.emit(channel, native, payload);
    assert.equal(received.length, 1, name);
    ipc.removeListener(channel, other);
  }
  assert.equal(ipc.eventNames().length, 0);
});

test("every BYOK manifest key ships a working get/save bridge on its own channel", () => {
  const { api, ipc } = load();
  const { BYOK_API_KEYS } = require("../../src/config/secretKeys");
  for (const k of BYOK_API_KEYS) {
    assert.equal(typeof api[k.get], "function", `${k.get} missing from the preload API`);
    assert.equal(typeof api[k.save], "function", `${k.save} missing from the preload API`);
    api[k.get]();
    const getter = ipc.invoked.at(-1);
    assert.equal(getter.channel, `get-${k.base}-key`, k.get);
    assert.deepEqual(getter.args, [], k.get);
    api[k.save]("fake-key");
    const saver = ipc.invoked.at(-1);
    assert.equal(saver.channel, `save-${k.base}-key`, k.save);
    assert.deepEqual(saver.args, ["fake-key"], k.save);
  }
});
