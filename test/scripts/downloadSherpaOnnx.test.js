const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");

const { listImportedModules } = require("../../scripts/lib/pe-imports");
const { buildPeImage } = require("../helpers/harness/peFixture");
const {
  SHERPA_ONNX_VERSION,
  WINDOWS_ONNXRUNTIME_PRIVATE_NAME,
  WINDOWS_ONNXRUNTIME_UPSTREAM_NAME,
  isCompleteInstall,
  privatizeWindowsOnnxRuntime,
} = require("../../scripts/download-sherpa-onnx");

const EXE_NAMES = [
  "sherpa-onnx-ws-win32-x64.exe",
  "sherpa-onnx-online-ws-win32-x64.exe",
  "sherpa-onnx-diarize-win32-x64.exe",
];

function makeBinDir(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "sherpa-win32-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

// Mirrors what the 1.13.4 win-x64-shared-MD-Release archive yields after copying:
// three exes that import onnxruntime.dll, the C API DLL that imports it too
// (upstream spells it in mixed case in some builds), the runtime itself, and
// the providers DLL that does not reference it.
function writeFakeBundle(dir) {
  for (const exe of EXE_NAMES) {
    fs.writeFileSync(
      path.join(dir, exe),
      buildPeImage({ imports: ["KERNEL32.dll", "onnxruntime.dll"] })
    );
  }
  fs.writeFileSync(
    path.join(dir, "sherpa-onnx-c-api.dll"),
    buildPeImage({ imports: ["ONNXRUNTIME.dll", "KERNEL32.dll"] })
  );
  fs.writeFileSync(path.join(dir, "onnxruntime.dll"), buildPeImage({ imports: ["KERNEL32.dll"] }));
  fs.writeFileSync(
    path.join(dir, "onnxruntime_providers_shared.dll"),
    buildPeImage({ imports: ["KERNEL32.dll"] })
  );
  return {
    binaryPaths: EXE_NAMES.map((exe) => path.join(dir, exe)),
    libraryNames: ["sherpa-onnx-c-api.dll", "onnxruntime.dll", "onnxruntime_providers_shared.dll"],
  };
}

test("the private DLL name fits in place of the upstream import string and differs from it", () => {
  assert.ok(
    Buffer.byteLength(WINDOWS_ONNXRUNTIME_PRIVATE_NAME) <=
      Buffer.byteLength(WINDOWS_ONNXRUNTIME_UPSTREAM_NAME)
  );
  assert.notEqual(
    WINDOWS_ONNXRUNTIME_PRIVATE_NAME.toLowerCase(),
    WINDOWS_ONNXRUNTIME_UPSTREAM_NAME.toLowerCase()
  );
});

test("privatizeWindowsOnnxRuntime renames the runtime and repoints every importer", (t) => {
  const dir = makeBinDir(t);
  const { binaryPaths, libraryNames } = writeFakeBundle(dir);
  const providersBefore = fs.readFileSync(path.join(dir, "onnxruntime_providers_shared.dll"));

  const shipped = privatizeWindowsOnnxRuntime({ binDir: dir, binaryPaths, libraryNames });

  assert.deepEqual(shipped, [
    "sherpa-onnx-c-api.dll",
    WINDOWS_ONNXRUNTIME_PRIVATE_NAME,
    "onnxruntime_providers_shared.dll",
  ]);
  assert.equal(fs.existsSync(path.join(dir, "onnxruntime.dll")), false);
  assert.equal(fs.existsSync(path.join(dir, WINDOWS_ONNXRUNTIME_PRIVATE_NAME)), true);
  for (const file of [...binaryPaths, path.join(dir, "sherpa-onnx-c-api.dll")]) {
    const imports = listImportedModules(fs.readFileSync(file));
    assert.ok(
      imports.includes(WINDOWS_ONNXRUNTIME_PRIVATE_NAME),
      `${path.basename(file)}: ${imports}`
    );
    assert.ok(!imports.some((name) => name.toLowerCase() === "onnxruntime.dll"));
  }
  assert.deepEqual(
    fs.readFileSync(path.join(dir, "onnxruntime_providers_shared.dll")),
    providersBefore
  );
});

// sherpa's Windows CI copies every DLL into both bin/ and lib/ of the archive,
// so findLibrariesInDir reports each one twice while they land on one file each.
test("privatizeWindowsOnnxRuntime tolerates the archive shipping each DLL twice", (t) => {
  const dir = makeBinDir(t);
  const { binaryPaths, libraryNames } = writeFakeBundle(dir);

  const shipped = privatizeWindowsOnnxRuntime({
    binDir: dir,
    binaryPaths,
    libraryNames: [...libraryNames, ...libraryNames],
  });

  assert.deepEqual(shipped, [
    "sherpa-onnx-c-api.dll",
    WINDOWS_ONNXRUNTIME_PRIVATE_NAME,
    "onnxruntime_providers_shared.dll",
  ]);
  for (const name of shipped) {
    assert.ok(fs.existsSync(path.join(dir, name)), `${name} missing`);
  }
});

test("privatizeWindowsOnnxRuntime fails loudly when the archive no longer ships onnxruntime.dll", (t) => {
  const dir = makeBinDir(t);
  const { binaryPaths } = writeFakeBundle(dir);
  assert.throws(
    () =>
      privatizeWindowsOnnxRuntime({
        binDir: dir,
        binaryPaths,
        libraryNames: ["sherpa-onnx-c-api.dll"],
      }),
    /onnxruntime\.dll not found/
  );
});

test("a win32 marker written before the rename is not a complete install", (t) => {
  const dir = makeBinDir(t);
  const exe = path.join(dir, "sherpa-onnx-ws-win32-x64.exe");
  fs.writeFileSync(exe, buildPeImage({ imports: [WINDOWS_ONNXRUNTIME_PRIVATE_NAME] }));
  fs.writeFileSync(path.join(dir, WINDOWS_ONNXRUNTIME_PRIVATE_NAME), buildPeImage());
  const marker = path.join(dir, ".sherpa-onnx-win32-x64.json");
  const options = { platformArch: "win32-x64", binDir: dir };

  fs.writeFileSync(
    marker,
    JSON.stringify({ version: SHERPA_ONNX_VERSION, libraries: [WINDOWS_ONNXRUNTIME_PRIVATE_NAME] })
  );
  assert.equal(isCompleteInstall(marker, [exe], options), false);

  fs.writeFileSync(
    marker,
    JSON.stringify({
      version: SHERPA_ONNX_VERSION,
      libraries: [WINDOWS_ONNXRUNTIME_PRIVATE_NAME],
      onnxRuntime: WINDOWS_ONNXRUNTIME_PRIVATE_NAME,
    })
  );
  assert.equal(isCompleteInstall(marker, [exe], options), true);
});

test("non-Windows markers do not need the onnxRuntime field", (t) => {
  const dir = makeBinDir(t);
  const binary = path.join(dir, "sherpa-onnx-ws-darwin-arm64");
  fs.writeFileSync(binary, "");
  const marker = path.join(dir, ".sherpa-onnx-darwin-arm64.json");
  fs.writeFileSync(marker, JSON.stringify({ version: SHERPA_ONNX_VERSION, libraries: [] }));
  assert.equal(
    isCompleteInstall(marker, [binary], { platformArch: "darwin-arm64", binDir: dir }),
    true
  );
});
