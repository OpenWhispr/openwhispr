// electron-builder afterSign hook
//
// Fails a signed Windows build when any .exe, .dll or .node in the app has no
// Authenticode signature. Smart App Control and App Control for Business
// refuse to load an unsigned native module, so one unsigned better_sqlite3.node
// keeps the app from starting. electron-builder signs only the extensions
// `win.signExts` names, and never an extraResources entry whose `from` is a
// single file, so a binary added either way can slip through unsigned. Runs
// after electron-builder signs the app and before it builds the installer, so
// nothing unsigned is published.

const fs = require("fs");
const path = require("path");
const { hasEmbeddedSignature } = require("./lib/pe-imports");

const SIGNED_EXTENSIONS = new Set([".exe", ".dll", ".node"]);
// The PE headers, data directories included, sit well inside the first 64 KB.
const HEADER_BYTES = 64 * 1024;

function readHeaders(filePath) {
  const fd = fs.openSync(filePath, "r");
  try {
    const buffer = Buffer.alloc(HEADER_BYTES);
    const bytesRead = fs.readSync(fd, buffer, 0, HEADER_BYTES, 0);
    return buffer.subarray(0, bytesRead);
  } finally {
    fs.closeSync(fd);
  }
}

function findUnsignedBinaries(appOutDir) {
  return fs
    .readdirSync(appOutDir, { recursive: true, withFileTypes: true })
    .filter(
      (entry) => entry.isFile() && SIGNED_EXTENSIONS.has(path.extname(entry.name).toLowerCase())
    )
    .map((entry) => path.join(entry.parentPath, entry.name))
    .filter((filePath) => !hasEmbeddedSignature(readHeaders(filePath)))
    .map((filePath) => path.relative(appOutDir, filePath))
    .sort();
}

exports.default = async function (context) {
  // The unsigned config (PR CI, local builds) turns forceCodeSigning off.
  if (context.electronPlatformName !== "win32" || !context.packager.forceCodeSigning) return;

  const unsigned = findUnsignedBinaries(context.appOutDir);
  if (unsigned.length > 0) {
    throw new Error(
      `afterSign: Smart App Control and App Control for Business would refuse to load these unsigned Windows binaries — add their extension to win.signExts, or list a single-file extraResources entry by folder:\n  ${unsigned.join("\n  ")}`
    );
  }

  console.log("  afterSign: verified Authenticode signatures on every .exe, .dll and .node");
};

exports.findUnsignedBinaries = findUnsignedBinaries;
