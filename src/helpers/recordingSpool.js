import logger from "../utils/logger";

// Keeps each recording's chunks in IndexedDB until its result is saved, so the
// audio survives a hung or crashed main process (#2073). The renderer writes
// straight to Chromium's storage backend, which runs off the main process's UI
// thread; a spool routed through IPC waits on that thread instead. Only opening
// the database goes through it, so the dictation window opens it at launch
// (takeInterruptedRecordings), before any recording.
const DB_NAME = "openwhispr-recording-spool";
const STORE = "chunks";

// Every session this page started, finished or not. Anything else in the store
// belongs to a page that closed before its recording was saved.
const pageSessions = new Set();
let dbPromise = null;
let interruptedTaken = false;

function openDb() {
  dbPromise ??= new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, 1);
    request.onupgradeneeded = () =>
      request.result.createObjectStore(STORE, { keyPath: ["sessionId", "seq"] });
    request.onsuccess = () => {
      // Chromium closes a connection when site data is cleared; reopen on the next write.
      request.result.onclose = () => (dbPromise = null);
      resolve(request.result);
    };
    request.onerror = () => reject(request.error);
  }).catch((error) => {
    // Logged once: every later write would hit the same cached failure.
    logger.warn("Recording spool unavailable", { error: error.message }, "audio");
    return null;
  });
  return dbPromise;
}

// Writes run in call order: each one queues its transaction behind the same
// open, and IndexedDB commits overlapping read-write transactions in creation order.
function write(apply) {
  openDb()
    .then((db) => {
      if (!db) return;
      const transaction = db.transaction(STORE, "readwrite");
      // Quota and commit failures abort the transaction without a request error.
      transaction.onabort = () =>
        logger.warn("Recording spool write failed", { error: transaction.error?.message }, "audio");
      apply(transaction.objectStore(STORE));
    })
    .catch((error) =>
      logger.warn("Recording spool write failed", { error: error.message }, "audio")
    );
}

function discardSession(sessionId) {
  write((store) => store.delete(IDBKeyRange.bound([sessionId, 0], [sessionId, Infinity])));
}

export function startRecordingSpool(routeKind = null) {
  const sessionId = crypto.randomUUID();
  const startedAt = Date.now();
  let seq = 0;
  let segments = 0;
  let open = true;
  pageSessions.add(sessionId);

  return {
    // One segment per MediaRecorder: each writes its own WebM stream, and a mic
    // swap mid-recording starts another.
    addSegment(mimeType) {
      const segment = segments++;
      return (chunk) => {
        if (!open) return;
        const record = {
          sessionId,
          seq: seq++,
          segment,
          mimeType,
          routeKind,
          startedAt,
          at: Date.now(),
          chunk,
        };
        write((store) => store.put(record));
      };
    },
    finish() {
      if (!open) return;
      open = false;
      discardSession(sessionId);
    },
  };
}

// Once per page, so a second caller can't save the same recording twice.
export async function takeInterruptedRecordings() {
  if (interruptedTaken) return [];
  interruptedTaken = true;

  const db = await openDb();
  if (!db) return [];
  const rows = await new Promise((resolve, reject) => {
    const request = db.transaction(STORE).objectStore(STORE).getAll();
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });

  const sessions = new Map();
  for (const row of rows) {
    if (pageSessions.has(row.sessionId)) continue;
    let session = sessions.get(row.sessionId);
    if (!session) {
      session = {
        startedAt: row.startedAt,
        routeKind: row.routeKind,
        lastAt: row.at,
        segments: [],
      };
      sessions.set(row.sessionId, session);
    }
    session.lastAt = row.at;
    (session.segments[row.segment] ??= { mimeType: row.mimeType, chunks: [] }).chunks.push(
      row.chunk
    );
  }

  return [...sessions].map(([sessionId, session]) => ({
    startedAt: session.startedAt,
    durationMs: session.lastAt - session.startedAt,
    routeKind: session.routeKind,
    segments: session.segments
      .filter(Boolean)
      .map(({ mimeType, chunks }) => new Blob(chunks, { type: mimeType })),
    discard: () => discardSession(sessionId),
  }));
}
