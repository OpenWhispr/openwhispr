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
  const names = new Set();
  const parser = tar.t({
    strict: true,
    onReadEntry(entry) {
      try {
        const name = assertSafeModelArchiveEntry(entry, expectedRoot);
        if (names.has(name) && entry.type !== "Directory")
          throw new Error("Model archive entries collide by case");
        names.add(name);
        count += 1;
        size += entry.size;
        if (count > 100000 || size > maxBytes) throw new Error("Model archive exceeds limits");
      } catch (error) {
        parser.abort(error);
      }
    },
  });
  await pipeline(fs.createReadStream(archivePath), unbzip2(), parser);
  if (!count) throw new Error("Empty model archive");
}

processArchive(workerData).then(
  () => parentPort.postMessage({ success: true }),
  (error) => parentPort.postMessage({ error: error.message })
);
