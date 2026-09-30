const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const createMeetingSystemAudioHandover = require("../../src/helpers/meetingSystemAudioHandover");
const { makeSine, toInt16Buffer } = require("./harness/pcmFixtures");

const { CONFIRM_MS } = createMeetingSystemAudioHandover;
const AUDIBLE = toInt16Buffer(makeSine({ durationMs: 100, amplitude: 0.3 }));

const source = fs.readFileSync(path.join(__dirname, "../../src/helpers/ipcHandlers.js"), "utf8");

const sliceBetween = (startMarker, endMarker) => {
  const start = source.indexOf(startMarker);
  const end = source.indexOf(endMarker, start);
  assert.ok(start >= 0 && end > start, `${startMarker} not found in ipcHandlers.js`);
  return source.slice(start, end);
};

function harness({ systemAudioHeard = false } = {}) {
  let now = 1_000_000;
  const events = [];
  const handlers = {};
  const context = {
    Buffer,
    meetingSystemAudioHeard: systemAudioHeard,
    meetingSystemAudioHandover: createMeetingSystemAudioHandover({ now: () => now }),
    meetingSystemAudioWatchdog: { detachCapture: () => events.push("detach") },
    debugLogger: { warn() {}, debug() {}, error() {}, info() {} },
    windowsLoopbackAudioManager: { stop: async () => events.push("stop") },
    BrowserWindow: {
      fromWebContents: () => ({
        isDestroyed: () => false,
        webContents: { send: (channel) => events.push(channel) },
      }),
    },
    ipcMain: { on: (channel, handler) => (handlers[channel] = handler) },
    sendMeetingAudio: (_buffer, source) => events.push(`send:${source}`),
  };
  vm.createContext(context);
  vm.runInContext(
    `${sliceBetween(
      "const degradeMeetingSystemAudioToLoopback =",
      "const startManagedMeetingSystemAudio ="
    )}
    ${sliceBetween('ipcMain.on("meeting-transcription-send"', "const stopMeetingTranscription =")}
    globalThis.degrade = () => degradeMeetingSystemAudioToLoopback({ sender: {} });`,
    context
  );
  return {
    events,
    degrade: context.degrade,
    sendRenderer: (buffer) => handlers["meeting-transcription-send"]({}, buffer, "system"),
    advance: (ms) => {
      now += ms;
    },
  };
}

test("a silent capture starts renderer loopback without stopping the helper", () => {
  const { events, degrade } = harness({ systemAudioHeard: true });

  degrade();
  degrade();

  assert.deepEqual(events, ["meeting-system-audio-degraded"]);
});

test("renderer chunks are held back until loopback hears what the helper misses", () => {
  const { events, degrade, sendRenderer, advance } = harness();
  degrade();
  events.length = 0;

  sendRenderer(AUDIBLE);
  assert.deepEqual(events, []);

  advance(CONFIRM_MS);
  sendRenderer(AUDIBLE);
  sendRenderer(AUDIBLE);

  assert.deepEqual(events, ["detach", "stop", "send:system", "send:system"]);
});

test("renderer chunks pass straight through when no helper handover is pending", () => {
  const { events, sendRenderer } = harness();

  sendRenderer(AUDIBLE);

  assert.deepEqual(events, ["send:system"]);
});
