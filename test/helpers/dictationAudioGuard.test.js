const test = require("node:test");
const assert = require("node:assert/strict");
const { EventEmitter } = require("node:events");

const {
  DictationAudioGuard,
  normalizeConfig,
  parseDeviceLine,
  pickVirtualTarget,
} = require("../../src/helpers/dictationAudioGuard");

const MIC = "{0.0.1.00000000}.{3b79349d-6333-4af0-b645-b242910edc1e}";
const CABLE_IN = "{0.0.0.00000000}.{f01fa0e3-0034-42c7-ba53-7d239db0ceb2}";
const SPEAKERS = "{0.0.0.00000000}.{4d90cbd7-4403-402c-94a8-5cb18ca6c2d6}";

// A stand-in for windows-dictation-audio-guard.exe that answers the protocol.
function createFakeHelper({ devices, forwardReply = "FORWARDING" } = {}) {
  const spawned = [];
  const spawnImpl = (binary, args) => {
    const child = new EventEmitter();
    child.commands = [];
    child.stdout = new EventEmitter();
    child.stdout.setEncoding = () => {};
    child.stderr = new EventEmitter();
    child.killed = false;
    child.kill = () => {
      child.killed = true;
      child.emit("exit", null);
    };
    const reply = (line) => setImmediate(() => child.stdout.emit("data", `${line}\r\n`));
    child.stdin = {
      write(text) {
        const command = text.trim();
        child.commands.push(command);
        if (command === "LIST") {
          for (const line of devices ?? []) reply(line);
          reply("LISTED");
        } else if (command.startsWith("FORWARD")) reply(forwardReply);
        else if (command === "UNFORWARD") reply("UNFORWARDED");
        else if (command.startsWith("GATE")) reply(`GATED ${command.slice(5)}`);
        else if (command.startsWith("DUCK")) reply("DUCKED 2");
        else if (command === "UNDUCK") reply("UNDUCKED 2");
      },
      end(text) {
        child.commands.push(text.trim());
        child.ended = true;
      },
    };
    child.args = args;
    child.binary = binary;
    spawned.push(child);
    reply("READY 1.0.0");
    return child;
  };
  return { spawnImpl, spawned };
}

const DEVICES = [
  `DEVICE capture 1 ${MIC}\tMicrophone (Realtek(R) Audio)`,
  `DEVICE render 1 ${SPEAKERS}\tSpeakers (Realtek(R) Audio)`,
  `DEVICE render 0 ${CABLE_IN}\tCABLE Input (VB-Audio Virtual Cable)`,
];

function createGuard(options = {}) {
  const fake = createFakeHelper(options);
  const timers = [];
  const guard = new DictationAudioGuard({
    platform: "win32",
    rootPid: 4242,
    spawnImpl: fake.spawnImpl,
    resolveBinary: () => "C:/fake/windows-dictation-audio-guard.exe",
    logger: { info() {}, warn() {}, debug() {} },
    setTimer: (fn, ms) => {
      const timer = { fn, ms };
      timers.push(timer);
      return timer;
    },
    clearTimer: (timer) => {
      const index = timers.indexOf(timer);
      if (index !== -1) timers.splice(index, 1);
    },
  });
  return { guard, fake, timers };
}

test("normalizeConfig clamps the duck level and refuses non-endpoint ids", () => {
  assert.deepEqual(
    normalizeConfig({
      duckEnabled: true,
      duckPercent: 150,
      callMicGateEnabled: true,
      callMicSourceId: "default\nQUIT",
      callMicTargetId: CABLE_IN,
    }),
    {
      duckEnabled: true,
      duckPercent: 99,
      callMicGateEnabled: true,
      callMicSourceId: "default",
      callMicTargetId: CABLE_IN,
    }
  );
  assert.equal(normalizeConfig({ duckPercent: "abc" }).duckPercent, 10);
  assert.equal(normalizeConfig({ duckEnabled: "true" }).duckEnabled, false);
});

test("parseDeviceLine and pickVirtualTarget find the virtual cable's input", () => {
  const devices = DEVICES.map(parseDeviceLine);
  assert.deepEqual(devices[0], {
    flow: "capture",
    isDefault: true,
    id: MIC,
    name: "Microphone (Realtek(R) Audio)",
  });
  assert.equal(parseDeviceLine("DEVICE render 0 nameless"), null);
  const render = devices.filter((device) => device.flow === "render");
  assert.equal(pickVirtualTarget(render).id, CABLE_IN);
  assert.equal(pickVirtualTarget(render.slice(0, 1)), null);
});

test("nothing is spawned while every feature is off", async () => {
  const { guard, fake } = createGuard({ devices: DEVICES });
  await guard.configure({});
  assert.equal(await guard.beginDictation(), true);
  assert.equal(await guard.endDictation(), true);
  assert.equal(fake.spawned.length, 0);
});

test("ducking lowers other apps for the dictation and restores them after", async () => {
  const { guard, fake } = createGuard({ devices: DEVICES });
  await guard.configure({ duckEnabled: true, duckPercent: 10 });
  await guard.beginDictation();
  await guard.beginDictation(); // repeated start paths must not duck twice
  await guard.endDictation();
  await guard.endDictation();
  const helper = fake.spawned[0];
  assert.deepEqual(helper.args, ["--parent", "4242"]);
  assert.deepEqual(helper.commands, ["DUCK 10 4242", "GATE 0", "UNDUCK"]);
});

test("the call mic gate forwards to the detected cable and silences it while dictating", async () => {
  const { guard, fake } = createGuard({ devices: DEVICES });
  const status = await guard.configure({ callMicGateEnabled: true });
  assert.equal(status.forwarding, true);
  assert.equal(status.forwardTargetName, "CABLE Input (VB-Audio Virtual Cable)");
  await guard.beginDictation();
  await guard.endDictation();
  assert.deepEqual(fake.spawned[0].commands, [
    "LIST",
    `FORWARD default ${CABLE_IN}`,
    "GATE 1",
    "GATE 0",
    "UNDUCK",
  ]);
});

test("without a virtual device the gate reports it instead of forwarding", async () => {
  const { guard, fake } = createGuard({ devices: DEVICES.slice(0, 2) });
  const status = await guard.configure({ callMicGateEnabled: true });
  assert.equal(status.forwarding, false);
  assert.equal(status.forwardError, "no-virtual-device");
  assert.ok(!fake.spawned[0].commands.some((command) => command.startsWith("FORWARD")));
});

test("a lost forward is retried, and a helper crash brings the forward back", async () => {
  const { guard, fake, timers } = createGuard({ devices: DEVICES });
  await guard.configure({ callMicGateEnabled: true });
  const first = fake.spawned[0];

  first.stdout.emit("data", "FORWARD_LOST 0x88890004\n");
  assert.equal(guard.getStatus().forwarding, false);
  const retry = timers.find((timer) => timer.ms === 5000);
  assert.ok(retry, "a retry is scheduled");
  retry.fn();
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(guard.getStatus().forwarding, true);

  first.emit("exit", 1);
  const afterCrash = timers.find((timer) => timer.ms === 5000);
  afterCrash.fn();
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(fake.spawned.length, 2);
  assert.equal(guard.getStatus().forwarding, true);
});

test("turning everything off quits the helper so it restores the audio", async () => {
  const { guard, fake } = createGuard({ devices: DEVICES });
  await guard.configure({ callMicGateEnabled: true });
  await guard.configure({ callMicGateEnabled: false });
  const helper = fake.spawned[0];
  assert.ok(helper.commands.includes("UNFORWARD"));
  assert.equal(helper.ended, true);
  assert.equal(helper.commands.at(-1), "QUIT");
});

test("other platforms never spawn the helper", async () => {
  const fake = createFakeHelper({ devices: DEVICES });
  const guard = new DictationAudioGuard({
    platform: "darwin",
    spawnImpl: fake.spawnImpl,
    resolveBinary: () => "/fake",
    logger: { info() {}, warn() {}, debug() {} },
  });
  await guard.configure({ duckEnabled: true, callMicGateEnabled: true });
  assert.equal(await guard.beginDictation(), false);
  assert.equal(guard.isSupported(), false);
  assert.equal(fake.spawned.length, 0);
});
