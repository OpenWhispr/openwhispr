// Rebuild path for Electron-ABI native modules (better-sqlite3, ...).
//
// Used by the `postinstall` script and, as the electron-builder `beforePack`
// hook, for packaging (electron-builder.json sets `npmRebuild: false`, so
// electron-builder's own rebuild never runs).
//
// Why not `electron-builder install-app-deps` / `npmRebuild`: node-pty 1.1.0 is
// Node-API (ABI-stable across Node and Electron) and ships prebuilds for
// win32/darwin, but @electron/rebuild only recognises prebuildify and
// prebuild-install layouts, so it recompiles node-pty with node-gyp anyway.
// That needs MSVC with Spectre libs and runs winpty's GetCommitHash.bat, which
// fails when NoDefaultCurrentDirectoryInExePath=1 is set (Claude Code shells
// set it). electron-builder offers no per-module ignore list, so this script
// calls @electron/rebuild directly with one. @electron/rebuild is electron-builder's
// own dependency (pinned by package-lock.json), deliberately not a direct
// devDependency: electron-builder warns on every build when it is one.
//
// Add a module to NODE_API_PREBUILT_MODULES only after confirming that it is
// Node-API and ships (or builds at install time) a binary that loads under
// Electron.

const path = require("path");

const NODE_API_PREBUILT_MODULES = ["node-pty"];

async function rebuildNativeDeps({ appDir, electronVersion, arch, platform }) {
  const { rebuild } = await import("@electron/rebuild");
  await rebuild({
    buildPath: appDir,
    projectRootPath: appDir,
    electronVersion,
    arch,
    platform,
    ignoreModules: NODE_API_PREBUILT_MODULES,
    // Always rebuild: a later `npm rebuild` can swap in a Node-ABI binary while
    // leaving @electron/rebuild's .forge-meta marker, which would skip the module.
    force: true,
    buildFromSource: false,
    mode: "sequential",
    disablePreGypCopy: true,
  });
}

// electron-builder `beforePack`: runs once per target arch, before electron-builder
// would have called its own rebuild and before app files are copied.
exports.default = async function (context) {
  const { Arch } = require("app-builder-lib");
  const { packager, arch, electronPlatformName } = context;
  await rebuildNativeDeps({
    appDir: packager.info.appDir,
    electronVersion: packager.info.framework.version,
    arch: Arch[arch],
    platform: electronPlatformName,
  });
};

exports.rebuildNativeDeps = rebuildNativeDeps;
exports.NODE_API_PREBUILT_MODULES = NODE_API_PREBUILT_MODULES;

if (require.main === module) {
  rebuildNativeDeps({
    appDir: path.resolve(__dirname, ".."),
    electronVersion: require("electron/package.json").version,
    arch: process.arch,
    platform: process.platform,
  }).catch((error) => {
    console.error(error);
    process.exit(1);
  });
}
