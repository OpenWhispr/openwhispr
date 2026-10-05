const test = require("node:test");
const assert = require("node:assert/strict");

// setNotificationInteractivity has two jobs: hit-testing and the auto-dismiss
// countdown. On Linux only the first has to be skipped — Electron ignores the
// `forward` option there, so a card put back into click-through never receives
// another mouseenter and its Start/Dismiss buttons die with it (#1456).
// Skipping the countdown too would let the card close under the pointer.
const setNotificationInteractivity = (platform, win, timer, interactive) => {
  const togglesClickThrough = platform !== "linux";
  if (interactive) {
    if (togglesClickThrough) win.setIgnoreMouseEvents(false);
    timer.pause();
  } else {
    if (togglesClickThrough) win.setIgnoreMouseEvents(true, { forward: true });
    timer.resume();
  }
};

const harness = () => {
  const calls = { ignoreMouseEvents: [], timer: [] };
  return {
    calls,
    win: {
      setIgnoreMouseEvents: (ignore, opts) => calls.ignoreMouseEvents.push({ ignore, opts }),
    },
    timer: {
      pause: () => calls.timer.push("pause"),
      resume: () => calls.timer.push("resume"),
    },
  };
};

test("Linux never returns the card to click-through", () => {
  const { calls, win, timer } = harness();

  setNotificationInteractivity("linux", win, timer, true);
  setNotificationInteractivity("linux", win, timer, false);

  assert.deepEqual(calls.ignoreMouseEvents, []);
});

test("Linux still pauses and resumes the dismiss countdown", () => {
  const { calls, win, timer } = harness();

  setNotificationInteractivity("linux", win, timer, true);
  setNotificationInteractivity("linux", win, timer, false);

  // The earlier proposed fix returned early on Linux and lost this.
  assert.deepEqual(calls.timer, ["pause", "resume"]);
});

for (const platform of ["darwin", "win32"]) {
  test(`${platform} keeps the existing click-through behaviour`, () => {
    const { calls, win, timer } = harness();

    setNotificationInteractivity(platform, win, timer, true);
    setNotificationInteractivity(platform, win, timer, false);

    assert.deepEqual(calls.ignoreMouseEvents, [
      { ignore: false, opts: undefined },
      { ignore: true, opts: { forward: true } },
    ]);
    assert.deepEqual(calls.timer, ["pause", "resume"]);
  });
}

test("repeated hovers on Linux stay interactive, so the buttons survive", () => {
  const { calls, win, timer } = harness();

  for (let i = 0; i < 3; i++) {
    setNotificationInteractivity("linux", win, timer, true);
    setNotificationInteractivity("linux", win, timer, false);
  }

  assert.deepEqual(calls.ignoreMouseEvents, []);
  assert.equal(calls.timer.filter((c) => c === "pause").length, 3);
  assert.equal(calls.timer.filter((c) => c === "resume").length, 3);
});
