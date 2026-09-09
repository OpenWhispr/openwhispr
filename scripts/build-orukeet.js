#!/usr/bin/env node
// Build-time only: pin the SDK, then compile the small persistent C ABI worker.
// Runtime use requires neither a compiler nor Python.
const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");
const crypto = require("node:crypto");
const { execFileSync } = require("node:child_process");
const { downloadFile } = require("./lib/download-utils");
const source = path.resolve(__dirname, "../resources/orukeet");
const catalog = require("../resources/orukeet/native-runtimes.json");
const { platformTag, buildDevices } = require("../src/helpers/orukeetRuntime");

async function main() {
  const arch = process.env.TARGET_ARCH || process.arch;
  if (process.platform === "win32" && arch !== "x64")
    throw new Error("No pinned Windows ARM64 Orukeet SDK");
  if (arch !== process.arch && process.platform !== "darwin")
    throw new Error("Orukeet cross-compilation is supported only on macOS");
  const requested = process.env.OPENWHISPR_ORUKEET_BUILD_DEVICE || "auto";
  const devices = buildDevices(catalog, process.platform, arch, requested);
  const platform = platformTag(process.platform, arch);
  const target = path.resolve(__dirname, `../resources/bin/orukeet-${process.platform}-${arch}`);
  const fingerprint = crypto.createHash("sha256");
  fingerprint.update(JSON.stringify({ platform, arch, devices, catalog }));
  for (const file of [
    __filename,
    path.join(source, "CMakeLists.txt"),
    path.join(source, "sidecar.cpp"),
    path.join(source, "third_party/cjson/cJSON.c"),
    path.join(source, "third_party/cjson/cJSON.h"),
  ])
    fingerprint.update(fs.readFileSync(file));
  const buildFingerprint = fingerprint.digest("hex");
  const receiptPath = path.join(target, "runtime.json");
  if (fs.existsSync(receiptPath)) {
    const previous = JSON.parse(fs.readFileSync(receiptPath, "utf8"));
    const exe = process.platform === "win32" ? "orukeet-sidecar.exe" : "orukeet-sidecar";
    const probe = process.platform === "win32" ? "orukeet-device-info.exe" : "orukeet-device-info";
    if (
      previous.build_fingerprint === buildFingerprint &&
      devices.every(
        (device) =>
          fs.existsSync(path.join(target, device, "bin", exe)) &&
          fs.existsSync(path.join(target, device, "bin", probe))
      )
    ) {
      console.log(`Orukeet runtimes already built: ${devices.join(", ")}`);
      return;
    }
  }
  const work = fs.mkdtempSync(path.join(os.tmpdir(), "orukeet-build-"));
  const run = (command, args) => execFileSync(command, args, { stdio: "inherit" });
  try {
    const bundle = path.join(work, "bundle");
    fs.mkdirSync(bundle);
    for (const device of devices) {
      const spec = catalog[`asr-nvidia-${device}`].platforms[platform];
      const unpack = path.join(work, `sdk-${device}`);
      fs.mkdirSync(unpack);
      for (const artifact of spec.archives) {
        const archive = path.join(work, artifact.name);
        await downloadFile(artifact.url, archive);
        const hash = crypto.createHash("sha256");
        for await (const chunk of fs.createReadStream(archive)) hash.update(chunk);
        if (
          hash.digest("hex") !== artifact.sha256 ||
          fs.statSync(archive).size !== artifact.size_bytes
        )
          throw new Error("Orukeet SDK integrity check failed");
        run("tar", ["-xf", archive, "-C", unpack]);
      }
      const roots = fs.readdirSync(unpack).map((name) => path.join(unpack, name));
      const sdk = roots.length === 1 && fs.statSync(roots[0]).isDirectory() ? roots[0] : unpack;
      const build = path.join(work, `build-${device}`),
        stage = path.join(bundle, device);
      run("cmake", [
        "-S",
        source,
        "-B",
        build,
        `-DORUKEET_SDK_ROOT=${sdk}`,
        "-DCMAKE_BUILD_TYPE=Release",
        ...(process.platform === "darwin"
          ? [`-DCMAKE_OSX_ARCHITECTURES=${arch === "x64" ? "x86_64" : arch}`]
          : []),
      ]);
      run("cmake", ["--build", build, "--config", "Release", "--parallel", "4"]);
      run("cmake", ["--install", build, "--config", "Release", "--prefix", stage]);
      fs.writeFileSync(
        path.join(stage, "runtime.json"),
        JSON.stringify({ device, spec }, null, 2) + "\n"
      );
    }
    fs.writeFileSync(
      path.join(bundle, "runtime.json"),
      JSON.stringify(
        { schema_version: 2, devices, platform, arch, build_fingerprint: buildFingerprint },
        null,
        2
      ) + "\n"
    );
    fs.mkdirSync(path.dirname(target), { recursive: true });
    // Build completes before replacing an existing staged runtime.
    fs.rmSync(target, { recursive: true, force: true });
    fs.cpSync(bundle, target, { recursive: true, dereference: false, verbatimSymlinks: true });
    console.log(`Orukeet ${devices.join(", ")} runtimes staged at ${target}`);
  } finally {
    fs.rmSync(work, { recursive: true, force: true });
  }
}
if (require.main === module)
  main().catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
module.exports = { main };
