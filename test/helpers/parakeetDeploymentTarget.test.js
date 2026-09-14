const test = require("node:test");
const assert = require("node:assert/strict");

const sherpaDownloader = require("../../scripts/download-sherpa-onnx");

const UNIVERSAL_VTOOL_OUTPUT = `
/tmp/libonnxruntime.dylib (architecture x86_64):
Load command 10
      cmd LC_BUILD_VERSION
 platform MACOS
    minos 15.5
      sdk 15.5
/tmp/libonnxruntime.dylib (architecture arm64):
Load command 10
      cmd LC_BUILD_VERSION
 platform MACOS
    minos 15.5
      sdk 15.5
`;

test("parses deployment targets for both ONNX Runtime architecture slices", () => {
  const targets = sherpaDownloader.parseMacosDeploymentTargets?.(UNIVERSAL_VTOOL_OUTPUT);

  assert.deepEqual(targets, [
    { architecture: "x86_64", minimumVersion: "15.5" },
    { architecture: "arm64", minimumVersion: "15.5" },
  ]);
});

test("accepts a universal ONNX Runtime library matching the runtime capability gate", () => {
  const result = sherpaDownloader.validateMacosDeploymentTargets?.([
    { architecture: "x86_64", minimumVersion: "15.5" },
    { architecture: "arm64", minimumVersion: "15.5" },
  ]);

  assert.deepEqual(result, {
    architectures: ["x86_64", "arm64"],
    minimumVersion: "15.5",
  });
});

test("rejects an ONNX Runtime slice whose deployment target exceeds the runtime gate", () => {
  assert.throws(
    () =>
      sherpaDownloader.validateMacosDeploymentTargets([
        { architecture: "x86_64", minimumVersion: "15.5" },
        { architecture: "arm64", minimumVersion: "16.0" },
      ]),
    /arm64 requires macOS 16.0, but the Parakeet capability gate is 15.5/
  );
});

test("rejects a packaged ONNX Runtime library missing a universal architecture slice", () => {
  assert.throws(
    () =>
      sherpaDownloader.validateMacosDeploymentTargets([
        { architecture: "arm64", minimumVersion: "15.5" },
      ]),
    /missing required architecture: x86_64/
  );
});

test("validates the ONNX Runtime library the sherpa binaries load", () => {
  const appPath = "/tmp/OpenWhispr.app";
  const result = sherpaDownloader.verifyPackagedMacosParakeet?.(appPath, {
    readDirectory(directory) {
      assert.equal(directory, `${appPath}/Contents/Resources/bin`);
      return ["libonnxruntime.dylib"];
    },
    runVtool(libraryPath) {
      assert.equal(libraryPath, `${appPath}/Contents/Resources/bin/libonnxruntime.dylib`);
      return UNIVERSAL_VTOOL_OUTPUT;
    },
  });

  assert.deepEqual(result, {
    architectures: ["x86_64", "arm64"],
    libraryPath: `${appPath}/Contents/Resources/bin/libonnxruntime.dylib`,
    minimumVersion: "15.5",
  });
});
