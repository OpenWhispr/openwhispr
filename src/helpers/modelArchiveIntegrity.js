const path = require("node:path");
const { Worker } = require("node:worker_threads");

function assertSafeModelArchiveEntry(entry, expectedRoot) {
  const name = entry.path.replace(/^\.\//, "");
  const parts = name.split("/");
  if (
    !["File", "Directory"].includes(entry.type) ||
    /[\\:\x00-\x1f]/.test(name) ||
    parts[0] !== expectedRoot ||
    parts.some(
      (part) =>
        part === ".." ||
        part === "." ||
        /[. ]$/.test(part) ||
        // Windows cannot create these names, whatever the extension.
        /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\.|$)/i.test(part)
    ) ||
    parts.slice(0, -1).includes("")
  )
    throw new Error("Unsafe model archive entry");
  // Entries that differ only by case overwrite each other on macOS and Windows.
  return name.replace(/\/$/, "").toLowerCase();
}

function runArchiveWorker(task, signal, onProgress) {
  if (signal?.aborted)
    return Promise.reject(
      Object.assign(new Error("Archive verification cancelled"), { isAbort: true })
    );
  return new Promise((resolve, reject) => {
    const worker = new Worker(path.join(__dirname, "../workers/modelArchiveWorker.js"), {
      workerData: task,
      execArgv: [],
    });
    const previousAbort = signal?.onAbort;
    const abort = () => {
      void worker.terminate();
    };
    if (signal) signal.onAbort = abort;
    let completed = false;
    let failure;
    worker.on("message", (result) => {
      if (result.bytesRead !== undefined) return onProgress?.(result.bytesRead);
      completed = result.success === true;
      if (result.error) failure = new Error(result.error);
    });
    worker.once("error", (error) => {
      failure = error;
    });
    // Wait for exit even on cancellation so all archive handles are closed
    // before the caller removes temporary files (particularly on Windows).
    worker.once("exit", (code) => {
      if (signal?.onAbort === abort) signal.onAbort = previousAbort;
      if (signal?.aborted)
        reject(Object.assign(new Error("Archive verification cancelled"), { isAbort: true }));
      else if (failure) reject(failure);
      else if (code !== 0 || !completed)
        reject(new Error(`Model archive worker exited unexpectedly (${code})`));
      else resolve();
    });
  });
}

// Unpacked contents may be at most this many times the declared download size, which
// bounds a decompression bomb by what the catalog said it would be.
const MAX_UNPACK_RATIO = 4;

function validateModelArchive(archivePath, expectedRoot, signal, declaredBytes, onProgress) {
  const maxBytes = declaredBytes > 0 ? declaredBytes * MAX_UNPACK_RATIO : 200 * 1024 ** 3;
  return runArchiveWorker(
    { operation: "validate", archivePath, expectedRoot, maxBytes },
    signal,
    onProgress
  );
}

function extractModelArchive(archivePath, extractDir) {
  return runArchiveWorker({ operation: "extract", archivePath, extractDir });
}

module.exports = { assertSafeModelArchiveEntry, validateModelArchive, extractModelArchive };
