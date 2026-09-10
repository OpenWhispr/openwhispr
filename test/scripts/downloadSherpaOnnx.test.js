const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const vm = require("node:vm");
const { createRequire } = require("node:module");

const { listImportedModules } = require("../../scripts/lib/pe-imports");
const { buildPeImage } = require("../helpers/harness/peFixture");
const {
  BINARIES,
  SHERPA_ONNX_VERSION,
  WINDOWS_ONNXRUNTIME_PRIVATE_NAME,
  WINDOWS_ONNXRUNTIME_UPSTREAM_NAME,
  extractTarBz2,
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

// A real, deterministic tar.bz2 containing sherpa-fixture/nested/tokens.txt.
const BZIP2_FIXTURE = Buffer.from(
  "QlpoOTFBWSZTWcjrkBQAAIZfgNqQQAP9AEAAAIB/ad7QCAggAHQaQmp4gTeomjCMZDaoMkgNGgABoGgPnMCiCBG+QQRRzUsRSpCCCEAnU6vjF4NbYtiEQUCGSyC5UXVrxyzeEU/18sO69rZRodrj+ckuqldRtcyf1bjbOD33nz4ahhPLBGufu1kDTQiID+LuSKcKEhkdcgKA",
  "base64"
);

test("Windows runtime extraction reads a real bzip2 archive using bundled dependencies", async (t) => {
  const root = makeBinDir(t);
  const archive = path.join(root, "runtime with spaces.tar.bz2");
  const destination = path.join(root, "nested destination");
  fs.writeFileSync(archive, BZIP2_FIXTURE);
  await extractTarBz2(archive, destination, { platform: "win32" });
  assert.equal(
    fs.readFileSync(path.join(destination, "sherpa-fixture", "nested", "tokens.txt"), "utf8"),
    "Windows bzip2 extraction works.\n"
  );
});

test("Windows runtime extraction rejects a corrupt bzip2 archive", async (t) => {
  const root = makeBinDir(t);
  const archive = path.join(root, "corrupt.tar.bz2");
  fs.writeFileSync(archive, "not a bzip2 archive");
  await assert.rejects(extractTarBz2(archive, path.join(root, "output"), { platform: "win32" }));
});

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

test("a failed automatic Windows repair stays incomplete and retries DLL patching", async (t) => {
  const root = makeBinDir(t);
  const binDir = path.join(root, "resources", "bin");
  fs.mkdirSync(binDir, { recursive: true });
  const config = BINARIES["win32-x64"];
  const binaryPaths = EXE_NAMES.map((name) => path.join(binDir, name));
  const markerPath = path.join(binDir, ".sherpa-onnx-win32-x64.json");
  const options = { platformArch: "win32-x64", binDir };
  const sourcePath = require.resolve("../../scripts/download-sherpa-onnx");
  const requireFromDownloader = createRequire(sourcePath);
  let downloads = 0;
  let failPatch = false;
  let patchFailureInjected = false;

  const downloadBinary = vm.runInNewContext(
    `${fs.readFileSync(sourcePath, "utf8")}\ndownloadBinary;`,
    {
      __dirname: path.join(root, "scripts"),
      module: { exports: {} },
      // This repair test injects a fake native extractor; the real Windows
      // decompressor is exercised above with an actual compressed archive.
      process: { ...process, platform: "linux" },
      console,
      require(name) {
        if (name === "fs") {
          return {
            ...fs,
            writeFileSync(filePath, ...args) {
              if (failPatch && filePath === binaryPaths[1]) {
                patchFailureInjected = true;
                throw Object.assign(new Error("simulated patch write failure"), { code: "EBUSY" });
              }
              return fs.writeFileSync(filePath, ...args);
            },
          };
        }
        if (name === "./lib/download-utils") {
          return {
            ...requireFromDownloader(name),
            async downloadFile(_url, destination) {
              downloads += 1;
              fs.writeFileSync(destination, "fixture archive");
            },
          };
        }
        if (name === "child_process") {
          return {
            execFileSync(command, args, { cwd }) {
              assert.equal(command, "tar");
              const extractDir = path.resolve(cwd, args[args.indexOf("-C") + 1]);
              writeFakeBundle(extractDir);
              [config.binaryPath, config.onlineBinaryPath, config.diarizeBinaryPath].forEach(
                (name, index) => {
                  fs.renameSync(
                    path.join(extractDir, EXE_NAMES[index]),
                    path.join(extractDir, name)
                  );
                }
              );
            },
          };
        }
        return requireFromDownloader(name);
      },
    },
    { filename: sourcePath }
  );

  assert.equal(await downloadBinary("win32-x64", config), true);
  assert.equal(isCompleteInstall(markerPath, binaryPaths, options), true);
  assert.equal(await downloadBinary("win32-x64", config), true);
  assert.equal(downloads, 1);

  fs.unlinkSync(binaryPaths[1]);
  failPatch = true;
  assert.equal(await downloadBinary("win32-x64", config), false);
  assert.equal(patchFailureInjected, true);
  assert.ok(listImportedModules(fs.readFileSync(binaryPaths[1])).includes("onnxruntime.dll"));
  assert.equal(fs.existsSync(path.join(binDir, "onnxruntime.dll")), false);
  assert.equal(fs.existsSync(markerPath), false);
  assert.equal(isCompleteInstall(markerPath, binaryPaths, options), false);

  failPatch = false;
  assert.equal(await downloadBinary("win32-x64", config), true);
  assert.equal(downloads, 3);
  assert.equal(isCompleteInstall(markerPath, binaryPaths, options), true);
  for (const imagePath of [...binaryPaths, path.join(binDir, "sherpa-onnx-c-api.dll")]) {
    const imports = listImportedModules(fs.readFileSync(imagePath));
    assert.ok(imports.includes("ow-onnxrt.dll"), imagePath);
    assert.ok(!imports.some((name) => name.toLowerCase() === "onnxruntime.dll"), imagePath);
  }
});
