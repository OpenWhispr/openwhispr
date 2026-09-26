const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");
const os = require("os");
const cp = require("child_process");

const { buildLinuxWrapperScript } = require("../../scripts/lib/linux-launcher.js");

const isLinux = process.platform === "linux";
const BINARY_NAME = "open-whispr";
const SCALE_FLAG = "--force-device-scale-factor";

// hyprctl output is parsed as text rather than JSON so the launcher does not
// depend on jq, so the stub reproduces its exact shape.
const MONITORS = [
  "Monitor DP-1 (ID 0):",
  "\t3840x2160@60.00000 at 0x0",
  "\tscale: 1.0",
  "\tfocused: no",
  "",
  "Monitor eDP-1 (ID 1):",
  "\t3072x1920@60.00000 at 3840x0",
  "\tscale: 1.6",
  "\tfocused: yes",
  "",
].join("\n");

function setupLauncher({ zeroScaling = "bool: true", monitors = MONITORS, hyprctl = true } = {}) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "linux-launcher-scale-test-"));
  const appDir = path.join(tmp, "app");
  const stubBin = path.join(tmp, "stub-bin");
  const argsFile = path.join(tmp, "args.txt");
  fs.mkdirSync(appDir);
  fs.mkdirSync(stubBin);
  fs.mkdirSync(path.join(tmp, "xdg"));

  const wrapperPath = path.join(appDir, BINARY_NAME);
  fs.writeFileSync(wrapperPath, buildLinuxWrapperScript(BINARY_NAME), { mode: 0o755 });

  fs.writeFileSync(
    path.join(appDir, `${BINARY_NAME}-app`),
    `#!/bin/bash\nprintf '%s\\n' "$@" > "${argsFile}"\n`,
    { mode: 0o755 }
  );

  // The sandbox probe runs first; keep it quiet so only scale flags show up.
  fs.writeFileSync(path.join(stubBin, "unshare"), "#!/bin/bash\nexit 0\n", { mode: 0o755 });

  if (hyprctl) {
    // The fixture goes through a file: printf would not turn the tabs and
    // newlines hyprctl emits back into real characters.
    const monitorsFile = path.join(tmp, "monitors.txt");
    fs.writeFileSync(monitorsFile, monitors);
    const script = [
      "#!/bin/bash",
      `if [ "$1" = "getoption" ]; then printf '%s\\nset: true\\n' ${JSON.stringify(zeroScaling)}; exit 0; fi`,
      `if [ "$1" = "monitors" ]; then cat ${JSON.stringify(monitorsFile)}; exit 0; fi`,
      "exit 1",
    ].join("\n");
    fs.writeFileSync(path.join(stubBin, "hyprctl"), script, { mode: 0o755 });
  }

  return { tmp, stubBin, argsFile, wrapperPath };
}

function runLauncher(ctx, env = {}) {
  cp.spawnSync(ctx.wrapperPath, [], {
    encoding: "utf8",
    env: {
      ...process.env,
      PATH: `${ctx.stubBin}:${process.env.PATH}`,
      XDG_SESSION_TYPE: "wayland",
      XDG_CONFIG_HOME: path.join(ctx.tmp, "xdg"),
      HYPRLAND_INSTANCE_SIGNATURE: "test-sig",
      ...env,
    },
  });
  return fs.readFileSync(ctx.argsFile, "utf8").split("\n").filter(Boolean);
}

function scaleFlags(args) {
  return args.filter((arg) => arg.startsWith(`${SCALE_FLAG}=`));
}

test(
  "forces the focused monitor's scale when the compositor hands XWayland raw pixels",
  { skip: !isLinux },
  () => {
    const args = runLauncher(setupLauncher());

    assert.deepEqual(scaleFlags(args), [`${SCALE_FLAG}=1.6`]);
  }
);

test("leaves a compositor that upscales XWayland alone", { skip: !isLinux }, () => {
  const args = runLauncher(setupLauncher({ zeroScaling: "bool: false" }));

  assert.deepEqual(scaleFlags(args), []);
});

test("does not probe a session that is not Hyprland", { skip: !isLinux }, () => {
  const args = runLauncher(setupLauncher(), { HYPRLAND_INSTANCE_SIGNATURE: "" });

  assert.deepEqual(scaleFlags(args), []);
});

test("does not probe an X11 session", { skip: !isLinux }, () => {
  const args = runLauncher(setupLauncher(), { XDG_SESSION_TYPE: "x11" });

  assert.deepEqual(scaleFlags(args), []);
});

test("survives a session with no hyprctl on PATH", { skip: !isLinux }, () => {
  const args = runLauncher(setupLauncher({ hyprctl: false }));

  assert.deepEqual(scaleFlags(args), []);
});

test("an unscaled display needs no flag", { skip: !isLinux }, () => {
  const monitors = ["Monitor eDP-1 (ID 0):", "\tscale: 1.0", "\tfocused: yes", ""].join("\n");
  const args = runLauncher(setupLauncher({ monitors }));

  assert.deepEqual(scaleFlags(args), []);
});

test("a user flag wins over the probe", { skip: !isLinux }, () => {
  const ctx = setupLauncher();
  fs.writeFileSync(path.join(ctx.tmp, "xdg", `${BINARY_NAME}-flags.conf`), `${SCALE_FLAG}=2\n`);

  assert.deepEqual(scaleFlags(runLauncher(ctx)), [`${SCALE_FLAG}=2`]);
});
