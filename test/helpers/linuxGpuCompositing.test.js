const test = require("node:test");
const assert = require("node:assert/strict");

const {
  NVIDIA_DRIVER_VERSION_PATH,
  shouldDisableGpuCompositing,
} = require("../../src/helpers/linuxGpuCompositing.js");

function withPlatform(platform, run) {
  const originalPlatform = Object.getOwnPropertyDescriptor(process, "platform");
  Object.defineProperty(process, "platform", { value: platform, configurable: true });
  try {
    run();
  } finally {
    Object.defineProperty(process, "platform", originalPlatform);
  }
}

const nvidiaLoaded = (filePath) => filePath === NVIDIA_DRIVER_VERSION_PATH;
const noNvidia = () => false;

test("keeps CPU compositing on Linux while an NVIDIA driver is loaded", () => {
  withPlatform("linux", () => {
    assert.equal(shouldDisableGpuCompositing(nvidiaLoaded), true);
  });
});

test("composites on the GPU on Linux without an NVIDIA driver", () => {
  withPlatform("linux", () => {
    assert.equal(shouldDisableGpuCompositing(noNvidia), false);
  });
});

test("never disables GPU compositing on macOS or Windows", () => {
  for (const platform of ["darwin", "win32"]) {
    withPlatform(platform, () => {
      assert.equal(shouldDisableGpuCompositing(nvidiaLoaded), false, platform);
    });
  }
});
