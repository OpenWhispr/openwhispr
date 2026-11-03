const path = require("node:path");
const { Worker } = require("node:worker_threads");

function assertSafeModelArchiveEntry(entry, expectedRoot) {
  const name = entry.path.replace(/^\.\//, "");
  const parts = name.split("/");
  if (
    !["File", "Directory"].includes(entry.type) ||
    /[\\:\x00-\x1f]/.test(name) ||
    parts[0] !== expectedRoot ||
    parts.some((part) => part === ".." || part === "." || /[. ]$/.test(part)) ||
    parts.slice(0, -1).includes("")
  )
    throw new Error("Unsafe model archive entry");
}

function runArchiveWorker(task, signal) {
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
    worker.once("message", (result) => {
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

function validateModelArchive(archivePath, expectedRoot, signal) {
  return runArchiveWorker({ operation: "validate", archivePath, expectedRoot }, signal);
}

function extractModelArchive(archivePath, extractDir) {
  return runArchiveWorker({ operation: "extract", archivePath, extractDir });
}

module.exports = { assertSafeModelArchiveEntry, validateModelArchive, extractModelArchive };
