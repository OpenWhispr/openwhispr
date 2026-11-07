const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");

const {
  findAvxInstructions,
  shouldVerifyLinuxSqliteBaseline,
  verifyLinuxSqliteBaseline,
} = require("../../scripts/verify-linux-sqlite");
const { linuxBaselineFlags } = require("../../scripts/lib/linux-baseline-flags");

const skip = process.platform === "win32" ? "fake tools are shell scripts" : false;
const CLEAN_DISASSEMBLY = "   e000:\tendbr64\n   e004:\tcall   1040 <vsnprintf@plt>\n";

// Replaces PATH with fake objdump and qemu-x86_64, so a test controls what the
// disassembly contains and how the emulated process ends.
function fakeTools(t, { disassembly = CLEAN_DISASSEMBLY, qemu = "exit 0" } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "verify-linux-sqlite-"));
  const log = path.join(dir, "qemu.log");
  const write = (name, body) =>
    fs.writeFileSync(path.join(dir, name), `#!/bin/sh\n${body}\n`, { mode: 0o755 });

  fs.writeFileSync(path.join(dir, "disassembly.txt"), disassembly);
  write("objdump", `while read -r line; do echo "$line"; done < "${dir}/disassembly.txt"`);
  if (qemu) write("qemu-x86_64", `echo "$2|$7" >> "${log}"\n${qemu}`);

  const originalPath = process.env.PATH;
  process.env.PATH = dir;
  t.after(() => {
    process.env.PATH = originalPath;
    fs.rmSync(dir, { recursive: true, force: true });
  });

  return {
    calls: () =>
      fs.existsSync(log)
        ? fs
            .readFileSync(log, "utf8")
            .trim()
            .split("\n")
            .map((line) => line.split("|"))
        : [],
  };
}

test("checks every CPU profile and removes each scratch directory", { skip }, (t) => {
  const tools = fakeTools(t);
  verifyLinuxSqliteBaseline("/app", "open-whispr-app");

  const calls = tools.calls();
  assert.deepEqual(
    calls.map(([cpu]) => cpu),
    ["Nehalem", "IvyBridge", "Haswell,-avx2"]
  );
  for (const [, database] of calls) {
    assert.equal(path.basename(database), "Grüße.db");
    assert.equal(fs.existsSync(path.dirname(database)), false);
  }
});

test("rejects AVX2 in the addon before starting qemu", { skip }, (t) => {
  const tools = fakeTools(t, { disassembly: "   e000:\tvpaddd %ymm1,%ymm2,%ymm3\n" });
  assert.throws(() => verifyLinuxSqliteBaseline("/app"), /better_sqlite3\.node.*vpaddd/);
  assert.deepEqual(tools.calls(), []);
});

test("names the CPU and SIGILL when the probe faults", { skip }, (t) => {
  const tools = fakeTools(t, { qemu: "kill -ILL $$" });
  assert.throws(() => verifyLinuxSqliteBaseline("/app"), /failed on Nehalem \(SIGILL\)/);
  assert.equal(tools.calls().length, 1);
});

test("explains that a timeout usually means a fault", { skip }, (t) => {
  fakeTools(t, { qemu: "exec /bin/sleep 30" });
  assert.throws(
    () => verifyLinuxSqliteBaseline("/app", "open-whispr-app", { timeoutMs: 200 }),
    /failed on Nehalem \(ETIMEDOUT\).*qemu can hang after the fault/
  );
});

test("reports a failed assertion in the probe by exit status", { skip }, (t) => {
  fakeTools(t, { qemu: "exit 1" });
  assert.throws(() => verifyLinuxSqliteBaseline("/app"), /failed on Nehalem \(exit 1\)/);
});

test("fails when qemu is not installed", { skip }, (t) => {
  fakeTools(t, { qemu: null });
  assert.throws(() => verifyLinuxSqliteBaseline("/app"), /failed on Nehalem \(ENOENT\)/);
});

test("finds AVX and BMI instructions in GNU and LLVM disassembly only", () => {
  const disassembly = [
    "   e000:\tvzeroupper",
    "   e003:      \tvmovdqu\t(%rax), %ymm0",
    "   e007:\tshlx   %rax,%rbx,%rcx",
    "   e00c:      \tmulxq\t%rax, %rbx, %rcx",
    "   e011:\tvzeroupper",
  ].join("\n");
  assert.deepEqual(findAvxInstructions(disassembly), ["vzeroupper", "vmovdqu", "shlx", "mulxq"]);
  assert.deepEqual(findAvxInstructions(CLEAN_DISASSEMBLY), []);
});

test("only Linux x64 builds are checked", () => {
  const env = { OPENWHISPR_VERIFY_SQLITE_BASELINE: "1", CI: "true" };
  assert.equal(shouldVerifyLinuxSqliteBaseline("linux", "x64", env), true);
  assert.equal(shouldVerifyLinuxSqliteBaseline("linux", "arm64", env), false);
  assert.equal(shouldVerifyLinuxSqliteBaseline("darwin", "x64", env), false);
  assert.equal(shouldVerifyLinuxSqliteBaseline("win32", "x64", env), false);
});

test("CI cannot skip the check by losing or misspelling the variable", () => {
  const message = /OPENWHISPR_VERIFY_SQLITE_BASELINE/;
  assert.throws(() => shouldVerifyLinuxSqliteBaseline("linux", "x64", { CI: "true" }), message);
  assert.throws(
    () =>
      shouldVerifyLinuxSqliteBaseline("linux", "x64", {
        CI: "true",
        OPENWHISPR_VERIFY_SQLITE_BASELINE: "true",
      }),
    message
  );
});

test("the check can be skipped outside CI or explicitly in CI", () => {
  assert.equal(shouldVerifyLinuxSqliteBaseline("linux", "x64", {}), false);
  assert.equal(
    shouldVerifyLinuxSqliteBaseline("linux", "x64", {
      CI: "true",
      OPENWHISPR_VERIFY_SQLITE_BASELINE: "0",
    }),
    false
  );
});

test("Linux helpers target baseline x86-64 only on x64", () => {
  assert.ok(linuxBaselineFlags("x64").includes("-march=x86-64"));
  assert.deepEqual(linuxBaselineFlags("arm64"), []);
});
