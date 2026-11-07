const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { Arch } = require("app-builder-lib");

const { buildPeImage } = require("../helpers/harness/peFixture");
const { listImportedModules } = require("../../scripts/lib/pe-imports");
const { prepareVoiceDependencies, requiredSherpaPackages } = require("../../scripts/afterPack");

// Linux/Windows resolve resources to <appOutDir>/resources; macOS to
// <App>.app/Contents/Resources when appOutDir already ends in .app.
function makeApp(
  t,
  { platform, arch, sherpaPackages, wasm = true, peImages = platform === "win32" }
) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "afterpack-voice-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const appOutDir = platform === "darwin" ? path.join(root, "OpenWhispr.app") : root;
  const resourcesDir =
    platform === "darwin"
      ? path.join(appOutDir, "Contents", "Resources")
      : path.join(appOutDir, "resources");
  const modulesDir = path.join(resourcesDir, "app.asar.unpacked", "node_modules");
  fs.mkdirSync(modulesDir, { recursive: true });
  for (const name of sherpaPackages) {
    const dir = path.join(modulesDir, name);
    fs.mkdirSync(dir);
    if (peImages) {
      fs.writeFileSync(
        path.join(dir, "onnxruntime.dll"),
        buildPeImage({ imports: ["KERNEL32.dll"] })
      );
      fs.writeFileSync(
        path.join(dir, "sherpa-onnx.node"),
        buildPeImage({ imports: ["KERNEL32.dll", "onnxruntime.dll"] })
      );
    } else {
      fs.writeFileSync(path.join(dir, "sherpa-onnx.node"), "");
    }
  }
  const dist = path.join(modulesDir, "onnxruntime-web", "dist");
  fs.mkdirSync(dist, { recursive: true });
  for (const file of ["ort.node.min.js", "ort-wasm-simd-threaded.mjs"]) {
    fs.writeFileSync(path.join(dist, file), "");
  }
  if (wasm) fs.writeFileSync(path.join(dist, "ort-wasm-simd-threaded.wasm"), "");
  const context = {
    electronPlatformName: platform,
    arch: Arch[arch],
    appOutDir,
    packager: { appInfo: { productFilename: "OpenWhispr" } },
  };
  return { context, modulesDir };
}

test("maps each target to the package sherpa-onnx-node loads at runtime", () => {
  assert.deepEqual(requiredSherpaPackages({ platform: "darwin", arch: "x64" }), [
    "sherpa-onnx-darwin-x64",
  ]);
  assert.deepEqual(requiredSherpaPackages({ platform: "win32", arch: "x64" }), [
    "sherpa-onnx-win-x64",
  ]);
  assert.deepEqual(requiredSherpaPackages({ platform: "linux", arch: "arm64" }), [
    "sherpa-onnx-linux-arm64",
  ]);
  assert.deepEqual(requiredSherpaPackages({ platform: "darwin", arch: "universal" }), [
    "sherpa-onnx-darwin-arm64",
    "sherpa-onnx-darwin-x64",
  ]);
});

test("passes when the exact target package and the Smart Turn WASM are unpacked", (t) => {
  const { context } = makeApp(t, {
    platform: "darwin",
    arch: "arm64",
    sherpaPackages: ["sherpa-onnx-darwin-arm64"],
  });
  assert.doesNotThrow(() => prepareVoiceDependencies(context));
});

test("fails an x64 mac build that only has the arm64 runtime from the build host", (t) => {
  const { context } = makeApp(t, {
    platform: "darwin",
    arch: "x64",
    sherpaPackages: ["sherpa-onnx-darwin-arm64"],
  });
  assert.throws(() => prepareVoiceDependencies(context), /missing sherpa-onnx-darwin-x64/);
});

test("a universal mac build needs both darwin runtimes", (t) => {
  const armOnly = makeApp(t, {
    platform: "darwin",
    arch: "universal",
    sherpaPackages: ["sherpa-onnx-darwin-arm64"],
  });
  assert.throws(() => prepareVoiceDependencies(armOnly.context), /missing sherpa-onnx-darwin-x64/);

  const both = makeApp(t, {
    platform: "darwin",
    arch: "universal",
    sherpaPackages: ["sherpa-onnx-darwin-arm64", "sherpa-onnx-darwin-x64"],
  });
  assert.doesNotThrow(() => prepareVoiceDependencies(both.context));
});

test("fails when the Smart Turn WASM was not unpacked", (t) => {
  const { context } = makeApp(t, {
    platform: "linux",
    arch: "x64",
    sherpaPackages: ["sherpa-onnx-linux-x64"],
    wasm: false,
  });
  assert.throws(() => prepareVoiceDependencies(context), /ort-wasm-simd-threaded\.wasm/);
});

test("fails when the file list dropped the Node entry Smart Turn loads", (t) => {
  const { context, modulesDir } = makeApp(t, {
    platform: "linux",
    arch: "x64",
    sherpaPackages: ["sherpa-onnx-linux-x64"],
  });
  fs.rmSync(path.join(modulesDir, "onnxruntime-web", "dist", "ort.node.min.js"));
  assert.throws(() => prepareVoiceDependencies(context), /ort\.node\.min\.js/);
});

test("privatizes ONNX Runtime in the target Windows package", (t) => {
  const { context, modulesDir } = makeApp(t, {
    platform: "win32",
    arch: "x64",
    sherpaPackages: ["sherpa-onnx-win-x64", "sherpa-onnx-win-ia32"],
  });
  prepareVoiceDependencies(context);

  const target = path.join(modulesDir, "sherpa-onnx-win-x64");
  assert.equal(fs.existsSync(path.join(target, "onnxruntime.dll")), false);
  assert.equal(fs.existsSync(path.join(target, "ow-onnxrt.dll")), true);
  assert.deepEqual(listImportedModules(fs.readFileSync(path.join(target, "sherpa-onnx.node"))), [
    "KERNEL32.dll",
    "ow-onnxrt.dll",
  ]);
  // A stray non-target package is not the runtime this build loads, so it doesn't ship.
  assert.equal(fs.existsSync(path.join(modulesDir, "sherpa-onnx-win-ia32")), false);
});

// The fixtures are valid PE images importing onnxruntime.dll, so privatizing
// would succeed here if it ran: only the platform gate keeps them unchanged.
for (const platform of ["darwin", "linux"]) {
  test(`leaves the sherpa package untouched on ${platform}`, (t) => {
    const name = `sherpa-onnx-${platform}-arm64`;
    const { context, modulesDir } = makeApp(t, {
      platform,
      arch: "arm64",
      sherpaPackages: [name],
      peImages: true,
    });
    const dir = path.join(modulesDir, name);
    const addonBefore = fs.readFileSync(path.join(dir, "sherpa-onnx.node"));

    prepareVoiceDependencies(context);

    assert.deepEqual(fs.readdirSync(dir).sort(), ["onnxruntime.dll", "sherpa-onnx.node"]);
    assert.deepEqual(fs.readFileSync(path.join(dir, "sherpa-onnx.node")), addonBefore);
  });
}

test("drops sherpa-onnx packages the target never loads, keeping both for universal", (t) => {
  const packages = ["sherpa-onnx-darwin-arm64", "sherpa-onnx-darwin-x64", "sherpa-onnx-node"];
  const intel = makeApp(t, { platform: "darwin", arch: "x64", sherpaPackages: packages });
  prepareVoiceDependencies(intel.context);
  assert.deepEqual(
    fs.readdirSync(intel.modulesDir).filter((name) => name.startsWith("sherpa")),
    ["sherpa-onnx-darwin-x64", "sherpa-onnx-node"]
  );

  const universal = makeApp(t, { platform: "darwin", arch: "universal", sherpaPackages: packages });
  prepareVoiceDependencies(universal.context);
  assert.equal(
    fs.readdirSync(universal.modulesDir).filter((name) => name.startsWith("sherpa")).length,
    3
  );
});
