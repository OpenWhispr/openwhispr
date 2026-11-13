const fs = require("fs");

// Windows refuses a rename for a moment while antivirus or the search indexer holds a file it
// just saw written, so a rename there is tried again for about half a second in all.
const RENAME_RETRY_DELAYS_MS = [50, 100, 150, 200];
const BUSY_CODES = ["EPERM", "EACCES", "EBUSY"];

function isSameFile(left, right) {
  try {
    const a = fs.statSync(left, { bigint: true });
    const b = fs.statSync(right, { bigint: true });
    return a.ino !== 0n && a.dev === b.dev && a.ino === b.ino;
  } catch {
    return false;
  }
}

function renameWithRetry(from, to) {
  for (const delay of RENAME_RETRY_DELAYS_MS) {
    try {
      return fs.renameSync(from, to);
    } catch (error) {
      if (process.platform !== "win32" || !BUSY_CODES.includes(error.code)) throw error;
      // Only a rename onto another file is final; one changing just the case finds
      // its own file at the new name on a case-insensitive disk.
      if (fs.existsSync(to) && !isSameFile(from, to)) throw error;
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, delay);
    }
  }
  return fs.renameSync(from, to);
}

module.exports = { renameWithRetry };
