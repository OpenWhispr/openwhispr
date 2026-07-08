const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");
const os = require("os");
const cp = require("child_process");

const { buildLinuxWrapperScript } = require("../../scripts/lib/linux-launcher.js");

const isLinux = process.platform === "linux";
const BINARY_NAME = "open-whispr";

function setupLauncher() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "linux-launcher-test-"));
  const appDir = path.join(tmp, "app");
  const stubBin = path.join(tmp, "stub-bin");
  const argsFile = path.join(tmp, "args.txt");
  fs.mkdirSync(appDir);
  fs.mkdirSync(stubBin);

  const wrapperPath = path.join(appDir, BINARY_NAME);
  fs.writeFileSync(wrapperPath, buildLinuxWrapperScript(BINARY_NAME), { mode: 0o755 });

  fs.writeFileSync(
    path.join(appDir, `${BINARY_NAME}-app`),
    `#!/bin/bash\nprintf '%s\\n' "$@" > "${argsFile}"\n`,
    { mode: 0o755 }
  );

  fs.writeFileSync(path.join(stubBin, "unshare"), '#!/bin/bash\nexit "${STUB_UNSHARE_EXIT:-0}"\n', {
    mode: 0o755,
  });

  return { tmp, appDir, stubBin, argsFile, wrapperPath };
}

function runLauncher(ctx, { unshareExit = 0, env = {}, args = [] } = {}) {
  return cp.spawnSync(ctx.wrapperPath, args, {
    encoding: "utf8",
    env: {
      ...process.env,
      PATH: `${ctx.stubBin}:${process.env.PATH}`,
      XDG_SESSION_TYPE: "x11",
      XDG_CONFIG_HOME: path.join(ctx.tmp, "xdg"),
      STUB_UNSHARE_EXIT: String(unshareExit),
      ...env,
    },
  });
}

function launchedArgs(ctx) {
  return fs.readFileSync(ctx.argsFile, "utf8").split("\n").filter(Boolean);
}

test(
  "appends --no-sandbox before user args when chrome-sandbox is not setuid root and the userns probe fails",
  { skip: !isLinux },
  () => {
    const ctx = setupLauncher();
    const res = runLauncher(ctx, { unshareExit: 1, args: ["--user-arg"] });

    assert.equal(res.status, 0, res.stderr);
    assert.match(res.stderr, /--no-sandbox/);
    assert.deepEqual(launchedArgs(ctx), ["--no-sandbox", "--user-arg"]);
  }
);

test("keeps the sandbox when user namespaces are available", { skip: !isLinux }, () => {
  const ctx = setupLauncher();
  const res = runLauncher(ctx, { unshareExit: 0 });

  assert.equal(res.status, 0, res.stderr);
  assert.deepEqual(launchedArgs(ctx), []);
});

test(
  "keeps the sandbox when chrome-sandbox is setuid root even if the userns probe fails",
  { skip: !isLinux },
  () => {
    const ctx = setupLauncher();
    const sandboxPath = path.join(ctx.appDir, "chrome-sandbox");
    fs.writeFileSync(sandboxPath, "#!/bin/bash\n", { mode: 0o755 });
    fs.chmodSync(sandboxPath, 0o4755);
    fs.writeFileSync(path.join(ctx.stubBin, "stat"), "#!/bin/bash\necho 0\n", { mode: 0o755 });

    const res = runLauncher(ctx, { unshareExit: 1 });

    assert.equal(res.status, 0, res.stderr);
    assert.deepEqual(launchedArgs(ctx), []);
  }
);

test("keeps the sandbox when unshare is unavailable", { skip: !isLinux }, () => {
  const ctx = setupLauncher();
  const isolatedBin = path.join(ctx.tmp, "isolated-bin");
  fs.mkdirSync(isolatedBin);
  for (const tool of ["dirname", "readlink", "stat"]) {
    const realPath = cp
      .execFileSync("/bin/bash", ["-c", `command -v ${tool}`], { encoding: "utf8" })
      .trim();
    fs.symlinkSync(realPath, path.join(isolatedBin, tool));
  }

  const res = runLauncher(ctx, { env: { PATH: isolatedBin } });

  assert.equal(res.status, 0, res.stderr);
  assert.deepEqual(launchedArgs(ctx), []);
});

test(
  "orders the XWayland flag, the sandbox fallback, and flags-file entries before user args",
  { skip: !isLinux },
  () => {
    const ctx = setupLauncher();
    const xdgDir = path.join(ctx.tmp, "xdg");
    fs.mkdirSync(xdgDir);
    fs.writeFileSync(path.join(xdgDir, `${BINARY_NAME}-flags.conf`), "# comment\n--from-conf\n");

    const res = runLauncher(ctx, {
      unshareExit: 1,
      env: { XDG_SESSION_TYPE: "wayland" },
      args: ["--user-arg"],
    });

    assert.equal(res.status, 0, res.stderr);
    assert.deepEqual(launchedArgs(ctx), [
      "--ozone-platform=x11",
      "--no-sandbox",
      "--from-conf",
      "--user-arg",
    ]);
  }
);

test("rejects executable names that could break out of the generated script", () => {
  assert.throws(() => buildLinuxWrapperScript('bad"; rm -rf /'), /Invalid Linux executable name/);
  assert.throws(() => buildLinuxWrapperScript("name with spaces"), /Invalid Linux executable name/);
  assert.throws(() => buildLinuxWrapperScript(""), /Invalid Linux executable name/);
  assert.throws(() => buildLinuxWrapperScript(undefined), /Invalid Linux executable name/);
});
