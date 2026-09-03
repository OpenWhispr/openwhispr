const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");

const sherpaDownloader = require("../../scripts/download-sherpa-onnx");

const UNIVERSAL_VTOOL_OUTPUT = `
/tmp/libonnxruntime.1.27.0.dylib (architecture x86_64):
Load command 10
      cmd LC_BUILD_VERSION
 platform MACOS
    minos 15.5
      sdk 15.5
/tmp/libonnxruntime.1.27.0.dylib (architecture arm64):
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

// The sherpa binaries link @rpath/libonnxruntime.dylib, so that name is what must be validated.
// A versioned file beside it that it does not resolve to is a leftover from an older release:
// 60MB of dead weight in the signed bundle that dyld never loads.
test("rejects a packaged app still carrying an ONNX Runtime library from an older release", () => {
  const appPath = "/tmp/OpenWhispr.app";
  assert.throws(
    () =>
      sherpaDownloader.verifyPackagedMacosParakeet(appPath, {
        readDirectory: () => ["libonnxruntime.dylib", "libonnxruntime.1.27.0.dylib"],
        resolveLibrary: (libraryPath) => libraryPath,
        runVtool: () => UNIVERSAL_VTOOL_OUTPUT,
      }),
    /older release.*libonnxruntime\.1\.27\.0\.dylib/
  );
});

// Releases before 1.13.5 shipped the library versioned under an unversioned symlink, and the
// download script still produces that layout for any archive that ships versioned libraries.
test("accepts the pre-1.13.5 layout where the library is a symlink to a versioned file", () => {
  const appPath = "/tmp/OpenWhispr.app";
  const binDirectory = path.join(appPath, "Contents", "Resources", "bin");
  const libraryPath = path.join(binDirectory, "libonnxruntime.dylib");
  const result = sherpaDownloader.verifyPackagedMacosParakeet(appPath, {
    readDirectory: () => ["libonnxruntime.dylib", "libonnxruntime.1.27.0.dylib"],
    resolveLibrary: () => path.join(binDirectory, "libonnxruntime.1.27.0.dylib"),
    runVtool(actualLibraryPath) {
      assert.equal(actualLibraryPath, libraryPath);
      return UNIVERSAL_VTOOL_OUTPUT;
    },
  });

  assert.deepEqual(result, {
    architectures: ["x86_64", "arm64"],
    libraryPath,
    minimumVersion: "15.5",
  });
});

test("rejects a packaged app whose ONNX Runtime library does not resolve", () => {
  const appPath = "/tmp/OpenWhispr.app";
  assert.throws(
    () =>
      sherpaDownloader.verifyPackagedMacosParakeet(appPath, {
        readDirectory: () => ["libonnxruntime.dylib"],
        resolveLibrary: () => {
          throw new Error("ENOENT");
        },
        runVtool: () => UNIVERSAL_VTOOL_OUTPUT,
      }),
    /does not resolve/
  );
});

test("rejects a packaged app missing the ONNX Runtime library the sherpa binaries link", () => {
  const appPath = "/tmp/OpenWhispr.app";
  assert.throws(
    () =>
      sherpaDownloader.verifyPackagedMacosParakeet(appPath, {
        readDirectory: () => ["libonnxruntime.1.27.0.dylib", "libsherpa-onnx-c-api.dylib"],
        resolveLibrary: (libraryPath) => libraryPath,
        runVtool: () => UNIVERSAL_VTOOL_OUTPUT,
      }),
    /found libonnxruntime\.1\.27\.0\.dylib/
  );
});

test("rejects a packaged app with no ONNX Runtime library at all", () => {
  const appPath = "/tmp/OpenWhispr.app";
  assert.throws(
    () =>
      sherpaDownloader.verifyPackagedMacosParakeet(appPath, {
        readDirectory: () => ["libsherpa-onnx-c-api.dylib"],
        resolveLibrary: (libraryPath) => libraryPath,
        runVtool: () => UNIVERSAL_VTOOL_OUTPUT,
      }),
    /found no ONNX Runtime library/
  );
});

test("validates an unversioned ONNX Runtime library from a packaged app", () => {
  const appPath = "/tmp/OpenWhispr.app";
  const binDirectory = path.join(appPath, "Contents", "Resources", "bin");
  const libraryPath = path.join(binDirectory, "libonnxruntime.dylib");
  const result = sherpaDownloader.verifyPackagedMacosParakeet?.(appPath, {
    readDirectory(directory) {
      assert.equal(directory, binDirectory);
      return ["libonnxruntime.dylib"];
    },
    resolveLibrary: (actualLibraryPath) => actualLibraryPath,
    runVtool(actualLibraryPath) {
      assert.equal(actualLibraryPath, libraryPath);
      return UNIVERSAL_VTOOL_OUTPUT;
    },
  });

  assert.deepEqual(result, {
    architectures: ["x86_64", "arm64"],
    libraryPath,
    minimumVersion: "15.5",
  });
});
