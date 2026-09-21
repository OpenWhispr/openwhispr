const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const { deepAssign } = require("builder-util-runtime");
const { getConfig } = require("app-builder-lib/out/util/config/config");
const { WinPackager } = require("app-builder-lib");
const { verifyWindowsTraySigning } = require("../../scripts/afterPack");

const projectDir = path.resolve(__dirname, "../..");
const sourceMetadata = require("../../package.json");
const MARKER = "signed-production-v1";

function makeContext(config, metadata = sourceMetadata, platform = "win32") {
  const appOutDir = path.join(projectDir, "dist", "win-unpacked");
  const packager = {
    info: { metadata: deepAssign({}, metadata, config.extraMetadata) },
    platformSpecificBuildOptions: config.win,
    forceCodeSigning: config.win.forceCodeSigning ?? config.forceCodeSigning ?? false,
    appInfo: { productFilename: "OpenWhispr" },
    shouldSignFile: WinPackager.prototype.shouldSignFile,
  };
  return { appOutDir, electronPlatformName: platform, packager };
}

test("the real signed configuration injects the marker and requires signing", async () => {
  const config = await getConfig(projectDir, "electron-builder.json");
  const context = makeContext(config);
  assert.equal(sourceMetadata.windowsTrayIdentity, undefined);
  assert.equal(context.packager.info.metadata.windowsTrayIdentity, MARKER);
  assert.equal(context.packager.forceCodeSigning, true);
  assert.equal(
    config.win.azureSignOptions.publisherName,
    "CN=Gizmo Labs Inc., O=Gizmo Labs Inc., L=Wilmington, S=Delaware, C=US"
  );
  assert.doesNotThrow(() => verifyWindowsTraySigning(context));
});

test("the real unsigned inheritance clears both the marker and forced signing", async () => {
  const config = await getConfig(projectDir, "electron-builder.unsigned-win.json");
  const context = makeContext(config, { ...sourceMetadata, windowsTrayIdentity: MARKER });
  assert.equal(config.win.azureSignOptions, null);
  assert.equal(context.packager.forceCodeSigning, false);
  assert.equal(context.packager.info.metadata.windowsTrayIdentity, null);
  assert.doesNotThrow(() => verifyWindowsTraySigning(context));
});

test("marked Windows output rejects every executable signing bypass", async () => {
  const base = await getConfig(projectDir, "electron-builder.json");
  for (const win of [
    { forceCodeSigning: false },
    { signExecutable: false },
    { signAndEditExecutable: false },
    { signExts: ["!.exe"] },
  ]) {
    const config = deepAssign({}, base, { win });
    assert.throws(
      () => verifyWindowsTraySigning(makeContext(config)),
      /tray identity requires enforced executable signing/,
      JSON.stringify(win)
    );
  }
});

test("marked Windows output rejects a path-specific main executable exclusion", async () => {
  const base = await getConfig(projectDir, "electron-builder.json");
  const executableSuffix = path.join(path.sep, "OpenWhispr.exe");
  const config = deepAssign({}, base, {
    win: { signExts: [`!${executableSuffix}`] },
  });
  assert.throws(
    () => verifyWindowsTraySigning(makeContext(config)),
    /tray identity requires enforced executable signing/
  );
});

test("a marker in effective source metadata cannot bypass the guard", () => {
  const context = makeContext(
    { win: { forceCodeSigning: false } },
    { windowsTrayIdentity: MARKER }
  );
  assert.throws(
    () => verifyWindowsTraySigning(context),
    /tray identity requires enforced executable signing/
  );
});

test("unmarked Windows output and non-Windows output retain their signing policy", () => {
  const unsigned = { win: { forceCodeSigning: false } };
  assert.doesNotThrow(() => verifyWindowsTraySigning(makeContext(unsigned, {})));
  for (const platform of ["darwin", "linux"]) {
    assert.doesNotThrow(() =>
      verifyWindowsTraySigning(makeContext(unsigned, { windowsTrayIdentity: MARKER }, platform))
    );
  }
});

test("normal positive executable signing patterns remain allowed", async () => {
  const base = await getConfig(projectDir, "electron-builder.json");
  for (const signExts of [[".dll"], [".exe"], ["!.exe", ".exe"]]) {
    const config = deepAssign({}, base, { win: { signExts } });
    assert.doesNotThrow(() => verifyWindowsTraySigning(makeContext(config)));
  }
});

test("a path-specific main executable inclusion overrides a broad exclusion", async () => {
  const base = await getConfig(projectDir, "electron-builder.json");
  const executableSuffix = path.join(path.sep, "OpenWhispr.exe");
  const config = deepAssign({}, base, {
    win: { signExts: ["!.exe", executableSuffix] },
  });
  assert.doesNotThrow(() => verifyWindowsTraySigning(makeContext(config)));
});
