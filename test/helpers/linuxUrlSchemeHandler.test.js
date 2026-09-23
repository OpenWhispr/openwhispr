const test = require("node:test");
const assert = require("node:assert/strict");
const Module = require("node:module");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const helperPath = require.resolve("../../src/helpers/linuxUrlSchemeHandler");
const originalLoad = Module._load;

// Assigning undefined to process.env coerces to the string "undefined".
const MANAGED_ENV = ["XDG_DATA_HOME", "APPIMAGE", "FLATPAK_ID", "SNAP"];
const HANDLER_FILE = "openwhispr-url-handler.desktop";
const MIME_TYPE = "x-scheme-handler/openwhispr";

function setEnv(name, value) {
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}

function setProcessPath(name, value) {
  Object.defineProperty(process, name, { value, configurable: true, writable: true });
}

// Every test gets a private XDG data home, a packaged-looking execPath and a
// resources dir with no deb/rpm marker, so each case states only what differs.
function withInstall(fn) {
  return async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "openwhispr-url-handler-test-"));
    const saved = Object.fromEntries(MANAGED_ENV.map((name) => [name, process.env[name]]));
    const savedExecPath = process.execPath;
    const savedResourcesPath = process.resourcesPath;
    MANAGED_ENV.forEach((name) => setEnv(name, undefined));
    process.env.XDG_DATA_HOME = path.join(root, "data");
    const resourcesPath = path.join(root, "install", "resources");
    fs.mkdirSync(resourcesPath, { recursive: true });
    setProcessPath("execPath", path.join(root, "install", "open-whispr-app"));
    setProcessPath("resourcesPath", resourcesPath);
    try {
      await fn({ root, resourcesPath, applicationsDir: path.join(root, "data", "applications") });
    } finally {
      MANAGED_ENV.forEach((name) => setEnv(name, saved[name]));
      setProcessPath("execPath", savedExecPath);
      setProcessPath("resourcesPath", savedResourcesPath);
      fs.rmSync(root, { recursive: true, force: true });
    }
  };
}

// Stands in for xdg-utils: it keeps the scheme's default handler, so a query
// answers whatever the last `xdg-mime default` set.
function createXdg({ defaultHandler = "", missing = [], ignoresDefault = false } = {}) {
  const xdg = { calls: [], options: [], defaultHandler, warnings: [] };
  xdg.execFileSync = (command, args, options) => {
    xdg.calls.push([command, args]);
    xdg.options.push(options);
    if (missing.includes(command)) {
      throw Object.assign(new Error(`spawn ${command} ENOENT`), { code: "ENOENT" });
    }
    if (command === "xdg-mime" && args[0] === "query") return `${xdg.defaultHandler}\n`;
    if (command === "xdg-mime" && args[0] === "default" && !ignoresDefault) {
      xdg.defaultHandler = args[1];
    }
    return "";
  };
  return xdg;
}

function loadHelper(xdg) {
  delete require.cache[helperPath];
  Module._load = function loadWithStubs(request, parent, isMain) {
    if (request === "child_process") return { execFileSync: xdg.execFileSync };
    if (request === "./debugLogger") {
      return {
        info() {},
        debug() {},
        warn: (message, meta) => xdg.warnings.push({ message, meta }),
      };
    }
    return originalLoad.call(this, request, parent, isMain);
  };
  try {
    return require(helperPath);
  } finally {
    Module._load = originalLoad;
  }
}

const readHandler = (applicationsDir) =>
  fs.readFileSync(path.join(applicationsDir, HANDLER_FILE), "utf8");

test("the handler entry is hidden and declares only the scheme", () => {
  const { buildHandlerEntry } = loadHelper(createXdg());

  assert.equal(
    buildHandlerEntry("openwhispr", ["/home/user/Apps/OpenWhispr.AppImage"]),
    [
      "[Desktop Entry]",
      "Type=Application",
      "Name=OpenWhispr",
      "Exec=/home/user/Apps/OpenWhispr.AppImage %U",
      "Terminal=false",
      "NoDisplay=true",
      "MimeType=x-scheme-handler/openwhispr;",
      "",
    ].join("\n")
  );
});

// Newer xdg-mime takes the first space-separated word of Exec as the program,
// quotes included, and refuses the entry if it is not executable. So a plain
// path stays bare and only a path the spec says must be quoted gets quotes.
test("Exec quotes only arguments that need it and escapes percent signs", () => {
  const { buildHandlerEntry } = loadHelper(createXdg());
  const execLine = (launchCommand) =>
    buildHandlerEntry("openwhispr", launchCommand).match(/^Exec=(.*)$/m)[1];

  assert.equal(
    execLine(["/home/u/My Apps/OpenWhispr.AppImage"]),
    '"/home/u/My Apps/OpenWhispr.AppImage" %U'
  );
  assert.equal(execLine(["/home/u/100%/OpenWhispr"]), "/home/u/100%%/OpenWhispr %U");
  assert.equal(execLine(['/home/u/"$HOME"/x']), '"/home/u/\\"\\$HOME\\"/x" %U');
  assert.equal(execLine(["/repo/electron", "/repo"]), "/repo/electron /repo %U");
});

test(
  "only AppImage and unpacked runs register themselves",
  withInstall(async ({ resourcesPath }) => {
    const { getLinuxInstallType } = loadHelper(createXdg());

    assert.equal(getLinuxInstallType(), "unpacked");

    process.env.APPIMAGE = "/home/user/OpenWhispr.AppImage";
    assert.equal(getLinuxInstallType(), "appimage");
    setEnv("APPIMAGE", undefined);

    // electron-builder writes this marker into deb and rpm builds only.
    fs.writeFileSync(path.join(resourcesPath, "package-type"), "deb");
    assert.equal(getLinuxInstallType(), "package");
    fs.rmSync(path.join(resourcesPath, "package-type"));

    process.env.FLATPAK_ID = "com.gizmolabs.openwhispr";
    assert.equal(getLinuxInstallType(), "flatpak");
    setEnv("FLATPAK_ID", undefined);

    process.env.SNAP = "/snap/openwhispr/1";
    assert.equal(getLinuxInstallType(), "snap");
    setEnv("SNAP", undefined);

    // The Nix package wraps the AppImage, so APPIMAGE may be set too.
    process.env.APPIMAGE = "/nix/store/abc-openwhispr/OpenWhispr.AppImage";
    setProcessPath("execPath", "/nix/store/abc-openwhispr-extracted/open-whispr-app");
    assert.equal(getLinuxInstallType(), "nix");
  })
);

test(
  "an AppImage writes its handler at the stable AppImage path and makes it the default",
  withInstall(async ({ applicationsDir }) => {
    const xdg = createXdg({ defaultHandler: "open-whispr.desktop" });
    const { registerLinuxUrlSchemeHandler } = loadHelper(xdg);
    process.env.APPIMAGE = "/home/user/Applications/OpenWhispr.AppImage";

    assert.equal(registerLinuxUrlSchemeHandler("openwhispr"), true);

    assert.ok(readHandler(applicationsDir).includes(`\nExec=${process.env.APPIMAGE} %U\n`));
    assert.deepEqual(xdg.calls, [
      ["update-desktop-database", [applicationsDir]],
      ["xdg-mime", ["query", "default", MIME_TYPE]],
      ["xdg-mime", ["default", HANDLER_FILE, MIME_TYPE]],
      ["xdg-mime", ["query", "default", MIME_TYPE]],
    ]);
    assert.ok(xdg.options.every((options) => !options.shell), "xdg tools must run without a shell");
    assert.equal(xdg.defaultHandler, HANDLER_FILE);
  })
);

test(
  "a tar.gz points its handler at the launcher wrapper beside the binary",
  withInstall(async ({ root, applicationsDir }) => {
    const { registerLinuxUrlSchemeHandler } = loadHelper(createXdg());
    fs.writeFileSync(path.join(root, "install", "open-whispr"), "#!/bin/bash\n");

    assert.equal(registerLinuxUrlSchemeHandler("openwhispr"), true);

    const wrapper = path.join(root, "install", "open-whispr");
    assert.ok(readHandler(applicationsDir).includes(`\nExec=${wrapper} %U\n`));
  })
);

test(
  "development and staging get their own handler for their own scheme",
  withInstall(async ({ applicationsDir }) => {
    const xdg = createXdg();
    const { registerLinuxUrlSchemeHandler } = loadHelper(xdg);
    setProcessPath("execPath", "/repo/node_modules/electron/dist/electron");

    assert.equal(registerLinuxUrlSchemeHandler("openwhispr-staging", ["/repo"]), true);

    const entry = fs.readFileSync(
      path.join(applicationsDir, "openwhispr-staging-url-handler.desktop"),
      "utf8"
    );
    assert.match(entry, /^Exec=\/repo\/node_modules\/electron\/dist\/electron \/repo %U$/m);
    assert.match(entry, /^MimeType=x-scheme-handler\/openwhispr-staging;$/m);
    assert.equal(xdg.defaultHandler, "openwhispr-staging-url-handler.desktop");
  })
);

test(
  "a second launch rewrites nothing and only checks the default",
  withInstall(async ({ applicationsDir }) => {
    const xdg = createXdg();
    const { registerLinuxUrlSchemeHandler } = loadHelper(xdg);
    process.env.APPIMAGE = "/home/user/Applications/OpenWhispr.AppImage";
    registerLinuxUrlSchemeHandler("openwhispr");
    const firstEntry = readHandler(applicationsDir);
    xdg.calls.length = 0;

    assert.equal(registerLinuxUrlSchemeHandler("openwhispr"), true);

    assert.deepEqual(xdg.calls, [["xdg-mime", ["query", "default", MIME_TYPE]]]);
    assert.equal(readHandler(applicationsDir), firstEntry);
  })
);

test(
  "moving the AppImage rewrites the handler without re-running xdg-mime default",
  withInstall(async ({ applicationsDir }) => {
    const xdg = createXdg();
    const { registerLinuxUrlSchemeHandler } = loadHelper(xdg);
    process.env.APPIMAGE = "/home/user/Downloads/OpenWhispr.AppImage";
    registerLinuxUrlSchemeHandler("openwhispr");
    xdg.calls.length = 0;

    process.env.APPIMAGE = "/home/user/Applications/OpenWhispr.AppImage";
    assert.equal(registerLinuxUrlSchemeHandler("openwhispr"), true);

    assert.ok(readHandler(applicationsDir).includes(`\nExec=${process.env.APPIMAGE} %U\n`));
    assert.deepEqual(xdg.calls, [
      ["update-desktop-database", [applicationsDir]],
      ["xdg-mime", ["query", "default", MIME_TYPE]],
    ]);
  })
);

test(
  "a deb or rpm install is left entirely to its packaged desktop entry",
  withInstall(async ({ resourcesPath, applicationsDir }) => {
    const xdg = createXdg();
    const { registerLinuxUrlSchemeHandler } = loadHelper(xdg);
    fs.writeFileSync(path.join(resourcesPath, "package-type"), "rpm");

    assert.equal(registerLinuxUrlSchemeHandler("openwhispr"), false);

    assert.deepEqual(xdg.calls, []);
    assert.equal(fs.existsSync(applicationsDir), false);
  })
);

test(
  "a missing update-desktop-database does not stop registration",
  withInstall(async () => {
    const xdg = createXdg({ missing: ["update-desktop-database"] });
    const { registerLinuxUrlSchemeHandler } = loadHelper(xdg);

    assert.equal(registerLinuxUrlSchemeHandler("openwhispr"), true);
    assert.equal(xdg.defaultHandler, HANDLER_FILE);
  })
);

test(
  "without xdg-mime it reports not registered and logs instead of throwing",
  withInstall(async () => {
    const xdg = createXdg({ missing: ["xdg-mime"] });
    const { registerLinuxUrlSchemeHandler } = loadHelper(xdg);

    assert.equal(registerLinuxUrlSchemeHandler("openwhispr"), false);
    assert.equal(xdg.warnings.length, 1);
    assert.match(xdg.warnings[0].meta.error, /ENOENT/);
  })
);

test(
  "an unwritable data directory reports not registered and logs instead of throwing",
  withInstall(async ({ root }) => {
    const xdg = createXdg();
    const { registerLinuxUrlSchemeHandler } = loadHelper(xdg);
    // A file where the directory should be fails the same way a read-only home does.
    fs.writeFileSync(path.join(root, "data"), "");

    assert.equal(registerLinuxUrlSchemeHandler("openwhispr"), false);
    assert.deepEqual(xdg.calls, []);
    assert.equal(xdg.warnings.length, 1);
  })
);

test(
  "a default that will not stick is reported as not registered",
  withInstall(async () => {
    const xdg = createXdg({ defaultHandler: "other.desktop", ignoresDefault: true });
    const { registerLinuxUrlSchemeHandler } = loadHelper(xdg);

    assert.equal(registerLinuxUrlSchemeHandler("openwhispr"), false);
    assert.equal(xdg.warnings.length, 1);
    assert.equal(xdg.warnings[0].meta.handler, "other.desktop");
  })
);
