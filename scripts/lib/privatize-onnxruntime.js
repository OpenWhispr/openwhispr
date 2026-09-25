// Windows can resolve a bare "onnxruntime.dll" import to the older copy in
// System32 (#2054). Renaming the bundled runtime and patching every importer
// makes the name private to us. Same scheme as download-sherpa-onnx.js.
const fs = require("fs");
const path = require("path");
const { listImportedModules, renameImportedModule } = require("./pe-imports");

const UPSTREAM_NAME = "onnxruntime.dll";
const PRIVATE_NAME = "ow-onnxrt.dll";
const isImage = (name) => /\.(dll|node)$/i.test(name);

function privatizeOnnxRuntimeDir(dir) {
  const upstreamPath = path.join(dir, UPSTREAM_NAME);
  if (!fs.existsSync(upstreamPath)) return { renamed: false, patched: [] };
  const patched = [];
  for (const entry of fs.readdirSync(dir)) {
    if (!isImage(entry) || entry.toLowerCase() === UPSTREAM_NAME) continue;
    const file = path.join(dir, entry);
    const image = fs.readFileSync(file);
    if (renameImportedModule(image, UPSTREAM_NAME, PRIVATE_NAME) > 0) {
      fs.writeFileSync(file, image);
      patched.push(entry);
    }
  }
  fs.renameSync(upstreamPath, path.join(dir, PRIVATE_NAME));
  return { renamed: true, patched };
}

function verifyOnnxRuntimePrivatizedDir(dir) {
  for (const entry of fs.readdirSync(dir)) {
    if (!isImage(entry)) continue;
    if (entry.toLowerCase() === UPSTREAM_NAME) {
      throw new Error(`${path.join(dir, entry)} must not ship; it should be ${PRIVATE_NAME}`);
    }
    const imports = listImportedModules(fs.readFileSync(path.join(dir, entry)));
    if (imports.some((name) => name.toLowerCase() === UPSTREAM_NAME)) {
      throw new Error(`${path.join(dir, entry)} still imports ${UPSTREAM_NAME}`);
    }
  }
}

module.exports = { privatizeOnnxRuntimeDir, verifyOnnxRuntimePrivatizedDir };
