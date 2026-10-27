const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const {
  readComputerProfile,
  cleanProcessorName,
  parseAppleChip,
  makerModelName,
  clearCache,
} = require("../../src/helpers/computerProfile.js");
const { readActiveGpu } = require("../../src/utils/vulkanDetection.js");

test.beforeEach(() => clearCache());

const GIB = 2 ** 30;

// Fake execFile: answers by command name and counts invocations. A response of
// `{ error }` fails the call, the way a timeout or a missing binary does.
function makeExec(responses = {}) {
  const calls = [];
  const execFileImpl = (file, args, options, callback) => {
    calls.push({ file, args, options });
    const key = path.basename(file).toLowerCase().replace(/\.exe$/, "");
    const missing = Object.assign(new Error("ENOENT"), { code: "ENOENT" });
    const response = responses[key] || { error: missing };
    setImmediate(() => callback(response.error || null, response.stdout || ""));
  };
  return { execFileImpl, calls };
}

function fakeFs(files = {}, dirs = {}) {
  return {
    readFile: async (file) => {
      if (file in files) return files[file];
      throw Object.assign(new Error(`ENOENT ${file}`), { code: "ENOENT" });
    },
    readdir: async (dir) => {
      if (dir in dirs) return dirs[dir];
      throw Object.assign(new Error(`ENOENT ${dir}`), { code: "ENOENT" });
    },
  };
}

const KABY_LAKE = "Intel(R) Core(TM) i7-8550U CPU @ 1.80GHz";

function fakeOs({ totalmem = 16 * GIB, cpuModel = KABY_LAKE } = {}) {
  return { totalmem: () => totalmem, cpus: () => [{ model: cpuModel }] };
}

function baseDeps(overrides = {}) {
  return {
    platform: "linux",
    arch: "x64",
    execFileImpl: makeExec().execFileImpl,
    fs: fakeFs(),
    os: fakeOs(),
    getGPUInfo: async () => ({ gpuDevice: [] }),
    detectNvidiaGpu: async () => ({ hasNvidiaGpu: false }),
    getParakeetCapability: () => ({ supported: true }),
    getPreferredSystemLanguages: () => ["en-US"],
    ...overrides,
  };
}

function macDeps(hardware, { totalmem = 16 * GIB, arch = "arm64", extra = {} } = {}) {
  const stdout = JSON.stringify({ SPHardwareDataType: [hardware] });
  const exec = makeExec({ system_profiler: { stdout } });
  return {
    deps: baseDeps({
      platform: "darwin",
      arch,
      execFileImpl: exec.execFileImpl,
      os: fakeOs({ totalmem, cpuModel: hardware.chip_type || hardware.cpu_type || "" }),
      ...extra,
    }),
    calls: exec.calls,
  };
}

function windowsDeps(hardware, { totalmem = 32 * GIB, cpuModel, extra = {} } = {}) {
  const exec = makeExec({ powershell: { stdout: JSON.stringify(hardware) } });
  return {
    deps: baseDeps({
      platform: "win32",
      execFileImpl: exec.execFileImpl,
      os: fakeOs({ totalmem, cpuModel }),
      ...extra,
    }),
    calls: exec.calls,
  };
}

test("cleans processor names", () => {
  assert.equal(cleanProcessorName("12th Gen Intel(R) Core(TM) i5-1235U"), "Intel Core i5-1235U");
  assert.equal(cleanProcessorName("AMD Ryzen 7 7700 8-Core Processor"), "AMD Ryzen 7 7700");
  assert.equal(
    cleanProcessorName("Intel(R) Core(TM) i7-8550U CPU @ 1.80GHz"),
    "Intel Core i7-8550U"
  );
  assert.equal(cleanProcessorName("Apple M5 Pro"), "Apple M5 Pro");
  assert.equal(cleanProcessorName(undefined), "");
});

test("drops the built-in Radeon from an AMD processor name", () => {
  assert.equal(
    cleanProcessorName("AMD Ryzen 7 7840HS w/ Radeon 780M Graphics"),
    "AMD Ryzen 7 7840HS"
  );
  assert.equal(
    cleanProcessorName("AMD Ryzen 5 5500U with Radeon Graphics"),
    "AMD Ryzen 5 5500U"
  );
});

test("parses Apple chip generation and tier", () => {
  assert.deepEqual(parseAppleChip("Apple M5 Pro"), { generation: 5, tier: "Pro" });
  assert.deepEqual(parseAppleChip("Apple M1"), { generation: 1, tier: "" });
  assert.deepEqual(parseAppleChip("Apple M3 Max"), { generation: 3, tier: "Max" });
  assert.deepEqual(parseAppleChip("Apple M2 Ultra"), { generation: 2, tier: "Ultra" });
  assert.equal(parseAppleChip("Intel Core i7-8550U"), null);
  assert.equal(parseAppleChip(""), null);
  assert.equal(parseAppleChip(undefined), null);
});

test("builds a maker model name", () => {
  assert.equal(makerModelName({ maker: "Dell Inc.", model: "XPS 13 9310" }), "Dell XPS 13 9310");
  assert.equal(
    makerModelName({ maker: "LENOVO", model: "21AH00FKUS", version: "ThinkPad X1 Carbon Gen 10" }),
    "Lenovo ThinkPad X1 Carbon Gen 10"
  );
  assert.equal(
    makerModelName({ maker: "HP", model: "HP EliteBook 840 G8 Notebook PC" }),
    "HP EliteBook 840 G8"
  );
  assert.equal(
    makerModelName({ maker: "ASUSTeK COMPUTER INC.", model: "ROG Strix G15" }),
    "ASUS ROG Strix G15"
  );
  assert.equal(
    makerModelName({ maker: "Hewlett-Packard", model: "HP Pavilion Laptop PC 15" }),
    "HP Pavilion Laptop PC 15"
  );
  assert.equal(
    makerModelName({ maker: "Micro-Star International Co., Ltd.", model: "Katana GF66" }),
    "MSI Katana GF66"
  );
  assert.equal(
    makerModelName({ maker: "Microsoft Corporation", model: "Surface Laptop 4" }),
    "Microsoft Surface Laptop 4"
  );
  assert.equal(
    makerModelName({ maker: "To Be Filled By O.E.M.", model: "To Be Filled By O.E.M." }),
    null
  );
  assert.equal(
    makerModelName({ maker: "System manufacturer", model: "System Product Name" }),
    null
  );
  assert.equal(makerModelName({ maker: "Dell Inc.", model: "Default string" }), null);
  assert.equal(makerModelName({ maker: "", model: "" }), null);
  assert.equal(makerModelName({}), null);
});

test("a Lenovo with no readable version has no usable name", () => {
  assert.equal(makerModelName({ maker: "LENOVO", model: "21AH00FKUS", version: "None" }), null);
  assert.equal(makerModelName({ maker: "LENOVO", model: "21AH00FKUS" }), null);
});

test("firmware placeholders such as System Version never become a name", () => {
  const lenovo = { maker: "LENOVO", model: "21AH00FKUS" };
  assert.equal(makerModelName({ ...lenovo, version: "System Version" }), null);
  assert.equal(makerModelName({ maker: "Acer", model: "System Name" }), null);
  assert.equal(makerModelName({ maker: "Acer", model: "Not Specified" }), null);
  assert.equal(makerModelName({ maker: "O.E.M.", model: "Aspire 5" }), "Aspire 5");
});

test("a plain ASUS maker keeps its capitals", () => {
  assert.equal(makerModelName({ maker: "ASUS", model: "Vivobook 15" }), "ASUS Vivobook 15");
});

test("reads a Mac", async () => {
  const { deps, calls } = macDeps(
    { machine_name: "MacBook Pro", chip_type: "Apple M5 Pro" },
    { totalmem: 48 * GIB }
  );
  const profile = await readComputerProfile(deps);
  assert.equal(profile.platform, "darwin");
  assert.equal(profile.arch, "arm64");
  assert.equal(profile.name, "MacBook Pro");
  assert.equal(profile.formFactor, "laptop");
  assert.equal(profile.processorName, "Apple M5 Pro");
  assert.deepEqual(profile.appleChip, { generation: 5, tier: "Pro" });
  assert.equal(profile.memoryGb, 48);
  assert.equal(profile.graphicsName, null);
  assert.equal(profile.nvidia, null);
  assert.equal(profile.parakeetSupported, true);
  assert.equal(profile.systemLanguage, "en");
  assert.equal(calls.length, 1);
  assert.equal(calls[0].options.timeout, 10000);
});

test("a Mac mini is a desktop and an Apple chip never asks for a graphics name", async () => {
  let gpuAsked = false;
  const { deps } = macDeps(
    { machine_name: "Mac mini", chip_type: "Apple M4" },
    {
      extra: {
        getGPUInfo: async () => {
          gpuAsked = true;
          return { gpuDevice: [] };
        },
      },
    }
  );
  const profile = await readComputerProfile(deps);
  assert.equal(profile.formFactor, "desktop");
  assert.deepEqual(profile.appleChip, { generation: 4, tier: "" });
  assert.equal(profile.graphicsName, null);
  assert.equal(gpuAsked, false);
});

test("an Apple-silicon Mac with an unreadable chip still shows no separate graphics", async () => {
  const { deps } = macDeps(
    { machine_name: "MacBook Air" },
    { extra: { os: fakeOs({ cpuModel: "" }) } }
  );
  const profile = await readComputerProfile(deps);
  assert.equal(profile.appleChip, null);
  assert.equal(profile.graphicsName, null);
  assert.equal(profile.name, "MacBook Air");
});

test("an Intel Mac reads its graphics name through the active GPU", async () => {
  const { deps } = macDeps(
    { machine_name: "MacBook Pro", cpu_type: "Intel Core i7" },
    {
      arch: "x64",
      extra: {
        os: fakeOs({ totalmem: 16 * GIB, cpuModel: "Intel(R) Core(TM) i7-8750H CPU @ 2.20GHz" }),
        getGPUInfo: async () => ({
          auxAttributes: {
            glRenderer:
              "ANGLE (Intel Inc., ANGLE Metal Renderer: Intel(R) UHD Graphics 630, " +
              "Unspecified Version)",
          },
          gpuDevice: [{ vendorId: 0x8086, active: true }],
        }),
      },
    }
  );
  const profile = await readComputerProfile(deps);
  assert.equal(profile.appleChip, null);
  assert.equal(profile.processorName, "Intel Core i7-8750H");
  assert.equal(profile.graphicsName, "Intel UHD Graphics 630");
  assert.equal(profile.nvidia, null);
});

test("reads a Windows laptop with an NVIDIA card", async () => {
  let gpuAsked = false;
  const { deps, calls } = windowsDeps(
    {
      Manufacturer: "Dell Inc.",
      Model: "XPS 15 9520",
      PCSystemType: 2,
      Version: "",
      Batteries: 1,
    },
    {
      cpuModel: "12th Gen Intel(R) Core(TM) i7-12700H",
      extra: {
        detectNvidiaGpu: async () => ({
          hasNvidiaGpu: true,
          gpuName: "NVIDIA GeForce RTX 3050 Ti Laptop GPU",
          vramMb: 8188,
          cudaSupported: true,
        }),
        getGPUInfo: async () => {
          gpuAsked = true;
          return { gpuDevice: [] };
        },
      },
    }
  );
  const profile = await readComputerProfile(deps);
  assert.equal(profile.platform, "win32");
  assert.equal(profile.name, "Dell XPS 15 9520");
  assert.equal(profile.formFactor, "laptop");
  assert.equal(profile.processorName, "Intel Core i7-12700H");
  assert.equal(profile.appleChip, null);
  assert.equal(profile.memoryGb, 32);
  assert.deepEqual(profile.nvidia, { name: "NVIDIA GeForce RTX 3050 Ti Laptop GPU", vramMb: 8188 });
  assert.equal(profile.graphicsName, "NVIDIA GeForce RTX 3050 Ti Laptop GPU");
  assert.equal(gpuAsked, false);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].file, "powershell.exe");
  assert.equal(calls[0].options.timeout, 15000);
  assert.equal(calls[0].options.windowsHide, true);
});

test("an NVIDIA card Windows reports only by name has no memory figure", async () => {
  const { deps } = windowsDeps(
    {
      Manufacturer: "Micro-Star International Co., Ltd.",
      Model: "MS-7D25",
      PCSystemType: 1,
      Batteries: 0,
    },
    {
      extra: {
        detectNvidiaGpu: async () => ({
          hasNvidiaGpu: true,
          gpuName: "NVIDIA GeForce RTX 4070",
          cudaSupported: true,
          detectionSource: "wmi",
        }),
      },
    }
  );
  const profile = await readComputerProfile(deps);
  assert.deepEqual(profile.nvidia, { name: "NVIDIA GeForce RTX 4070", vramMb: null });
  assert.equal(profile.formFactor, "desktop");
});

test("a Windows tower with integrated graphics reads the active GPU name", async () => {
  const { deps } = windowsDeps(
    {
      Manufacturer: "HP",
      Model: "HP ProDesk 400 G7 Small Form Factor PC",
      PCSystemType: 1,
      Batteries: 0,
    },
    {
      cpuModel: "AMD Ryzen 7 7700 8-Core Processor",
      extra: {
        getGPUInfo: async () => ({
          auxAttributes: {
            glRenderer: "ANGLE (AMD, AMD Radeon Graphics Direct3D11 vs_5_0, D3D11)",
          },
          gpuDevice: [{ vendorId: 0x1002, active: true }],
        }),
      },
    }
  );
  const profile = await readComputerProfile(deps);
  assert.equal(profile.processorName, "AMD Ryzen 7 7700");
  assert.equal(profile.nvidia, null);
  assert.equal(profile.graphicsName, "AMD Radeon Graphics");
  assert.equal(profile.formFactor, "desktop");
});

test("a Windows machine with a battery or a mobile chassis type is a laptop", async () => {
  const swift = { Manufacturer: "Acer", Model: "Swift 3" };
  const battery = windowsDeps({ ...swift, PCSystemType: 0, Batteries: 1 });
  assert.equal((await readComputerProfile(battery.deps)).formFactor, "laptop");
  clearCache();
  const mobile = windowsDeps({ ...swift, PCSystemType: 2, Batteries: 0 });
  assert.equal((await readComputerProfile(mobile.deps)).formFactor, "laptop");
});

test("reads a Linux laptop from DMI and the battery directory", async () => {
  const deps = baseDeps({
    fs: fakeFs(
      {
        "/sys/class/dmi/id/sys_vendor": "LENOVO\n",
        "/sys/class/dmi/id/product_name": "21AH00FKUS\n",
        "/sys/class/dmi/id/product_version": "ThinkPad X1 Carbon Gen 10\n",
      },
      { "/sys/class/power_supply": ["AC", "BAT0"] }
    ),
  });
  const profile = await readComputerProfile(deps);
  assert.equal(profile.platform, "linux");
  assert.equal(profile.name, "Lenovo ThinkPad X1 Carbon Gen 10");
  assert.equal(profile.formFactor, "laptop");
});

test("a Linux desktop has no battery and placeholder DMI gives the generic name", async () => {
  const deps = baseDeps({
    fs: fakeFs(
      {
        "/sys/class/dmi/id/sys_vendor": "System manufacturer\n",
        "/sys/class/dmi/id/product_name": "System Product Name\n",
      },
      { "/sys/class/power_supply": ["AC", "ucsi-source-psy-USBC000:001"] }
    ),
  });
  const profile = await readComputerProfile(deps);
  assert.equal(profile.name, null);
  assert.equal(profile.formFactor, "desktop");
});

test("a Linux Mesa renderer drops Mesa and the codename bracket", async () => {
  const renderer =
    "ANGLE (Intel, Mesa Intel(R) UHD Graphics 620 (KBL GT2), " +
    "OpenGL 4.6 (Core Profile) Mesa 23.2.1)";
  const deps = baseDeps({
    getGPUInfo: async () => ({
      auxAttributes: { glRenderer: renderer },
      gpuDevice: [{ vendorId: 0x8086, active: true }],
    }),
  });
  assert.equal((await readComputerProfile(deps)).graphicsName, "Intel UHD Graphics 620");
});

test("rounds 15.7 GiB to 16 GB", async () => {
  const profile = await readComputerProfile(baseDeps({ os: fakeOs({ totalmem: 15.7 * GIB }) }));
  assert.equal(profile.memoryGb, 16);
  clearCache();
  const small = await readComputerProfile(baseDeps({ os: fakeOs({ totalmem: 7.4 * GIB }) }));
  assert.equal(small.memoryGb, 7);
});

test("the system language is the lower-cased base code, with en as the fallback", async () => {
  const read = async (getPreferredSystemLanguages) => {
    clearCache();
    return (await readComputerProfile(baseDeps({ getPreferredSystemLanguages }))).systemLanguage;
  };
  assert.equal(await read(() => ["pt-BR", "en-US"]), "pt");
  assert.equal(await read(() => ["zh-Hant-TW"]), "zh");
  assert.equal(await read(() => ["NB"]), "nb");
  assert.equal(await read(() => ["de_DE"]), "de");
  assert.equal(await read(() => []), "en");
  assert.equal(await read(() => [""]), "en");
  assert.equal(await read(() => undefined), "en");
  assert.equal(
    await read(() => {
      throw new Error("not ready");
    }),
    "en"
  );
});

test("an unsupported macOS reports parakeetSupported false", async () => {
  const { deps } = macDeps(
    { machine_name: "MacBook Air", chip_type: "Apple M1" },
    { extra: { getParakeetCapability: () => ({ supported: false, code: "UNSUPPORTED_OS" }) } }
  );
  assert.equal((await readComputerProfile(deps)).parakeetSupported, false);
});

test("failed reads degrade to nulls", async () => {
  const boom = () => {
    throw new Error("boom");
  };
  const reject = async () => {
    throw new Error("boom");
  };
  const failing = {
    getGPUInfo: reject,
    detectNvidiaGpu: reject,
    getParakeetCapability: boom,
    getPreferredSystemLanguages: boom,
    os: { totalmem: boom, cpus: boom },
    fs: fakeFs(),
  };

  // system_profiler errors (the Intel Mac path also asks Electron for a GPU)
  const mac = await readComputerProfile(
    baseDeps({ ...failing, platform: "darwin", arch: "x64", execFileImpl: makeExec().execFileImpl })
  );
  // PowerShell times out
  clearCache();
  const timedOut = Object.assign(new Error("timed out"), { killed: true, signal: "SIGTERM" });
  const win = await readComputerProfile(
    baseDeps({
      ...failing,
      platform: "win32",
      execFileImpl: makeExec({ powershell: { error: timedOut } }).execFileImpl,
    })
  );
  // /sys unreadable
  clearCache();
  const linux = await readComputerProfile(baseDeps({ ...failing, platform: "linux" }));

  for (const profile of [mac, win, linux]) {
    assert.equal(profile.name, null);
    assert.equal(profile.graphicsName, null);
    assert.equal(profile.nvidia, null);
    assert.equal(profile.appleChip, null);
    assert.equal(profile.formFactor, "desktop");
    assert.equal(profile.processorName, "");
    assert.equal(profile.memoryGb, 0);
    assert.equal(profile.parakeetSupported, false);
    assert.equal(profile.systemLanguage, "en");
  }
  assert.deepEqual(
    [mac.platform, win.platform, linux.platform, mac.arch],
    ["darwin", "win32", "linux", "x64"]
  );
});

test("garbled output from the system tools degrades the same way", async () => {
  const exec = makeExec({
    system_profiler: { stdout: "not json" },
    powershell: { stdout: "{ truncated" },
  });
  for (const platform of ["darwin", "win32"]) {
    clearCache();
    const profile = await readComputerProfile(
      baseDeps({ platform, arch: "x64", execFileImpl: exec.execFileImpl })
    );
    assert.equal(profile.name, null);
    assert.equal(profile.formFactor, "desktop");
  }
});

test("reads once per process", async () => {
  const { deps, calls } = macDeps({ machine_name: "MacBook Pro", chip_type: "Apple M5 Pro" });
  const first = await readComputerProfile(deps);
  const second = await readComputerProfile(deps);
  assert.equal(calls.length, 1);
  assert.equal(first, second);
  clearCache();
  await readComputerProfile(deps);
  assert.equal(calls.length, 2);
});

test("a whole-read failure is not kept for the process", async () => {
  let reads = 0;
  const deps = baseDeps();
  // A getter that throws breaks the whole build, not one field
  Object.defineProperty(deps, "os", {
    get() {
      reads++;
      if (reads === 1) throw new Error("boom");
      return fakeOs();
    },
  });
  const failed = await readComputerProfile(deps);
  assert.equal(failed.memoryGb, 0);
  const retried = await readComputerProfile(deps);
  assert.equal(retried.memoryGb, 16);
});

test("two reads started together share one read", async () => {
  const { deps, calls } = macDeps({ machine_name: "MacBook Pro", chip_type: "Apple M5 Pro" });
  const [a, b] = await Promise.all([readComputerProfile(deps), readComputerProfile(deps)]);
  assert.equal(a, b);
  assert.equal(calls.length, 1);
});

test("readActiveGpu gives the active device with its vendor and name", async () => {
  const gpu = await readActiveGpu({
    getGPUInfo: async () => ({
      auxAttributes: { glRenderer: "ANGLE (Intel, Intel UHD Graphics 620 Direct3D11, D3D11)" },
      gpuDevice: [
        { vendorId: 0x10de, active: false },
        { vendorId: 0x8086, active: true },
      ],
    }),
  });
  assert.deepEqual(gpu, { vendorId: 0x8086, deviceName: "Intel UHD Graphics 620 Direct3D11" });
});

test("readActiveGpu keeps a name that holds its own brackets", async () => {
  const gpu = await readActiveGpu({
    getGPUInfo: async () => ({
      auxAttributes: {
        glRenderer:
          "ANGLE (Intel, Intel(R) UHD Graphics 620 (0x00005917) Direct3D11 vs_5_0 ps_5_0, D3D11)",
      },
      gpuDevice: [{ vendorId: 0x8086, active: true }],
    }),
  });
  assert.equal(gpu.deviceName, "Intel(R) UHD Graphics 620 (0x00005917) Direct3D11 vs_5_0 ps_5_0");
});

test("readActiveGpu falls back to the vendor name and never throws", async () => {
  const vendorOnly = await readActiveGpu({
    getGPUInfo: async () => ({ gpuDevice: [{ vendorId: 0x1002 }] }),
  });
  assert.deepEqual(vendorOnly, { vendorId: 0x1002, deviceName: "AMD" });
  assert.equal(await readActiveGpu({ getGPUInfo: async () => ({ gpuDevice: [] }) }), null);
  assert.equal(await readActiveGpu({ getGPUInfo: async () => ({}) }), null);
  assert.equal(
    await readActiveGpu({
      getGPUInfo: async () => {
        throw new Error("gpu process crashed");
      },
    }),
    null
  );
});

test("the bridge, the handler and the renderer all use one channel", () => {
  const root = path.join(__dirname, "../..");
  const read = (file) => fs.readFileSync(path.join(root, file), "utf8");
  assert.match(
    read("preload.js"),
    /getComputerProfile: \(\) =>\s*ipcRenderer\.invoke\("get-computer-profile"\)/
  );
  assert.match(read("src/helpers/ipcHandlers.js"), /ipcMain\.handle\("get-computer-profile"/);
  assert.match(
    read("src/types/electron.ts"),
    /getComputerProfile: \(\) => Promise<ComputerProfile>/
  );
});
