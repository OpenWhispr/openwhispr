const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const arch = process.env.TARGET_ARCH || process.arch;
const root = path.resolve(__dirname, `../resources/bin/orukeet-${process.platform}-${arch}`);
function inspect(dir) {
  for (const entry of fs.readdirSync(dir)) {
    const file = path.join(dir, entry),
      stat = fs.lstatSync(file);
    if (stat.isSymbolicLink()) {
      assert(fs.existsSync(file), `Broken staged link: ${file}`);
      assert(!path.isAbsolute(fs.readlinkSync(file)), `Nonrelocatable link: ${file}`);
    } else if (stat.isDirectory()) inspect(file);
  }
}
inspect(root);
const receipt = JSON.parse(fs.readFileSync(path.join(root, "runtime.json"), "utf8"));
const devices = receipt.schema_version === 2 ? receipt.devices : [receipt.device];
const checks = [];
for (const device of devices) {
  const dir = receipt.schema_version === 2 ? path.join(root, device) : root;
  const binary = path.join(
    dir,
    "bin",
    process.platform === "win32" ? "orukeet-sidecar.exe" : "orukeet-sidecar"
  );
  assert(fs.existsSync(binary));
  if (receipt.schema_version === 2)
    assert(
      fs.existsSync(
        path.join(
          dir,
          "bin",
          process.platform === "win32" ? "orukeet-device-info.exe" : "orukeet-device-info"
        )
      )
    );
  if (process.platform === "darwin") {
    const result = spawnSync("lipo", ["-archs", binary], { encoding: "utf8" });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout.trim(), arch === "x64" ? "x86_64" : arch);
  }
  if (arch === process.arch) {
    const result = spawnSync(binary, [], { encoding: "utf8", timeout: 15000 });
    assert.ifError(result.error);
    const missingSystemLoader =
      device !== "cpu" &&
      ((process.platform === "linux" &&
        result.status === 127 &&
        /(?:libcuda\.so\.1|libvulkan\.so\.1): cannot open shared object file/.test(
          result.stderr
        )) ||
        (process.platform === "win32" && result.status === 0xc0000135));
    if (missingSystemLoader) {
      // GPU SDKs depend on system GPU loaders/drivers. CPU must still execute
      // on a machine without those DLLs; the app tests this fallback separately.
      checks.push({
        device,
        native_loader_executed: false,
        status: "system-gpu-loader-unavailable",
        exit_status: result.status,
        stderr: result.stderr.trim(),
      });
      continue;
    }
    assert.equal(result.status, 1, result.stderr);
    assert(result.stdout.trim(), `Native loader produced no JSON: ${result.stderr}`);
    assert.equal(JSON.parse(result.stdout.trim()).event, "error");
  }
  checks.push({ device, native_loader_executed: arch === process.arch });
}
console.log(JSON.stringify({ success: true, platform: process.platform, arch, checks }));
