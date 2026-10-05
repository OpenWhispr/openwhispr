const test = require("node:test");
const assert = require("node:assert/strict");

const { buildPeImage } = require("../helpers/harness/peFixture");
const { listImportedModules, renameImportedModule } = require("../../scripts/lib/pe-imports");

test("lists module names from the import directory in table order", () => {
  const image = buildPeImage({ imports: ["KERNEL32.dll", "onnxruntime.dll", "MSVCP140.dll"] });
  assert.deepEqual(listImportedModules(image), ["KERNEL32.dll", "onnxruntime.dll", "MSVCP140.dll"]);
});

test("lists delay-load module names after the static imports", () => {
  const image = buildPeImage({ imports: ["KERNEL32.dll"], delayImports: ["onnxruntime.dll"] });
  assert.deepEqual(listImportedModules(image), ["KERNEL32.dll", "onnxruntime.dll"]);
});

test("an image with no imports lists nothing", () => {
  assert.deepEqual(listImportedModules(buildPeImage()), []);
});

test("rejects a buffer that is not a PE image", () => {
  assert.throws(() => listImportedModules(Buffer.from("not a pe file at all")), /MZ/);
});

test("renames a module in place, NUL-pads the old length and leaves other names alone", () => {
  const image = buildPeImage({ imports: ["KERNEL32.dll", "onnxruntime.dll"] });
  const before = Buffer.from(image);

  const patched = renameImportedModule(image, "onnxruntime.dll", "ow-onnxrt.dll");

  assert.equal(patched, 1);
  assert.deepEqual(listImportedModules(image), ["KERNEL32.dll", "ow-onnxrt.dll"]);
  const nameOffset = before.indexOf(Buffer.from("onnxruntime.dll\0", "ascii"));
  assert.equal(image.toString("ascii", nameOffset, nameOffset + 13), "ow-onnxrt.dll");
  assert.deepEqual([...image.subarray(nameOffset + 13, nameOffset + 16)], [0, 0, 0]);
  // Only the 15 name bytes changed.
  assert.deepEqual(image.subarray(0, nameOffset), before.subarray(0, nameOffset));
  assert.deepEqual(image.subarray(nameOffset + 16), before.subarray(nameOffset + 16));
});

test("matches the module name case-insensitively, as the Windows loader does", () => {
  const image = buildPeImage({ imports: ["ONNXRUNTIME.DLL"] });
  assert.equal(renameImportedModule(image, "onnxruntime.dll", "ow-onnxrt.dll"), 1);
  assert.deepEqual(listImportedModules(image), ["ow-onnxrt.dll"]);
});

test("also renames delay-load references", () => {
  const image = buildPeImage({ delayImports: ["onnxruntime.dll"] });
  assert.equal(renameImportedModule(image, "onnxruntime.dll", "ow-onnxrt.dll"), 1);
  assert.deepEqual(listImportedModules(image), ["ow-onnxrt.dll"]);
});

test("returns 0 and leaves the image untouched when the module is not imported", () => {
  const image = buildPeImage({ imports: ["KERNEL32.dll"] });
  const before = Buffer.from(image);
  assert.equal(renameImportedModule(image, "onnxruntime.dll", "ow-onnxrt.dll"), 0);
  assert.deepEqual(image, before);
});

test("refuses a replacement name longer than the original", () => {
  const image = buildPeImage({ imports: ["onnxruntime.dll"] });
  assert.throws(
    () => renameImportedModule(image, "onnxruntime.dll", "openwhispr-onnxruntime.dll"),
    /longer/
  );
});
