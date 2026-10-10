const test = require("node:test");
const assert = require("node:assert/strict");
const React = require("react");
const { createRendererServer } = require("../lib/rendererTestHarness");
const { mountAuditDom } = require("../lib/settingsAuditHarness");

test("microphone inventory is usable before native label hydration and preserves device behavior", async (t) => {
  const mounted = await mountAuditDom(t);
  const { dom, container } = mounted;
  let root = mounted.root;
  const calls = { enumerate: 0, permission: 0, added: 0, removed: 0, defaults: 0, stopped: 0 };
  let deviceChanged;
  let devices = [{ kind: "audioinput", deviceId: "mic", label: "USB microphone" }];
  let readDevices = async () => devices;
  Object.defineProperty(globalThis, "navigator", {
    configurable: true,
    value: {
      mediaDevices: {
        async enumerateDevices() {
          calls.enumerate++;
          return readDevices();
        },
        async getUserMedia() {
          calls.permission++;
          return { getTracks: () => [{ stop: () => calls.stopped++ }] };
        },
        addEventListener(event, callback) {
          assert.equal(event, "devicechange");
          calls.added++;
          deviceChanged = callback;
        },
        removeEventListener(event, callback) {
          assert.equal(event, "devicechange");
          assert.equal(callback, deviceChanged);
          calls.removed++;
        },
      },
    },
  });
  let finishDefault;
  let defaultMic = () =>
    new Promise((resolve) => {
      finishDefault = resolve;
    });
  dom.electronAPI = {
    async getSystemDefaultMicrophone() {
      calls.defaults++;
      return defaultMic();
    },
  };
  const vite = await createRendererServer(t, {
    cachePrefix: "openwhispr-general-controls-",
    noExternal: ["react-i18next"],
    mockModules: {
      "react-i18next": `const t = key => key; export const useTranslation = () => ({t});`,
      "../icons": `export const RefreshCw = () => null; export const Mic = () => null;`,
      "/stores/settingsStore": `export const MIC_WARM_HOLD_CHOICES = [0, 10, 60, 900];`,
    },
  });
  const { MicrophoneSettings } = await vite.ssrLoadModule("/components/ui/MicrophoneSettings.tsx");
  const selections = [];
  const modes = [];
  const warmHolds = [];
  const props = {
    microphoneSelectionMode: "system",
    selectedMicDeviceId: "",
    selectedMicDeviceLabel: "",
    micWarmHoldSeconds: 0,
    onSelectionModeChange: (mode) => modes.push(mode),
    onDeviceSelect: (...args) => selections.push(args),
    onMicWarmHoldSecondsChange: (seconds) => warmHolds.push(seconds),
  };
  const render = (changes = {}) =>
    React.act(async () =>
      root.render(React.createElement(MicrophoneSettings, { ...props, ...changes }))
    );
  const input = () => container.querySelector("select[aria-labelledby]");
  const warmHold = () =>
    container.querySelector('select[aria-label="microphoneSettings.warmHold.label"]');
  const change = (select, value) =>
    React.act(async () => {
      select.value = value;
      select.dispatchEvent(new dom.Event("change", { bubbles: true }));
    });
  await render();
  assert.equal(input().options.length, 3, "enumerated devices do not wait for the native lookup");
  await change(input(), "mic");
  assert.deepEqual(
    selections,
    [["mic", "USB microphone"]],
    "a specific device is already selectable"
  );
  assert.deepEqual(modes, ["specific"]);
  selections.length = 0;
  modes.length = 0;
  await React.act(async () => finishDefault({ name: "USB microphone" }));
  assert.equal(input().options.length, 3);
  assert.equal(input().value, "__system__");
  assert.match(input().selectedOptions[0].textContent, /USB microphone/);
  assert.ok(dom.document.getElementById(input().getAttribute("aria-labelledby")));
  assert.deepEqual(
    [...warmHold().options].map((option) => option.value),
    ["0", "10", "60", "900"]
  );
  assert.deepEqual(calls, {
    enumerate: 1,
    permission: 0,
    added: 1,
    removed: 0,
    defaults: 1,
    stopped: 0,
  });

  await change(input(), "mic");
  assert.deepEqual(selections, [["mic", "USB microphone"]]);
  assert.deepEqual(modes, ["specific"]);
  await change(input(), "__built-in__");
  await change(input(), "__system__");
  assert.deepEqual(modes, ["specific", "built-in", "system"]);
  await change(warmHold(), "60");
  assert.deepEqual(warmHolds, [60]);

  defaultMic = async () => ({ name: "USB microphone" });
  await React.act(async () =>
    container.querySelector('button[aria-label="common.refresh"]').click()
  );
  await React.act(async () => deviceChanged());
  assert.equal(calls.enumerate, 3);
  assert.equal(calls.permission, 0);
  assert.equal(calls.added, 1);

  await render({
    microphoneSelectionMode: "specific",
    selectedMicDeviceId: "missing",
    selectedMicDeviceLabel: "Missing",
  });
  assert.equal(input().value, "missing");
  assert.equal(
    input().selectedOptions[0].disabled,
    true,
    "missing devices must not silently display System Default"
  );
  devices = [{ kind: "audioinput", deviceId: "replacement", label: "Missing" }];
  await React.act(async () => deviceChanged());
  assert.deepEqual(
    selections.at(-1),
    ["replacement", "Missing"],
    "label-based device remapping survives"
  );

  let reads = 0;
  readDevices = async () =>
    ++reads === 1 ? [{ kind: "audioinput", deviceId: "mic", label: "" }] : devices;
  await React.act(async () => deviceChanged());
  assert.equal(calls.permission, 1);
  assert.equal(calls.stopped, 1, "permission-only streams are immediately released");

  let permissionReads = 0,
    finishPermissionEnumeration,
    permissionScan;
  readDevices = async () => {
    permissionReads++;
    if (permissionReads === 1) return [{ kind: "audioinput", deviceId: "unlabelled", label: "" }];
    if (permissionReads === 2)
      return new Promise((resolve) => {
        finishPermissionEnumeration = resolve;
      });
    return [{ kind: "audioinput", deviceId: "current", label: "Current inventory" }];
  };
  await React.act(async () => {
    permissionScan = deviceChanged();
  });
  assert.equal(permissionReads, 2, "permission retry enumeration is pending");
  await React.act(async () => deviceChanged());
  assert.ok([...input().options].some((option) => option.value === "current"));
  await React.act(async () => {
    finishPermissionEnumeration([
      { kind: "audioinput", deviceId: "obsolete", label: "Old inventory" },
    ]);
    await permissionScan;
  });
  assert.ok(
    [...input().options].some((option) => option.value === "current"),
    "old permission enumeration cannot replace newer inventory"
  );
  assert.equal(
    [...input().options].some((option) => option.value === "obsolete"),
    false
  );
  readDevices = async () => {
    throw Error("permission denied");
  };
  await React.act(async () => deviceChanged());
  assert.match(container.textContent, /microphoneSettings.errors.unableToAccess/);
  readDevices = async () => devices;
  await React.act(async () => deviceChanged());
  assert.ok(input(), "refresh recovers the control after failure");

  const pending = [];
  defaultMic = () => new Promise((resolve) => pending.push(resolve));
  let first, second;
  await React.act(async () => {
    first = deviceChanged();
  });
  await React.act(async () => {
    second = deviceChanged();
  });
  const writesBefore = selections.length;
  await React.act(async () => {
    pending[1]({ name: "Newest" });
    await second;
  });
  await React.act(async () => {
    pending[0]({ name: "Old" });
    await first;
  });
  assert.equal(
    selections.length,
    writesBefore + 1,
    "only the latest reply may reconcile selection"
  );
  assert.match(input().options[0].textContent, /Newest/);
  let late;
  await React.act(async () => {
    late = deviceChanged();
  });
  const beforeClose = selections.length;
  await React.act(async () => root.unmount());
  root = null;
  await React.act(async () => {
    pending[2]({ name: "Late" });
    await late;
  });
  assert.equal(selections.length, beforeClose);
  assert.equal(calls.removed, calls.added);
});
