const fs = require("node:fs");
const { pipeline } = require("node:stream/promises");
const { parentPort, workerData } = require("node:worker_threads");
const tar = require("tar");
const unbzip2 = require("unbzip2-stream");
const { assertSafeModelArchiveEntry } = require("../helpers/modelArchiveIntegrity");

async function processArchive({ operation, archivePath, expectedRoot, extractDir, maxBytes }) {
  if (operation === "extract") {
    await pipeline(fs.createReadStream(archivePath), unbzip2(), tar.x({ cwd: extractDir }));
    return;
  }
  if (operation !== "validate") throw new Error("Unknown model archive operation");
  let count = 0;
  let size = 0;
  const names = new Map();
  const parser = tar.t({
    strict: true,
    onReadEntry(entry) {
      try {
        const key = assertSafeModelArchiveEntry(entry, expectedRoot);
        // An exact repeat (a tar append) is fine; a case variant or a file/directory
        // swap would overwrite another entry on macOS and Windows.
        const seen = names.get(key);
        if (seen && (seen.path !== entry.path || seen.type !== entry.type))
          throw new Error("Model archive entries collide by case or type");
        names.set(key, { path: entry.path, type: entry.type });
        count += 1;
        size += entry.size;
        if (count > 100000 || size > maxBytes) throw new Error("Model archive exceeds limits");
      } catch (error) {
        parser.abort(error);
      }
    },
  });
  // Checking a large archive takes minutes, so report how much of the file has been read.
  const source = fs.createReadStream(archivePath);
  let read = 0;
  let reported = 0;
  source.on("data", (chunk) => {
    read += chunk.length;
    if (read - reported >= 8 * 1024 * 1024) {
      reported = read;
      parentPort.postMessage({ bytesRead: read });
    }
  });
  await pipeline(source, unbzip2(), parser);
  if (!count) throw new Error("Empty model archive");
}

processArchive(workerData).then(
  () => parentPort.postMessage({ success: true }),
  (error) => parentPort.postMessage({ error: error.message })
);
