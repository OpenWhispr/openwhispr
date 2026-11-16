const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const vm = require("node:vm");
const { createRequire } = require("node:module");

const { buildMachOImage } = require("../helpers/harness/machoFixture");
const { MACOS_DEPLOYMENT_TARGET, assertRunsOnMacOS } = require("../../scripts/download-llama-server");

function writeImages(t, minimums) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "llama-macho-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return minimums.map((minos, index) => {
    const file = path.join(dir, `lib${index}.dylib`);
    fs.writeFileSync(file, buildMachOImage({ minos }));
    return file;
  });
}

test("accepts builds that run on the deployment target or older", (t) => {
  assert.doesNotThrow(() => assertRunsOnMacOS(writeImages(t, [MACOS_DEPLOYMENT_TARGET, "11.0"])));
});

test("refuses a build for macOS 26, naming the file and the version it needs (#2943)", (t) => {
  const files = writeImages(t, ["13.3", "26.0"]);
  assert.throws(() => assertRunsOnMacOS(files), /lib1\.dylib needs macOS 26\.0/);
});

test("compares versions numerically, not as strings", (t) => {
  assert.throws(() => assertRunsOnMacOS(writeImages(t, ["13.10"])), /needs macOS 13\.10/);
  assert.throws(() => assertRunsOnMacOS(writeImages(t, ["13.3.1"])), /needs macOS 13\.3\.1/);
  assert.doesNotThrow(() => assertRunsOnMacOS(writeImages(t, ["9.0"])));
});

test("a refused macOS build leaves nothing in resources/bin, and other platforms skip the check", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "llama-download-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const binDir = path.join(root, "resources", "bin");
  fs.mkdirSync(binDir, { recursive: true });

  const sourcePath = require.resolve("../../scripts/download-llama-server");
  const requireFromDownloader = createRequire(sourcePath);
  const { downloadBinary, BINARIES } = vm.runInNewContext(
    `${fs.readFileSync(sourcePath, "utf8")}\n({ downloadBinary, BINARIES });`,
    {
      __dirname: path.join(root, "scripts"),
      module: { exports: {} },
      process,
      console,
      require(name) {
        if (name === "./lib/download-utils") {
          // Stub the network and the archive; the check and the copies use the filesystem.
          return {
            ...requireFromDownloader(name),
            async downloadFile(_url, destination) {
              fs.writeFileSync(destination, "fixture archive");
            },
            async extractArchive(archivePath, extractDir) {
              const buildDir = path.join(extractDir, "build", "bin");
              fs.mkdirSync(buildDir, { recursive: true });
              if (archivePath.includes("macos")) {
                fs.writeFileSync(path.join(buildDir, "llama-server"), buildMachOImage());
                fs.writeFileSync(
                  path.join(buildDir, "libggml-metal.dylib"),
                  buildMachOImage({ minos: "26.0" })
                );
              } else {
                fs.writeFileSync(path.join(buildDir, "llama-server"), "linux binary");
                fs.writeFileSync(path.join(buildDir, "libggml.so"), "linux library");
              }
            },
          };
        }
        return requireFromDownloader(name);
      },
    },
    { filename: sourcePath }
  );
  const release = {
    assets: [
      { name: "llama-b12110-bin-macos-arm64.tar.gz", url: "https://example.invalid/macos" },
      { name: "llama-b12110-bin-ubuntu-x64.tar.gz", url: "https://example.invalid/ubuntu" },
    ],
  };

  assert.equal(await downloadBinary("darwin-arm64", BINARIES["darwin-arm64"], release), false);
  assert.deepEqual(fs.readdirSync(binDir), []);

  assert.equal(await downloadBinary("linux-x64-cpu", BINARIES["linux-x64-cpu"], release), true);
  assert.deepEqual(fs.readdirSync(binDir).sort(), ["libggml.so", "llama-server-linux-x64-cpu"]);
});
