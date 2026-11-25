const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

const SCRIPT = path.join(__dirname, "../../resources/linux-text-monitor.py");

// A gi stub whose Atspi.init() reports the environment libatspi would read, and
// whose desktop has no applications.
const GI_REPOSITORY_STUB = `import os


class _Desktop:
    def get_child_count(self):
        return 0


class Atspi:
    @staticmethod
    def init():
        print("INIT ATSPI_DISABLE_P2P=" + os.environ.get("ATSPI_DISABLE_P2P", ""), flush=True)
        return 0

    @staticmethod
    def set_timeout(timeout, startup_timeout):
        pass

    @staticmethod
    def get_desktop(index):
        return _Desktop()


class GLib:
    pass
`;

function writeGiStub(directory) {
  fs.mkdirSync(path.join(directory, "gi", "repository"), { recursive: true });
  fs.writeFileSync(
    path.join(directory, "gi", "__init__.py"),
    "def require_version(name, version):\n    pass\n"
  );
  fs.writeFileSync(path.join(directory, "gi", "repository", "__init__.py"), GI_REPOSITORY_STUB);
}

for (const [mode, args] of [
  ["monitor", []],
  ["editable probe", ["--probe-editable", "1234"]],
]) {
  test(
    `Python text monitor ${mode} sets ATSPI_DISABLE_P2P=1 before Atspi.init() runs`,
    { skip: process.platform === "win32" },
    (t) => {
      const directory = fs.mkdtempSync(path.join(os.tmpdir(), "openwhispr-text-monitor-py-"));
      t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
      writeGiStub(directory);
      const env = { ...process.env, PYTHONPATH: directory, PYTHONDONTWRITEBYTECODE: "1" };
      delete env.ATSPI_DISABLE_P2P;

      const result = spawnSync("python3", [SCRIPT, ...args], {
        encoding: "utf8",
        env,
        input: "",
        timeout: 10_000,
      });
      if (result.error?.code === "ENOENT") {
        t.skip("python3 unavailable");
        return;
      }
      assert.ifError(result.error);
      assert.equal(result.stderr, "");
      assert.equal(result.stdout, "INIT ATSPI_DISABLE_P2P=1\nNO_ELEMENT\n");
      assert.equal(result.status, 1);
    }
  );
}
