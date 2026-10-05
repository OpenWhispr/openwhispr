const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

// Execute the real startMeetingAec closure with only the helper process replaced.
const source = fs.readFileSync(path.join(__dirname, "../../src/helpers/ipcHandlers.js"), "utf8");
const startMeetingAecSource = source.slice(
  source.indexOf("const startMeetingAec ="),
  source.indexOf("const flushPendingMeetingMicChunks =")
);

async function startMeetingAec(meetingConnectionOptions) {
  let helperStarts = 0;
  const context = {
    meetingAecEnabled: false,
    meetingConnectionOptions,
    meetingAecManager: {
      isAvailable: () => true,
      start: async () => {
        helperStarts += 1;
        return true;
      },
    },
    debugLogger: { info() {}, warn() {}, debug() {} },
  };
  vm.createContext(context);
  vm.runInContext(`${startMeetingAecSource}; globalThis.run = startMeetingAec;`, context);
  const started = await context.run("loopback");
  return { started, helperStarts };
}

test("echo cancellation stays off unless the meeting start asks for it", async () => {
  for (const options of [{}, { echoCancellation: false }]) {
    assert.deepEqual(await startMeetingAec(options), {
      started: false,
      helperStarts: 0,
    });
  }
});

test("the AEC helper starts when the meeting start asks for echo cancellation", async () => {
  assert.deepEqual(await startMeetingAec({ echoCancellation: true }), {
    started: true,
    helperStarts: 1,
  });
});
