const test = require("node:test");
const assert = require("node:assert/strict");

const { focusWindowsHotkeyCaptureWindow } = require("../../src/helpers/hotkeyCaptureFocus");

function fakeWindow({ destroyed = false, minimized = false, visible = true } = {}) {
  const calls = [];
  return {
    calls,
    isDestroyed: () => destroyed,
    isMinimized: () => minimized,
    isVisible: () => visible,
    restore: () => calls.push("restore"),
    show: () => calls.push("show"),
    focus: () => calls.push("window-focus"),
    webContents: { focus: () => calls.push("renderer-focus") },
  };
}

test("Windows hotkey capture restores and focuses both the window and renderer", () => {
  const win = fakeWindow({ minimized: true, visible: false });

  assert.equal(focusWindowsHotkeyCaptureWindow(win, "win32"), true);
  assert.deepEqual(win.calls, ["restore", "show", "window-focus", "renderer-focus"]);
});

test("Windows hotkey capture refocuses an already visible window", () => {
  const win = fakeWindow();

  assert.equal(focusWindowsHotkeyCaptureWindow(win, "win32"), true);
  assert.deepEqual(win.calls, ["window-focus", "renderer-focus"]);
});

test("hotkey capture never steals native focus on macOS or Linux", () => {
  for (const platform of ["darwin", "linux"]) {
    const win = fakeWindow({ minimized: true, visible: false });

    assert.equal(focusWindowsHotkeyCaptureWindow(win, platform), false);
    assert.deepEqual(win.calls, []);
  }
});

test("hotkey capture ignores a destroyed Windows window", () => {
  const win = fakeWindow({ destroyed: true });

  assert.equal(focusWindowsHotkeyCaptureWindow(win, "win32"), false);
  assert.deepEqual(win.calls, []);
});
