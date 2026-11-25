const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { VmManager } = require("app-builder-lib/out/vm/vm");

const config = require("../../electron-builder.json");
const afterSign = require("../../scripts/afterSign").default;
const { buildPeImage } = require("../helpers/harness/peFixture");

const appPublisher = config.win.azureSignOptions.publisherName;
const microsoft =
  "CN=Microsoft Corporation, O=Microsoft Corporation, L=Redmond, S=Washington, C=US";

function buildContext(results, { platform = "win32", forceCodeSigning = true } = {}) {
  const signed = [];
  const commands = [];
  const context = {
    electronPlatformName: platform,
    appOutDir: path.resolve("fixture's unpacked app"),
    packager: {
      forceCodeSigning,
      platformSpecificBuildOptions: config.win,
      vm: {
        value: Promise.resolve({
          powershellCommand: { value: Promise.resolve("powershell.exe") },
          exec: async (_file, args) => {
            commands.push(args.at(-1));
            return JSON.stringify(results);
          },
          toVmFile: (file) => file,
        }),
      },
      signIf: async (file) => {
        signed.push(path.relative(context.appOutDir, file));
        return true;
      },
    },
  };
  return { context, signed, commands };
}

test("signs unsigned native modules and preserves valid Microsoft signatures", async () => {
  const { signWindowsNativeModules } = require("../../scripts/lib/windows-signatures");
  const { context, signed, commands } = buildContext([
    { file: "resources\\app.asar.unpacked\\better_sqlite3.node", error: "No signature found" },
    { file: "resources\\bin\\ow-onnxrt.dll", error: "Hash mismatch" },
    { file: "DirectML.dll", publisher: microsoft },
    {
      file: "d3dcompiler_47.dll",
      publisher: microsoft.replace("CN=Microsoft Corporation", "CN=Microsoft Windows"),
    },
    { file: "resources\\bin\\already-signed.dll", publisher: appPublisher },
    { file: "resources\\bin\\other.dll", publisher: "CN=Other Publisher, O=Other Publisher, C=US" },
  ]);

  await signWindowsNativeModules(context);

  assert.deepEqual(signed, [
    path.join("resources", "app.asar.unpacked", "better_sqlite3.node"),
    path.join("resources", "bin", "ow-onnxrt.dll"),
    path.join("resources", "bin", "other.dll"),
  ]);
  assert.match(commands[0], /fixture''s unpacked app/);
  assert.match(commands[0], /\$extensions = '\.dll', '\.node'/);
  assert.equal(config.win.signExts, undefined);
});

test("rejects final binaries with invalid signatures, timestamp warnings, or unexpected publishers", async () => {
  const { context } = buildContext([
    { file: "OpenWhispr.exe", publisher: appPublisher },
    { file: "resources\\bin\\DirectML.DLL", publisher: microsoft },
    { file: "resources\\bad.node", error: "Invalid signature" },
    { file: "resources\\no-timestamp.dll", error: "File is not timestamped" },
    { file: "resources\\wrong.exe", publisher: "CN=Other Publisher" },
  ]);

  await assert.rejects(
    afterSign(context),
    /bad\.node: Invalid signature[\s\S]*no-timestamp\.dll: File is not timestamped[\s\S]*wrong\.exe: unexpected publisher/
  );
});

test("accepts verified release and approved vendor signatures", async () => {
  const { context } = buildContext([
    {
      file: "OpenWhispr.exe",
      publisher: "C=US, ST=Delaware, L=Wilmington, O=Gizmo Labs Inc., CN=Gizmo Labs Inc.",
    },
    { file: "resources\\bin\\DirectML.DLL", publisher: microsoft },
  ]);
  await assert.doesNotReject(afterSign(context));
});

test("signed builds reject an empty signature report", async () => {
  const { context } = buildContext([]);
  await assert.rejects(afterSign(context), /no Windows binaries/i);
});

test("skips unsigned Windows builds and other platforms", async () => {
  const { signWindowsNativeModules } = require("../../scripts/lib/windows-signatures");
  for (const options of [
    { forceCodeSigning: false },
    { platform: "darwin" },
    { platform: "linux" },
  ]) {
    const { context, commands } = buildContext([], options);
    await signWindowsNativeModules(context);
    await afterSign(context);
    assert.deepEqual(commands, []);
  }
});

test("packaging does not distribute or download NirCmd", () => {
  const pkg = require("../../package.json");
  assert.doesNotMatch(JSON.stringify(config), /nircmd/i);
  assert.doesNotMatch(pkg.scripts["prebuild:win"], /nircmd/i);
});

test(
  "Windows SignTool verifies the vendor addon and rejects unsigned or modified files",
  {
    skip: process.platform !== "win32",
  },
  async (t) => {
    const { inspectWindowsSignatures } = require("../../scripts/lib/windows-signatures");
    const appOutDir = fs.mkdtempSync(path.join(os.tmpdir(), "openwhispr-signatures-"));
    t.after(() => fs.rmSync(appOutDir, { recursive: true, force: true }));
    const addon = path.join(
      __dirname,
      "../../node_modules/onnxruntime-node/bin/napi-v6/win32/x64/onnxruntime_binding.node"
    );
    const signedFile = path.join(appOutDir, "ONNX provider's addon.node");
    fs.copyFileSync(addon, signedFile);
    fs.writeFileSync(path.join(appOutDir, "unsigned.dll"), buildPeImage());
    const modified = fs.readFileSync(signedFile);
    const coffHeader = modified.readUInt32LE(0x3c) + 4;
    const firstSection = coffHeader + 20 + modified.readUInt16LE(coffHeader + 16);
    modified[modified.readUInt32LE(firstSection + 20)] ^= 1;
    fs.writeFileSync(path.join(appOutDir, "modified.node"), modified);

    const report = await inspectWindowsSignatures({
      appOutDir,
      packager: { vm: { value: Promise.resolve(new VmManager()) } },
    });

    assert.match(
      report.find(({ file }) => file === path.basename(signedFile)).publisher,
      /CN=Microsoft Corporation/
    );
    assert.ok(report.find(({ file }) => file === "unsigned.dll").error);
    assert.ok(report.find(({ file }) => file === "modified.node").error);
  }
);
