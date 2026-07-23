const test = require("node:test");
const assert = require("node:assert/strict");

const WindowManager = require("../../src/helpers/windowManager.js");

const HOLD_DELAY_MS = 175;

const makeManager = () => {
  const calls = {
    captureTarget: 0,
    show: 0,
    hide: 0,
    startVoiceAgent: 0,
    stop: 0,
    cancel: 0,
  };
  const manager = Object.create(WindowManager.prototype);
  manager.voiceAgentPushState = null;
  manager.macCompoundPushState = null;
  manager.textEditMonitor = {
    captureTargetPid() {
      calls.captureTarget += 1;
    },
  };
  manager.showDictationPanel = () => {
    calls.show += 1;
  };
  manager.hideDictationPanel = () => {
    calls.hide += 1;
  };
  manager.sendStartVoiceAgent = () => {
    calls.startVoiceAgent += 1;
  };
  manager.sendStopDictation = () => {
    calls.stop += 1;
  };
  manager.sendCancelDictation = () => {
    calls.cancel += 1;
  };
  return { manager, calls };
};

test("quick Voice Agent hotkey taps do not start or submit a recording", async () => {
  const { manager, calls } = makeManager();

  manager.startVoiceAgentPushToTalk("F8");
  manager.handleVoiceAgentPushKeyUp("F8");
  await new Promise((resolve) => setTimeout(resolve, HOLD_DELAY_MS));

  assert.equal(calls.captureTarget, 1);
  assert.equal(calls.show, 1);
  assert.equal(calls.hide, 1);
  assert.equal(calls.startVoiceAgent, 0);
  assert.equal(calls.stop, 0);
  assert.equal(manager.voiceAgentPushState, null);
});

test("holding and releasing the Voice Agent hotkey starts then submits", async () => {
  const { manager, calls } = makeManager();

  manager.startVoiceAgentPushToTalk("Control+Shift+A");
  await new Promise((resolve) => setTimeout(resolve, HOLD_DELAY_MS));

  assert.equal(calls.startVoiceAgent, 1);
  assert.equal(manager.voiceAgentPushState?.isRecording, true);

  manager.handleVoiceAgentPushKeyUp("Control+Shift+A");

  assert.equal(calls.stop, 1);
  assert.equal(calls.hide, 0);
  assert.equal(manager.voiceAgentPushState, null);
});

test("macOS compound Voice Agent hotkeys start and submit without dictation mode state", async () => {
  const { manager, calls } = makeManager();

  manager.startMacCompoundPushToTalk("Command+Shift+K", "voiceAgent");
  await new Promise((resolve) => setTimeout(resolve, HOLD_DELAY_MS));

  assert.equal(calls.startVoiceAgent, 1);
  assert.equal(manager.macCompoundPushState?.target, "voiceAgent");

  manager.handleMacPushModifierUp("shift");

  assert.equal(calls.stop, 1);
  assert.equal(manager.macCompoundPushState, null);
});

test("a different Voice Agent key cannot stop the active hold", async () => {
  const { manager, calls } = makeManager();

  manager.startVoiceAgentPushToTalk("F8");
  await new Promise((resolve) => setTimeout(resolve, HOLD_DELAY_MS));
  manager.handleVoiceAgentPushKeyUp("F9");

  assert.equal(calls.stop, 0);
  assert.equal(manager.voiceAgentPushState?.active, true);

  manager.handleVoiceAgentPushKeyUp("F8");
  assert.equal(calls.stop, 1);
});

test("interrupting an active Voice Agent hold cancels instead of submitting", async () => {
  const { manager, calls } = makeManager();

  manager.startVoiceAgentPushToTalk("GLOBE");
  await new Promise((resolve) => setTimeout(resolve, HOLD_DELAY_MS));
  manager.cancelVoiceAgentPushToTalk();

  assert.equal(calls.cancel, 1);
  assert.equal(calls.stop, 0);
  assert.equal(manager.voiceAgentPushState, null);
});
