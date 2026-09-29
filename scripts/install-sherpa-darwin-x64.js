#!/usr/bin/env node
// npm ci on the arm64 macOS runner installs only sherpa-onnx-darwin-arm64, but
// the x64 app loads sherpa-onnx-darwin-x64 (afterPack fails the build without
// it). This unpacks the version package-lock.json pins, once its integrity
// matches, straight into node_modules: the rest of the tree keeps the host
// arch and the lockfile is untouched. Run after `npm ci`, before packaging.
const crypto = require("crypto");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { execFileSync } = require("child_process");

const PACKAGE = "sherpa-onnx-darwin-x64";
const ROOT = path.join(__dirname, "..");

const { version, integrity } = require("../package-lock.json").packages[`node_modules/${PACKAGE}`];
const packDir = fs.mkdtempSync(path.join(os.tmpdir(), `${PACKAGE}-`));
const [{ filename }] = JSON.parse(
  execFileSync("npm", ["pack", `${PACKAGE}@${version}`, "--pack-destination", packDir, "--json"], {
    cwd: ROOT,
    encoding: "utf8",
  })
);
const tarball = path.join(packDir, filename);
const digest = crypto.createHash("sha512").update(fs.readFileSync(tarball)).digest("base64");
if (`sha512-${digest}` !== integrity) {
  console.error(`::error::${PACKAGE}@${version} integrity does not match package-lock.json`);
  process.exit(1);
}

const dest = path.join(ROOT, "node_modules", PACKAGE);
fs.mkdirSync(dest, { recursive: true });
execFileSync("tar", ["-xzf", tarball, "-C", dest, "--strip-components=1"]);
console.log(`Installed ${PACKAGE}@${version} into ${dest}`);
