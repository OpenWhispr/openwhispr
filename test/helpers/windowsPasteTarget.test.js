const test = require("node:test");
const assert = require("node:assert/strict");
const {
  isRestorablePasteTarget,
  parseWindowHandle,
} = require("../../src/helpers/windowsPasteTarget");

const OWN_EXE = "OpenWhispr.exe";

function handleBuffer(hex, bytes = 8) {
  const buffer = Buffer.alloc(bytes);
  if (bytes >= 8) buffer.writeBigUInt64LE(BigInt(`0x${hex}`));
  else buffer.writeUInt32LE(Number(`0x${hex}`));
  return buffer;
}

test("another app's window is restored, as it was before the tray could start dictation", () => {
  const restorable = isRestorablePasteTarget({
    target: { id: "00001A2B", exeName: "notepad.exe" },
    ownExeName: OWN_EXE,
    ownWindowHandles: [],
  });

  assert.equal(restorable, true);
});

test("our own window stays a target, so dictating into a note still pastes there", () => {
  const restorable = isRestorablePasteTarget({
    target: { id: "00001A2B", exeName: "openwhispr.exe" },
    ownExeName: OWN_EXE,
    ownWindowHandles: [handleBuffer("0000BEEF"), handleBuffer("00001A2B")],
  });

  assert.equal(restorable, true);
});

// The tray menu's owner window: ours, but not one of our windows.
test("our own non-window surface is dropped rather than force-activated", () => {
  const restorable = isRestorablePasteTarget({
    target: { id: "00001A2B", exeName: "OpenWhispr.exe" },
    ownExeName: OWN_EXE,
    ownWindowHandles: [handleBuffer("0000BEEF")],
  });

  assert.equal(restorable, false);
});

test("a 32-bit window handle compares by value, not by buffer width", () => {
  const restorable = isRestorablePasteTarget({
    target: { id: "0x1A2B", exeName: OWN_EXE },
    ownExeName: OWN_EXE,
    ownWindowHandles: [handleBuffer("00001A2B", 4)],
  });

  assert.equal(restorable, true);
});

test("an unreadable window identity keeps the old behaviour", () => {
  const noExeName = isRestorablePasteTarget({
    target: { id: "00001A2B", exeName: null },
    ownExeName: OWN_EXE,
    ownWindowHandles: [],
  });
  assert.equal(noExeName, true, "a missing exe name reads as another app's window");

  const unparsableOwn = isRestorablePasteTarget({
    target: { id: "not-a-handle", exeName: OWN_EXE },
    ownExeName: OWN_EXE,
    ownWindowHandles: [handleBuffer("00001A2B")],
  });
  assert.equal(unparsableOwn, false, "ours but unidentifiable: don't force the foreground");

  assert.equal(isRestorablePasteTarget({ target: null, ownExeName: OWN_EXE }), false);
});

test("handles parse as hex with or without the 0x the helper may print", () => {
  assert.equal(parseWindowHandle("00001A2B"), 0x1a2bn);
  assert.equal(parseWindowHandle("0x00001A2B"), 0x1a2bn);
  assert.equal(parseWindowHandle("nope"), null);
});
