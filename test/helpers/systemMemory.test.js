const test = require("node:test");
const assert = require("node:assert");

const {
  parseVmStat,
  parseMemInfo,
  __setProbeForTest,
  __resetForTest,
  availableMemBytes,
} = require("../../src/helpers/systemMemory");

// Real output from an Apple Silicon machine — note the 16384 page size.
const VM_STAT = `Mach Virtual Memory Statistics: (page size of 16384 bytes)
Pages free:                                4123.
Pages active:                            369132.
Pages inactive:                          237456.
Pages speculative:                          988.
Pages throttled:                              0.
Pages wired down:                        311234.
Pages purgeable:                          12000.
"Translation faults":                4044738570.
Pages copy-on-write:                   80121611.
Pages zero filled:                   2001234567.
`;

const MEMINFO = `MemTotal:       32791528 kB
MemFree:         1234567 kB
MemAvailable:   12345678 kB
Buffers:          123456 kB
Cached:          4567890 kB
`;

test("parseVmStat uses the page size from the header, not a hardcoded 4096", () => {
  const bytes = parseVmStat(VM_STAT);
  // free + inactive + speculative, at 16384 bytes/page. Purgeable is deliberately
  // excluded: it overlaps active/inactive and would double-count.
  const expected = (4123 + 237456 + 988) * 16384;
  assert.equal(bytes, expected);
});

test("parseVmStat excludes purgeable so available memory is not overstated", () => {
  const bytes = parseVmStat(VM_STAT);
  const withPurgeable = (4123 + 237456 + 988 + 12000) * 16384;
  assert.ok(bytes < withPurgeable);
});

test("parseVmStat rejects malformed input rather than guessing", () => {
  assert.equal(parseVmStat(""), null);
  assert.equal(parseVmStat("total nonsense"), null);
  assert.equal(parseVmStat(null), null);
  // Header present but no page counts at all.
  assert.equal(parseVmStat("Mach Virtual Memory Statistics: (page size of 16384 bytes)"), null);
});

test("parseVmStat falls back to 4096 when the header omits a page size", () => {
  const noHeader = "Pages free:  100.\nPages inactive:  200.\nPages speculative:  0.\n";
  assert.equal(parseVmStat(noHeader), 300 * 4096);
});

test("parseMemInfo reads MemAvailable, the kernel's own answer", () => {
  assert.equal(parseMemInfo(MEMINFO), 12345678 * 1024);
});

test("parseMemInfo rejects input without MemAvailable", () => {
  assert.equal(parseMemInfo("MemTotal: 100 kB\nMemFree: 50 kB\n"), null);
  assert.equal(parseMemInfo(""), null);
  assert.equal(parseMemInfo(null), null);
});

test("availableMemBytes reports the mechanism it used", async () => {
  __resetForTest();
  __setProbeForTest(async () => ({ bytes: 1234, source: "vm_stat" }));
  const result = await availableMemBytes();
  assert.equal(result.bytes, 1234);
  assert.equal(result.source, "vm_stat");
});

test("a failing probe degrades to os.freemem rather than throwing", async () => {
  __resetForTest();
  __setProbeForTest(async () => {
    throw new Error("vm_stat exploded");
  });
  const result = await availableMemBytes();
  assert.equal(result.source, "os.freemem");
  assert.ok(Number.isFinite(result.bytes));
  assert.ok(result.bytes >= 0);
});

test("a probe returning nothing usable degrades to os.freemem", async () => {
  __resetForTest();
  __setProbeForTest(async () => ({ bytes: null, source: "vm_stat" }));
  const result = await availableMemBytes();
  assert.equal(result.source, "os.freemem");
});

test("the result is cached so a burst of starts cannot spawn a burst of probes", async () => {
  __resetForTest();
  let calls = 0;
  __setProbeForTest(async () => {
    calls++;
    return { bytes: 999, source: "vm_stat" };
  });
  await availableMemBytes();
  await availableMemBytes();
  await availableMemBytes();
  assert.equal(calls, 1);
});

test("concurrent callers share a single in-flight probe", async () => {
  __resetForTest();
  let calls = 0;
  __setProbeForTest(async () => {
    calls++;
    await new Promise((r) => setTimeout(r, 10));
    return { bytes: 42, source: "vm_stat" };
  });
  const [a, b, c] = await Promise.all([
    availableMemBytes(),
    availableMemBytes(),
    availableMemBytes(),
  ]);
  assert.equal(calls, 1);
  assert.equal(a.bytes, 42);
  assert.equal(b.bytes, 42);
  assert.equal(c.bytes, 42);
});
