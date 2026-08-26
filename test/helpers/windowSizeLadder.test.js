const test = require("node:test");
const assert = require("node:assert/strict");

const load = () => import("../../src/utils/windowSizeLadder.js");

test("the recording window fits the compact listening pill footprint", async () => {
  const { WINDOW_SIZES } = require("../../src/helpers/windowConfig");
  const { VOICE_PILL_FOOTPRINT } = await import("../../src/helpers/voicePillPresentation.js");

  // The RECORDING footprint exists to host the compact recording pill; the
  // window must never shrink below what the pill renders.
  assert.ok(WINDOW_SIZES.RECORDING.width >= VOICE_PILL_FOOTPRINT.recording.width);
  assert.ok(WINDOW_SIZES.RECORDING.height >= VOICE_PILL_FOOTPRINT.recording.height);
});

test("dictation error windows share the assistant width and grow for the transcript action", () => {
  const { WINDOW_SIZES } = require("../../src/helpers/windowConfig");
  assert.equal(WINDOW_SIZES.DICTATION_ERROR.width, WINDOW_SIZES.ASSISTANT.width);
  assert.equal(
    WINDOW_SIZES.DICTATION_ERROR_WITH_TRANSCRIPT.width,
    WINDOW_SIZES.DICTATION_ERROR.width
  );
  assert.ok(
    WINDOW_SIZES.DICTATION_ERROR_WITH_TRANSCRIPT.height > WINDOW_SIZES.DICTATION_ERROR.height
  );
});

test("dictation error windows grow to their full content and stay within the work area", () => {
  const { fitDictationErrorContentWindowToWorkArea } = require("../../src/helpers/windowConfig");
  assert.deepEqual(fitDictationErrorContentWindowToWorkArea(132, { width: 1440, height: 900 }), {
    width: 466,
    height: 156,
  });
  assert.deepEqual(fitDictationErrorContentWindowToWorkArea(1200, { width: 320, height: 240 }), {
    width: 201,
    height: 240,
  });
});

test("initial dictation error windows use the responsive live-transcript width", () => {
  const { fitDictationErrorWindowToWorkArea } = require("../../src/helpers/windowConfig");
  assert.deepEqual(
    fitDictationErrorWindowToWorkArea({ width: 466, height: 112 }, { width: 1440, height: 900 }),
    { width: 466, height: 112 }
  );
  assert.deepEqual(
    fitDictationErrorWindowToWorkArea({ width: 466, height: 168 }, { width: 320, height: 240 }),
    { width: 201, height: 168 }
  );
});

test("base state with nothing active", async () => {
  const { resolveMainWindowSizeKey } = await load();
  assert.equal(
    resolveMainWindowSizeKey({
      panelOpen: false,
      menuOpen: false,
      toastCount: 0,
      compactPill: false,
    }),
    "BASE"
  );
});

test("compact listening pill grows the window", async () => {
  const { resolveMainWindowSizeKey } = await load();
  assert.equal(
    resolveMainWindowSizeKey({
      panelOpen: false,
      menuOpen: false,
      toastCount: 0,
      compactPill: true,
    }),
    "RECORDING"
  );
});

test("a toast outranks the listening pill so both fit", async () => {
  const { resolveMainWindowSizeKey } = await load();
  assert.equal(
    resolveMainWindowSizeKey({
      panelOpen: false,
      menuOpen: false,
      toastCount: 1,
      compactPill: true,
    }),
    "WITH_TOAST"
  );
});

test("dictation errors use the matching one-action or two-action footprint", async () => {
  const { resolveMainWindowSizeKey } = await load();
  assert.equal(
    resolveMainWindowSizeKey({
      panelOpen: false,
      menuOpen: false,
      toastCount: 1,
      compactPill: false,
      dictationErrorActionCount: 1,
    }),
    "DICTATION_ERROR"
  );
  assert.equal(
    resolveMainWindowSizeKey({
      panelOpen: false,
      menuOpen: false,
      toastCount: 1,
      compactPill: false,
      dictationErrorActionCount: 2,
    }),
    "DICTATION_ERROR_WITH_TRANSCRIPT"
  );
});

test("menu over a listening pill needs the expanded window", async () => {
  const { resolveMainWindowSizeKey } = await load();
  assert.equal(
    resolveMainWindowSizeKey({
      panelOpen: false,
      menuOpen: true,
      toastCount: 0,
      compactPill: true,
    }),
    "EXPANDED"
  );
});

test("menu alone uses the menu size", async () => {
  const { resolveMainWindowSizeKey } = await load();
  assert.equal(
    resolveMainWindowSizeKey({
      panelOpen: false,
      menuOpen: true,
      toastCount: 0,
      compactPill: false,
    }),
    "WITH_MENU"
  );
});

test("the assistant panel wins over everything", async () => {
  const { resolveMainWindowSizeKey } = await load();
  assert.equal(
    resolveMainWindowSizeKey({
      panelOpen: true,
      menuOpen: true,
      toastCount: 2,
      compactPill: true,
    }),
    "ASSISTANT"
  );
  assert.equal(
    resolveMainWindowSizeKey({
      panelOpen: true,
      menuOpen: false,
      toastCount: 0,
      compactPill: false,
    }),
    "ASSISTANT"
  );
});

test("a toast dismissing never shrinks the window below an active state", async () => {
  const { resolveMainWindowSizeKey, SIZE_RANK } = await load();
  // Toast dismissal while recording resolves to RECORDING, not BASE.
  const during = resolveMainWindowSizeKey({
    panelOpen: false,
    menuOpen: false,
    toastCount: 0,
    compactPill: true,
  });
  assert.equal(during, "RECORDING");
  assert.ok(SIZE_RANK[during] > SIZE_RANK.BASE);
});

test("every ladder size key has a native footprint in WINDOW_SIZES", async () => {
  const { SIZE_RANK, resolveMainWindowSizeKey } = await load();
  const { WINDOW_SIZES } = require("../../src/helpers/windowConfig");

  // A ladder key missing from WINDOW_SIZES makes windowManager silently fall
  // back to the BASE footprint. Cover both the ranked keys and every key the
  // resolver can actually return across its whole input domain.
  const ladderKeys = new Set(Object.keys(SIZE_RANK));
  for (const panelOpen of [false, true]) {
    for (const menuOpen of [false, true]) {
      for (const toastCount of [0, 1]) {
        for (const compactPill of [false, true]) {
          for (const dictationErrorActionCount of [0, 1, 2]) {
            ladderKeys.add(
              resolveMainWindowSizeKey({
                panelOpen,
                menuOpen,
                toastCount,
                compactPill,
                dictationErrorActionCount,
              })
            );
          }
        }
      }
    }
  }

  for (const key of ladderKeys) {
    const size = WINDOW_SIZES[key];
    assert.ok(size, `WINDOW_SIZES is missing ladder key ${key}`);
    assert.equal(typeof size.width, "number");
    assert.equal(typeof size.height, "number");
  }
});

test("size ranks order every key", async () => {
  const { SIZE_RANK } = await load();
  assert.ok(
    SIZE_RANK.BASE < SIZE_RANK.RECORDING &&
      SIZE_RANK.RECORDING < SIZE_RANK.DICTATION_ERROR &&
      SIZE_RANK.DICTATION_ERROR < SIZE_RANK.DICTATION_ERROR_WITH_TRANSCRIPT &&
      SIZE_RANK.DICTATION_ERROR_WITH_TRANSCRIPT < SIZE_RANK.WITH_MENU &&
      SIZE_RANK.WITH_MENU < SIZE_RANK.WITH_TOAST &&
      SIZE_RANK.WITH_TOAST < SIZE_RANK.EXPANDED &&
      SIZE_RANK.EXPANDED < SIZE_RANK.ASSISTANT
  );
});
