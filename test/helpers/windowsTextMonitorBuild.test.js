const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

test("Windows text monitor builds current source before using a released fallback", () => {
  const source = fs.readFileSync(
    path.join(__dirname, "../../scripts/build-windows-text-monitor.js"),
    "utf8"
  );
  const main = source.slice(source.indexOf("async function main()"));
  const compileIndex = main.indexOf("tryCompile()");
  const downloadIndex = main.indexOf("tryDownload()");

  assert.notEqual(compileIndex, -1, "main() should try local compilation");
  assert.notEqual(downloadIndex, -1, "main() should retain the download fallback");
  assert.ok(compileIndex < downloadIndex, "local compilation should run first");
});
