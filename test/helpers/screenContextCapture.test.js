const test = require("node:test");
const assert = require("node:assert/strict");
const Module = require("node:module");

const modulePath = require.resolve("../../src/helpers/screenContextCapture");
const originalLoad = Module._load;

// Stands in for Electron's NativeImage: `bytesAtQuality` maps a JPEG quality to
// the encoded size that quality would produce for a given screen's content.
// The encoded stub reports that size and tags itself with the quality used, so
// tests can assert which rung of the ladder produced the payload.
function fakeImage(bytesAtQuality, { edge = 1568, resizes = [] } = {}) {
  return {
    isEmpty: () => false,
    toJPEG(quality) {
      return {
        length: bytesAtQuality(quality, edge),
        toString: () => Buffer.from(`jpeg-${quality}`).toString("base64"),
      };
    },
    resize({ width }) {
      resizes.push(width);
      return fakeImage(bytesAtQuality, { edge: width, resizes });
    },
  };
}

// The module reads `process.platform` when called, not when imported, so the
// override has to outlive the import — otherwise the darwin-only permission
// branch is skipped on Linux CI and every status looks granted.
function loadCapture(t, { image, platform = "darwin", accessStatus = "granted" }) {
  delete require.cache[modulePath];
  let currentAccessStatus = accessStatus;
  const calls = {
    thumbnailSizes: [],
    matchedRects: [],
    warns: [],
    setAccessStatus: (status) => {
      currentAccessStatus = status;
    },
  };

  const originalPlatform = process.platform;
  Object.defineProperty(process, "platform", { value: platform, configurable: true });
  t.after(() => {
    Object.defineProperty(process, "platform", {
      value: originalPlatform,
      configurable: true,
    });
    delete require.cache[modulePath];
  });

  Module._load = function loadWithMocks(request, parent, isMain) {
    if (request === "electron") {
      return {
        screen: {
          getCursorScreenPoint: () => ({ x: 0, y: 0 }),
          getDisplayNearestPoint: () => ({ id: 1, size: { width: 2560, height: 1440 } }),
          // A different size from the cursor's display, so tests can tell which
          // screen a capture was taken from.
          getDisplayMatching: (rect) => {
            calls.matchedRects.push(rect);
            return { id: 2, size: { width: 1512, height: 982 } };
          },
        },
        desktopCapturer: {
          getSources: async ({ thumbnailSize }) => {
            calls.thumbnailSizes.push(thumbnailSize);
            return [{ display_id: "1", thumbnail: image }];
          },
        },
        systemPreferences: { getMediaAccessStatus: () => currentAccessStatus },
      };
    }
    if (request.endsWith("debugLogger")) {
      return {
        warn: (message, meta, category) => calls.warns.push({ message, meta, category }),
        debug: () => {},
        info: () => {},
      };
    }
    return originalLoad.call(this, request, parent, isMain);
  };

  try {
    return { capture: require(modulePath), calls };
  } finally {
    Module._load = originalLoad;
  }
}

test("a typical screenshot is sent at the highest quality", async (t) => {
  const { capture } = loadCapture(t, { image: fakeImage(() => 300_000) });

  const result = await capture.captureActiveDisplay();

  assert.equal(result.mediaType, "image/jpeg");
  assert.equal(Buffer.from(result.data, "base64").toString(), "jpeg-82");
});

test("an oversized screenshot steps down the quality ladder until it fits", async (t) => {
  // Only the lowest quality gets under the budget.
  const { capture } = loadCapture(t, {
    image: fakeImage((quality) => (quality === 55 ? 900_000 : 2_000_000)),
  });

  const result = await capture.captureActiveDisplay();

  assert.equal(Buffer.from(result.data, "base64").toString(), "jpeg-55");
});

test("a screenshot that no quality fits is resized before a final attempt", async (t) => {
  const resizes = [];
  const { capture } = loadCapture(t, {
    // Incompressible at full size; fits once the long edge shrinks.
    image: fakeImage((_quality, edge) => (edge < 1568 ? 800_000 : 4_000_000), { resizes }),
  });

  const result = await capture.captureActiveDisplay();

  assert.deepEqual(resizes, [1024]);
  assert.equal(Buffer.from(result.data, "base64").toString(), "jpeg-55");
});

test("a screenshot that still cannot fit is dropped rather than sent oversized", async (t) => {
  const { capture } = loadCapture(t, { image: fakeImage(() => 9_000_000) });

  assert.equal(await capture.captureActiveDisplay(), null);
});

test("capture is skipped when screen recording access is not granted", async (t) => {
  const { capture, calls } = loadCapture(t, {
    image: fakeImage(() => 300_000),
    accessStatus: "denied",
  });

  assert.equal(await capture.captureActiveDisplay(), null);
  assert.equal(calls.thumbnailSizes.length, 0);
  // The skip must be diagnosable from the debug log, with the TCC status.
  assert.deepEqual(calls.warns, [
    {
      message: "Screen context capture skipped",
      meta: { accessStatus: "denied" },
      category: "screenContext",
    },
  ]);
});

test("a grant made while the app is running is flagged as needing a relaunch", (t) => {
  const { capture, calls } = loadCapture(t, {
    image: fakeImage(() => 300_000),
    accessStatus: "denied",
  });

  // Prime the launch-time snapshot, as ipcHandlers does at registration.
  capture.getAccessStatus();
  calls.setAccessStatus("granted");

  assert.deepEqual(capture.getAccessResult(), {
    granted: true,
    status: "granted",
    supported: true,
    needsRelaunch: true,
  });
});

test("a grant that predates launch never asks for a relaunch", (t) => {
  const { capture } = loadCapture(t, { image: fakeImage(() => 300_000) });

  assert.deepEqual(capture.getAccessResult(), {
    granted: true,
    status: "granted",
    supported: true,
    needsRelaunch: false,
  });
});

test("non-macOS platforms never need a relaunch", (t) => {
  const { capture } = loadCapture(t, {
    image: fakeImage(() => 300_000),
    platform: "win32",
  });

  assert.deepEqual(capture.getAccessResult(), {
    granted: true,
    status: "granted",
    supported: true,
    needsRelaunch: false,
  });
});

test("the captured thumbnail is bounded to the vision-model edge", async (t) => {
  const { capture, calls } = loadCapture(t, { image: fakeImage(() => 300_000) });

  await capture.captureActiveDisplay();

  const [size] = calls.thumbnailSizes;
  assert.equal(Math.max(size.width, size.height), 1568);
});

// On a multi-monitor desk the cursor often rests on a different screen than the
// app being dictated into, and photographing the cursor's screen sends the agent
// a picture of the wrong monitor.
test("a target window rect decides the screen, not the cursor", async (t) => {
  const { capture, calls } = loadCapture(t, { image: fakeImage(() => 300_000) });
  const targetBounds = { x: 0, y: 33, width: 1512, height: 949 };

  await capture.captureActiveDisplay(targetBounds);

  assert.deepEqual(calls.matchedRects, [targetBounds]);
  // The matched display is 1512x982, already inside the edge budget; the
  // cursor's 2560x1440 screen would have been scaled to 1568 wide instead.
  assert.deepEqual(calls.thumbnailSizes, [{ width: 1512, height: 982 }]);
});

test("without a target rect the cursor's screen is still used", async (t) => {
  const { capture, calls } = loadCapture(t, { image: fakeImage(() => 300_000) });

  await capture.captureActiveDisplay();

  assert.deepEqual(calls.matchedRects, []);
  assert.equal(calls.thumbnailSizes[0].width, 1568);
});
