const fs = require("fs");
const fsPromises = require("fs").promises;
const os = require("os");
const path = require("path");
const { spawn } = require("child_process");
const debugLogger = require("./debugLogger");
const { getCacheRoot } = require("./modelDirUtils");

// The reference app (qualcomm/ai-hub-apps whisper_windows_py) installs these at
// user scope; OpenWhispr pins them into an app-owned venv instead. 2.7.0 is the
// validated plugin-EP release whose bundled QNN backend loads the current
// AI Hub precompiled exports (see _validate or the sidecar docstring).
const QNN_RUNTIME_PACKAGES = [
  "onnxruntime-qnn==2.7.0",
  "numpy>=1.26,<3",
  "transformers>=4.44,<5",
];

const MIN_PYTHON_VERSION = [3, 11];

const RUNTIME_READY_MARKER = "runtime-ready.json";
const RUNTIME_INSTALLING_MARKER = "runtime-installing.json";

class QualcommRuntimeManager {
  constructor() {
    this.status = "unknown"; // unknown | not_installed | installing | ready | error
    this.error = null;
    this.pythonPath = null;
    this.installProcess = null;
  }

  getRuntimeDir() {
    return path.join(getCacheRoot(), "qualcomm-runtime");
  }

  getVenvPythonPath() {
    return path.join(this.getRuntimeDir(), "venv", "Scripts", "python.exe");
  }

  _markerPath(name) {
    return path.join(this.getRuntimeDir(), name);
  }

  isRuntimeReady() {
    return fs.existsSync(this._markerPath(RUNTIME_READY_MARKER));
  }

  getStatus() {
    return {
      status: this.status,
      error: this.error,
      runtimeDir: this.getRuntimeDir(),
      pythonPath: this.pythonPath,
      ready: this.isRuntimeReady(),
      packages: QNN_RUNTIME_PACKAGES,
    };
  }

  async detectPython() {
    // Explicit override wins, then the launcher and PATH, then the usual
    // per-user and machine installs. Only native ARM64 interpreters qualify:
    // emulated x64 Python cannot reach the NPU (the AI Hub docs call this out).
    const candidates = [
      process.env.OPENWHISPR_QUALCOMM_PYTHON,
      "python.exe",
      "py.exe",
    ];
    const localAppData = process.env.LOCALAPPDATA;
    if (localAppData) {
      try {
        const installs = await fsPromises.readdir(
          path.join(localAppData, "Programs", "Python"),
          { withFileTypes: true }
        );
        for (const entry of installs.filter((e) => e.isDirectory()).reverse()) {
          candidates.push(path.join(localAppData, "Programs", "Python", entry.name, "python.exe"));
        }
      } catch {}
    }
    const programFiles = process.env.ProgramFiles;
    if (programFiles) {
      try {
        const installs = await fsPromises.readdir(programFiles, { withFileTypes: true });
        for (const entry of installs.filter((e) => e.isDirectory() && /^Python3/.test(e.name))) {
          candidates.push(path.join(programFiles, entry.name, "python.exe"));
        }
      } catch {}
    }

    for (const candidate of candidates) {
      if (!candidate) continue;
      const info = await probePython(candidate);
      if (info) {
        debugLogger.info("Qualcomm runtime python detected", { candidate, ...info });
        return { path: candidate, ...info };
      }
    }
    return null;
  }

  async ensureRuntime({ onProgress = null, signal = null } = {}) {
    if (this.isRuntimeReady()) {
      this.status = "ready";
      return { success: true, runtimeDir: this.getRuntimeDir(), alreadyReady: true };
    }

    if (this.installProcess) {
      throw Object.assign(new Error("Qualcomm runtime installation already in progress"), {
        code: "RUNTIME_INSTALL_IN_PROGRESS",
      });
    }

    this.status = "installing";
    this.error = null;
    const abortController = new AbortController();
    this.installProcess = { abort: () => abortController.abort() };
    const runtimeDir = this.getRuntimeDir();
    await fsPromises.mkdir(runtimeDir, { recursive: true });
    await fsPromises
      .writeFile(this._markerPath(RUNTIME_INSTALLING_MARKER), JSON.stringify({ startedAt: Date.now() }))
      .catch(() => {});

    const report = (phase, message) => {
      if (onProgress) onProgress({ phase, message });
    };

    try {
      report("detecting", "Looking for a native ARM64 Python");
      const python = await this.detectPython();
      if (!python) {
        throw Object.assign(
          new Error(
            "No native ARM64 Python 3.11+ found. Install it from python.org (ARM64 installer) and restart the app."
          ),
          { code: "QUALCOMM_PYTHON_MISSING" }
        );
      }
      this.pythonPath = python.path;
      const signal = abortController.signal;

      report("venv", "Creating the NPU runtime environment");
      const venvDir = path.join(runtimeDir, "venv");
      if (!fs.existsSync(this.getVenvPythonPath())) {
        await runPython(python.path, ["-m", "venv", venvDir], { signal });
      }

      report("installing", "Installing the QNN runtime (onnxruntime-qnn, numpy, transformers)");
      await runPython(
        this.getVenvPythonPath(),
        [
          "-m",
          "pip",
          "install",
          "--disable-pip-version-check",
          "--no-input",
          ...QNN_RUNTIME_PACKAGES,
        ],
        {
          signal,
          onStderr: (line) => report("installing", line),
        }
      );

      // The sidecar imports are the real readiness test.
      report("verifying", "Verifying the QNN runtime loads");
      await runPython(
        this.getVenvPythonPath(),
        ["-c", "import onnxruntime, onnxruntime_qnn, numpy, transformers; print('ok')"],
        { signal }
      );

      await fsPromises.writeFile(
        this._markerPath(RUNTIME_READY_MARKER),
        JSON.stringify({
          python: python.path,
          pythonVersion: python.version,
          packages: QNN_RUNTIME_PACKAGES,
          readyAt: Date.now(),
        })
      );
      await fsPromises.unlink(this._markerPath(RUNTIME_INSTALLING_MARKER)).catch(() => {});

      this.status = "ready";
      debugLogger.info("Qualcomm NPU runtime installed", { runtimeDir });
      return { success: true, runtimeDir };
    } catch (error) {
      this.status = error.isAbort ? "not_installed" : "error";
      if (!error.isAbort) this.error = error.message;
      await fsPromises.unlink(this._markerPath(RUNTIME_INSTALLING_MARKER)).catch(() => {});
      throw error;
    } finally {
      this.installProcess = null;
    }
  }

  cancelInstall() {
    if (this.installProcess) {
      this.installProcess.abort();
      return { success: true, message: "Runtime installation cancelled" };
    }
    return { success: false, error: "No runtime installation in progress" };
  }
}

async function probePython(candidate) {
  // `py.exe` needs an explicit minor arg; both are probed with the same command
  // and a 32-bit or emulated interpreter is rejected by its machine string.
  const script = "import platform,sys;print(platform.machine());print('%d.%d'%sys.version_info[:2])";
  try {
    const { stdout } = await runPython(candidate, ["-c", script], { timeout: 20000 });
    // Windows pipes print CRLF; splitting on \n leaves \r on every line.
    const [machine, version] = stdout
      .trim()
      .split(/\r?\n/)
      .map((line) => line.trim());
    if (machine?.toUpperCase() !== "ARM64") return null;
    const [major, minor] = String(version || "").split(".").map(Number);
    if (major < MIN_PYTHON_VERSION[0] || minor < MIN_PYTHON_VERSION[1]) return null;
    return { machine, version: `${major}.${minor}` };
  } catch {
    return null;
  }
}

function runPython(pythonPath, args, { signal = null, timeout = 0, onStdout = null, onStderr = null } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(pythonPath, args, { windowsHide: true });
    let stdout = "";
    let stderr = "";
    let settled = false;
    let timer = null;

    const finish = (error) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      if (error) reject(error);
      else resolve({ code: child.exitCode ?? 0, stdout, stderr });
    };

    if (timeout > 0) {
      timer = setTimeout(() => {
        child.kill();
        finish(new Error(`Python process timed out after ${timeout}ms`));
      }, timeout);
    }

    if (signal) {
      const abort = () => {
        child.kill();
        finish(Object.assign(new Error("Operation cancelled"), { isAbort: true }));
      };
      if (signal.aborted) abort();
      else signal.addEventListener("abort", abort, { once: true });
    }

    child.stdout.on("data", (chunk) => {
      const text = chunk.toString();
      stdout += text;
      if (onStdout) text.split(/\r?\n/).forEach((line) => line && onStdout(line));
    });
    child.stderr.on("data", (chunk) => {
      const text = chunk.toString();
      stderr += text;
      if (onStderr) text.split(/\r?\n/).forEach((line) => line && onStderr(line));
    });
    child.on("error", finish);
    child.on("close", (code) => {
      if (code === 0) finish(null);
      else finish(new Error(`Python exited with code ${code}: ${stderr.slice(-2000) || stdout.slice(-2000)}`));
    });
  });
}

module.exports = {
  QNN_RUNTIME_PACKAGES,
  RUNTIME_READY_MARKER,
  QualcommRuntimeManager,
  probePython,
  runPython,
};
