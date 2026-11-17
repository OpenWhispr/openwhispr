const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const vm = require("node:vm");
const { createRequire } = require("node:module");

const sourcePath = require.resolve("../../scripts/download-qdrant");
const requireFromDownloader = createRequire(sourcePath);
const downloadUtils = requireFromDownloader("./lib/download-utils");
const targets = [
  ["linux-x64", "qdrant-x86_64-unknown-linux-gnu.tar.gz", "qdrant-linux-x64"],
  ["darwin-arm64", "qdrant-aarch64-apple-darwin.tar.gz", "qdrant-darwin-arm64"],
  ["darwin-x64", "qdrant-x86_64-apple-darwin.tar.gz", "qdrant-darwin-x64"],
  ["win32-x64", "qdrant-x86_64-pc-windows-msvc.zip", "qdrant-win32-x64.exe"],
];

async function runDownloader(t, { platformArch = "linux-x64", version, all = false } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "qdrant-download-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const processState = { env: version ? { QDRANT_VERSION: version } : {} };
  const lookups = [];
  const downloads = [];
  const messages = [];
  await vm.runInNewContext(fs.readFileSync(sourcePath, "utf8"), {
    __dirname: path.join(root, "scripts"),
    process: processState,
    console: {
      log: (...args) => messages.push(args.join(" ")),
      error: (...args) => messages.push(args.join(" ")),
    },
    require(name) {
      if (name !== "./lib/download-utils") return requireFromDownloader(name);
      return {
        ...downloadUtils,
        async fetchLatestRelease(repo, options = {}) {
          lookups.push({ repo, ...options });
          // Qdrant publishes the release before its platform build jobs attach assets.
          // Prefix selection can also resolve a different patch than an explicit override.
          const tag = options.tag || (options.tagPrefix ? `${options.tagPrefix}0` : "v1.20.2");
          if (tag === "v1.20.2") return { tag, assets: [] };
          if (!["v1.19.2", "v1.19.20", "v1.20.1"].includes(tag)) return null;
          return {
            tag,
            assets: targets.map(([, archiveName]) => ({
              name: archiveName,
              url: `https://github.com/qdrant/qdrant/releases/download/${tag}/${archiveName}`,
            })),
          };
        },
        async downloadFile(url, destination) {
          downloads.push(url);
          fs.writeFileSync(destination, path.basename(destination));
        },
        async extractArchive(archive, destination) {
          const binary = archive.endsWith(".zip") ? "qdrant.exe" : "qdrant";
          fs.writeFileSync(path.join(destination, binary), fs.readFileSync(archive));
        },
        parseArgs: () => ({ platformArch, isCurrent: !all, isAll: all }),
      };
    },
  });
  return {
    binDir: path.join(root, "resources", "bin"),
    processState,
    lookups,
    downloads,
    messages,
  };
}

for (const [platformArch, archiveName, outputName] of targets) {
  test(`${platformArch} installs the pinned release while latest has no assets`, async (t) => {
    const result = await runDownloader(t, { platformArch });
    assert.notEqual(result.processState.exitCode, 1, result.messages.join("\n"));
    assert.equal(fs.readFileSync(path.join(result.binDir, outputName), "utf8"), archiveName);
    assert.equal(
      JSON.parse(fs.readFileSync(path.join(result.binDir, `.qdrant-${platformArch}.json`))).version,
      "v1.20.1"
    );
    assert.deepEqual(result.lookups, [{ repo: "qdrant/qdrant", tag: "v1.20.1" }]);
  });
}

test("all-platform downloads use one complete release for every binary", async (t) => {
  const result = await runDownloader(t, { all: true });
  assert.equal(result.downloads.length, 4);
  assert.equal(result.lookups.length, 1);
  for (const [, archiveName, outputName] of targets) {
    assert.equal(fs.readFileSync(path.join(result.binDir, outputName), "utf8"), archiveName);
  }
});

test("an explicit version downloads that exact tag rather than a matching tag prefix", async (t) => {
  const result = await runDownloader(t, { version: "v1.19.2" });
  assert.notEqual(result.processState.exitCode, 1, result.messages.join("\n"));
  assert.equal(result.downloads.length, 1);
  assert.equal(
    JSON.parse(fs.readFileSync(path.join(result.binDir, ".qdrant-linux-x64.json"))).version,
    "v1.19.2"
  );
  assert.deepEqual(result.lookups, [{ repo: "qdrant/qdrant", tag: "v1.19.2" }]);
});

for (const version of ["v1.20.2", "v0.0.0-missing"]) {
  test(`an unavailable explicit release ${version} fails without selecting another version`, async (t) => {
    const result = await runDownloader(t, { version });
    assert.equal(result.processState.exitCode, 1);
    assert.deepEqual(result.downloads, []);
    assert.equal(result.lookups.length, 1);
  });
}
