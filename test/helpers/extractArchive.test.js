const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");
const os = require("os");
const Module = require("node:module");
const cp = require("child_process");

// Minimal valid zip: single file "test-file.txt" containing "hello from test\n"
const ZIP_FIXTURE_B64 =
  "UEsDBAoAAAAAAEwFr1xBZFoiEAAAABAAAAANABwAdGVzdC1maWxlLnR4dFVUCQADz08G" +
  "as9PBmp1eAsAAQToAwAABOgDAABoZWxsbyBmcm9tIHRlc3QKUEsBAh4DCgAAAAAATAWv" +
  "XEFkWiIQAAAAEAAAAA0AGAAAAAAAAQAAAKSBAAAAAHRlc3QtZmlsZS50eHRVVAUAA89P" +
  "Bmp1eAsAAQToAwAABOgDAABQSwUGAAAAAAEAAQBTAAAAVwAAAAAA";

function makeTmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "extractArchive-test-"));
}

function writeZip(dir, name, buf) {
  const p = path.join(dir, name);
  fs.writeFileSync(p, buf);
  return p;
}

const downloadUtilsPath = require.resolve("../../src/helpers/downloadUtils.js");
const originalLoad = Module._load;

function freshRequire({ runSystemTar } = {}) {
  delete require.cache[downloadUtilsPath];

  Module._load = function loadWithMocks(request, parent, isMain) {
    if (request === "electron") return { net: {} };
    if (request === "./systemTar" && runSystemTar) return { runSystemTar };
    return originalLoad.call(this, request, parent, isMain);
  };

  try {
    return require("../../src/helpers/downloadUtils.js");
  } finally {
    Module._load = originalLoad;
  }
}

async function withModuleMock(requestToMock, mock, callback) {
  Module._load = function loadWithMock(request, parent, isMain) {
    if (request === requestToMock) return mock;
    return originalLoad.call(this, request, parent, isMain);
  };

  try {
    return await callback();
  } finally {
    Module._load = originalLoad;
  }
}

test("extractArchive extracts a zip file on Linux", async () => {
  const tmp = makeTmpDir();
  try {
    const zipPath = writeZip(tmp, "test.zip", Buffer.from(ZIP_FIXTURE_B64, "base64"));
    const dest = path.join(tmp, "out");
    fs.mkdirSync(dest);

    const { extractArchive } = freshRequire();
    await extractArchive(zipPath, dest);

    const content = fs.readFileSync(path.join(dest, "test-file.txt"), "utf8");
    assert.equal(content.trim(), "hello from test");
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test("extractArchive falls back to unzipper when system unzip is unavailable", async () => {
  const origExecFile = cp.execFile;
  cp.execFile = function (cmd, _args, cb) {
    if (cmd === "unzip") {
      const err = new Error("spawn unzip ENOENT");
      err.code = "ENOENT";
      return cb(err);
    }
    return origExecFile.apply(this, arguments);
  };

  const tmp = makeTmpDir();
  try {
    const zipPath = writeZip(tmp, "test.zip", Buffer.from(ZIP_FIXTURE_B64, "base64"));
    const dest = path.join(tmp, "out");
    fs.mkdirSync(dest);

    const { extractArchive } = freshRequire();
    await extractArchive(zipPath, dest);

    const content = fs.readFileSync(path.join(dest, "test-file.txt"), "utf8");
    assert.equal(content.trim(), "hello from test");
  } finally {
    cp.execFile = origExecFile;
    freshRequire();
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test("extractArchive rejects on corrupt zip when both extraction methods fail", async () => {
  const origExecFile = cp.execFile;
  cp.execFile = function (cmd, _args, cb) {
    if (cmd === "unzip") {
      return cb(new Error("spawn unzip ENOENT"));
    }
    return origExecFile.apply(this, arguments);
  };

  const tmp = makeTmpDir();
  try {
    const zipPath = writeZip(tmp, "corrupt.zip", Buffer.from("not a zip file"));
    const dest = path.join(tmp, "out");
    fs.mkdirSync(dest);

    const { extractArchive } = freshRequire();
    await assert.rejects(() => extractArchive(zipPath, dest), {
      message: /[Zz]ip extraction failed/,
    });
  } finally {
    cp.execFile = origExecFile;
    freshRequire();
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test("extractArchive falls back to JS tar when system tar rejects a tar.gz archive", async () => {
  const tarCalls = [];
  const systemTarCalls = [];
  const archivePath = "/cache/model.tar.gz";
  const destDir = "/cache/extract";
  const { extractArchive } = freshRequire({
    runSystemTar: async (...args) => {
      systemTarCalls.push(args);
      throw new Error("tar extraction timed out");
    },
  });

  try {
    await withModuleMock("tar", { x: async (options) => tarCalls.push(options) }, () =>
      extractArchive(archivePath, destDir)
    );
    assert.deepEqual(systemTarCalls, [[archivePath, destDir]]);
    assert.deepEqual(tarCalls, [{ file: archivePath, cwd: destDir }]);
  } finally {
    delete require.cache[downloadUtilsPath];
  }
});

test("extractArchive falls back to PowerShell when Windows tar rejects a zip archive", async () => {
  const originalPlatform = Object.getOwnPropertyDescriptor(process, "platform");
  const originalExecFile = cp.execFile;
  const execCalls = [];
  const systemTarCalls = [];

  Object.defineProperty(process, "platform", { value: "win32" });
  cp.execFile = (command, args, callback) => {
    execCalls.push({ command, args });
    callback(null);
  };

  const archivePath = "C:\\cache\\binary.zip";
  const destDir = "C:\\cache\\extract";
  const { extractArchive } = freshRequire({
    runSystemTar: async (...args) => {
      systemTarCalls.push(args);
      throw new Error("tar extraction timed out");
    },
  });

  try {
    await extractArchive(archivePath, destDir);
    assert.deepEqual(systemTarCalls, [[archivePath, destDir]]);
    assert.deepEqual(execCalls, [
      {
        command: "powershell",
        args: [
          "-NoProfile",
          "-Command",
          "Expand-Archive -Force -Path 'C:\\cache\\binary.zip' -DestinationPath 'C:\\cache\\extract'",
        ],
      },
    ]);
  } finally {
    cp.execFile = originalExecFile;
    Object.defineProperty(process, "platform", originalPlatform);
    delete require.cache[downloadUtilsPath];
  }
});
