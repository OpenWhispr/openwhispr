const fs = require("node:fs");
const { pipeline } = require("node:stream/promises");

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

async function validateModelArchive(archivePath, expectedRoot, signal) {
  const tar = require("tar");
  const unbzip2 = require("unbzip2-stream");
  let count = 0;
  let size = 0;
  const parser = tar.t({
    strict: true,
    onReadEntry(entry) {
      try {
        assertSafeModelArchiveEntry(entry, expectedRoot);
        count += 1;
        size += entry.size;
        if (count > 100000 || size > 200 * 1024 ** 3)
          throw new Error("Model archive exceeds limits");
      } catch (error) {
        parser.abort(error);
      }
    },
  });
  // Downloads use the shared lightweight cancellation signal. Bridge it to
  // streams so cancelling a large archive also stops decompression promptly.
  const controller = new AbortController();
  const previousAbort = signal?.onAbort;
  const abort = () => controller.abort();
  if (signal) signal.onAbort = abort;
  if (signal?.aborted) abort();
  try {
    await pipeline(fs.createReadStream(archivePath), unbzip2(), parser, {
      signal: controller.signal,
    });
  } catch (error) {
    if (signal?.aborted)
      throw Object.assign(new Error("Archive verification cancelled"), { isAbort: true });
    throw error;
  } finally {
    if (signal?.onAbort === abort) signal.onAbort = previousAbort;
  }
  if (!count) throw new Error("Empty model archive");
}

module.exports = { assertSafeModelArchiveEntry, validateModelArchive };
