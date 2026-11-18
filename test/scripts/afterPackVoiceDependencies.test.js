const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { Arch } = require("app-builder-lib");

const { buildPeImage } = require("../helpers/harness/peFixture");
const { listImportedModules } = require("../../scripts/lib/pe-imports");
const { prepareVoiceDependencies, requiredOrtBindings } = require("../../scripts/afterPack");

// Linux/Windows resolve resources to <appOutDir>/resources; macOS to
// <App>.app/Contents/Resources when appOutDir already ends in .app.
function makeApp(
  t,
  { platform, arch, bindings = [], wasm = true, peImages = platform === "win32" }
) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "afterpack-voice-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const appOutDir = platform === "darwin" ? path.join(root, "OpenWhispr.app") : root;
  const resourcesDir =
    platform === "darwin"
      ? path.join(appOutDir, "Contents", "Resources")
      : path.join(appOutDir, "resources");
  const modulesDir = path.join(resourcesDir, "app.asar.unpacked", "node_modules");
  const bindingDir = (name) =>
    path.join(modulesDir, "onnxruntime-node", "bin", "napi-v6", platform, name);
  for (const name of bindings) {
    const dir = bindingDir(name);
    fs.mkdirSync(dir, { recursive: true });
    if (peImages) {
      fs.writeFileSync(
        path.join(dir, "onnxruntime.dll"),
        buildPeImage({ imports: ["KERNEL32.dll"] })
      );
      fs.writeFileSync(
        path.join(dir, "onnxruntime_binding.node"),
        buildPeImage({ imports: ["KERNEL32.dll", "onnxruntime.dll"] })
      );
    } else {
      fs.writeFileSync(path.join(dir, "onnxruntime_binding.node"), "");
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
  return { context, modulesDir, bindingDir };
}

test("maps each target to the native ONNX Runtime binding it loads", () => {
  assert.deepEqual(requiredOrtBindings({ platform: "win32", arch: "x64" }), ["x64"]);
  assert.deepEqual(requiredOrtBindings({ platform: "linux", arch: "arm64" }), ["arm64"]);
  assert.deepEqual(requiredOrtBindings({ platform: "darwin", arch: "arm64" }), ["arm64"]);
  assert.deepEqual(requiredOrtBindings({ platform: "darwin", arch: "universal" }), ["arm64"]);
  // Intel Macs have no binding: their speech models run on the WASM build.
  assert.deepEqual(requiredOrtBindings({ platform: "darwin", arch: "x64" }), []);
});

test("passes when the target binding and the Smart Turn WASM are unpacked", (t) => {
  const { context } = makeApp(t, { platform: "darwin", arch: "arm64", bindings: ["arm64"] });
  assert.doesNotThrow(() => prepareVoiceDependencies(context));
});

test("an Intel Mac build needs only the WASM runtime", (t) => {
  const { context } = makeApp(t, { platform: "darwin", arch: "x64" });
  assert.doesNotThrow(() => prepareVoiceDependencies(context));
});

test("fails a build whose target binding was not unpacked", (t) => {
  const { context } = makeApp(t, { platform: "linux", arch: "x64", bindings: ["arm64"] });
  assert.throws(() => prepareVoiceDependencies(context), /missing onnxruntime_binding\.node/);
});

test("fails when the Smart Turn WASM was not unpacked", (t) => {
  const { context } = makeApp(t, {
    platform: "linux",
    arch: "x64",
    bindings: ["x64"],
    wasm: false,
  });
  assert.throws(() => prepareVoiceDependencies(context), /ort-wasm-simd-threaded\.wasm/);
});

test("fails when the file list dropped the Node entry Smart Turn loads", (t) => {
  const { context, modulesDir } = makeApp(t, {
    platform: "linux",
    arch: "x64",
    bindings: ["x64"],
  });
  fs.rmSync(path.join(modulesDir, "onnxruntime-web", "dist", "ort.node.min.js"));
  assert.throws(() => prepareVoiceDependencies(context), /ort\.node\.min\.js/);
});

test("privatizes ONNX Runtime in the target Windows binding", (t) => {
  const { context, bindingDir } = makeApp(t, { platform: "win32", arch: "x64", bindings: ["x64"] });
  prepareVoiceDependencies(context);

  const target = bindingDir("x64");
  assert.equal(fs.existsSync(path.join(target, "onnxruntime.dll")), false);
  assert.equal(fs.existsSync(path.join(target, "ow-onnxrt.dll")), true);
  assert.deepEqual(
    listImportedModules(fs.readFileSync(path.join(target, "onnxruntime_binding.node"))),
    ["KERNEL32.dll", "ow-onnxrt.dll"]
  );
});

// The fixtures are valid PE images importing onnxruntime.dll, so privatizing
// would succeed here if it ran: only the platform gate keeps them unchanged.
for (const platform of ["darwin", "linux"]) {
  test(`leaves the binding untouched on ${platform}`, (t) => {
    const { context, bindingDir } = makeApp(t, {
      platform,
      arch: "arm64",
      bindings: ["arm64"],
      peImages: true,
    });
    const dir = bindingDir("arm64");
    const addonBefore = fs.readFileSync(path.join(dir, "onnxruntime_binding.node"));

    prepareVoiceDependencies(context);

    assert.deepEqual(fs.readdirSync(dir).sort(), ["onnxruntime.dll", "onnxruntime_binding.node"]);
    assert.deepEqual(fs.readFileSync(path.join(dir, "onnxruntime_binding.node")), addonBefore);
  });
}
