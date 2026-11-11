const debugLogger = require("./debugLogger");
const defaultMirror = require("./markdownMirror");
const { buildNotePlacements } = require("./notePlacement");

// A sync pull touches notes one IPC call at a time, so it is written in batches.
const NOTE_BATCH_DELAY_MS = 1000;
const RECONCILE_DELAY_MS = 200;
const NOTES_PER_TURN = 50;
const ALL_NOTES_LIMIT = 99999;

const yieldToEventLoop = () => new Promise((resolve) => setImmediate(resolve));

function groupByNote(entries) {
  const groups = new Map();
  for (const entry of entries) {
    if (!groups.has(entry.ownerId)) groups.set(entry.ownerId, []);
    groups.get(entry.ownerId).push(entry);
  }
  return groups;
}

// Keeps the Markdown mirror in step with the database. A note's path comes only
// from its workspace, space and folder (notePlacement.js), and the database records
// every file the mirror writes, so one pass (reconcile) fixes any rename, move,
// relocation between private spaces, or change made while the mirror was off: it
// writes each note whose recorded files aren't where they belong.
function createNoteFilesSync({ getDatabase, getSpeakerMappings, mirror = defaultMirror }) {
  let enabled = false;
  // Bumped whenever the mirror stops or moves, so a reconcile still running gives up.
  let generation = 0;
  const queuedNoteIds = new Set();
  let noteBatchTimer = null;
  let reconcileTimer = null;
  const pendingWrites = new Set();
  let reconcilePromise = null;
  let reconcileAgain = false;
  // What placement depends on, as last reconciled. A sync pass upserts every
  // space and folder, and most passes change none of them.
  let reconciledContainers = null;
  let reconcileForced = false;

  const database = () => getDatabase();
  const containersSignature = () => JSON.stringify(database().getMirrorContainers());
  const loadPlacements = () => buildNotePlacements(database().getMirrorContainers());

  const useDatabaseLedger = () =>
    mirror.setLedger({
      files: (basePath, noteId) => database().getMirrorFiles(basePath, noteId),
      record: (basePath, entry) => database().recordMirrorFile(basePath, entry),
      forget: (basePath, relPath) => database().forgetMirrorFile(basePath, relPath),
    });

  const guarded = (label, work) => {
    try {
      return work();
    } catch (error) {
      debugLogger.error(label, { error: error.message }, "note-files");
      return undefined;
    }
  };

  const writeOne = (note, placements) => {
    const location = placements.forNote(note);
    mirror.writeNote(note, location);
    if (mirror.transcriptSegments(note).length > 0) {
      mirror.writeTranscript(note, location, getSpeakerMappings(note.id));
    } else {
      mirror.removeTranscripts(note, getSpeakerMappings(note.id));
    }
  };

  // From a note's summary row (no content), so checking every note stays cheap.
  const isInPlace = (summary, placements, entries) => {
    const location = placements.forNote(summary);
    const expected = [mirror.relPathFor(summary, location, "note")];
    if (summary.has_transcript) {
      expected.push(mirror.relPathFor(summary, location, "transcript"));
    }
    return (
      entries.length === expected.length &&
      expected.every((relPath) => entries.some((entry) => entry.relPath === relPath))
    );
  };

  const whenEnabled = (work) => {
    if (!enabled) return;
    const run = () => {
      if (!pendingWrites.delete(run)) return;
      if (enabled) guarded("Note file update failed", work);
    };
    pendingWrites.add(run);
    setImmediate(run);
  };

  // Scope changes and update quits cannot wait for another event-loop turn.
  const flushSync = () => {
    for (const run of [...pendingWrites.values()]) run();
    flushQueuedNotes();
  };

  const flushQueuedNotes = () => {
    clearTimeout(noteBatchTimer);
    noteBatchTimer = null;
    if (!enabled || queuedNoteIds.size === 0) return;
    const noteIds = [...queuedNoteIds];
    queuedNoteIds.clear();
    guarded("Failed to write pulled note files", () => {
      const placements = loadPlacements();
      for (const note of database().getNotesForMirror(noteIds)) {
        if (note.deleted_at) mirror.deleteNote(note.id, note, getSpeakerMappings(note.id));
        else writeOne(note, placements);
      }
    });
  };

  // Writes misplaced notes, removes the files of deleted notes and of notes gone
  // from the database (only files the mirror wrote and nobody changed), moves
  // folder directories, and moves files left in the old layout. Another account's
  // notes aren't returned by the database, so their files wait for its turn.
  const runReconcile = async (startedGeneration) => {
    const stillCurrent = () => enabled && startedGeneration === generation;
    const db = database();
    reconciledContainers = containersSignature();
    reconcileForced = false;
    let placements = loadPlacements();
    const recorded = mirror.recordedFiles();
    const filesByNote = groupByNote(recorded.filter((entry) => entry.kind !== "dir"));
    const legacy = mirror.legacyNoteIds(db.getLegacyMirrorFolderNames());
    const summaries = db.getMirrorNoteSummaries();
    const liveIds = new Set(summaries.map((note) => note.id));

    const misplacedIds = summaries
      .filter(
        (note) =>
          legacy.has(note.id) || !isInPlace(note, placements, filesByNote.get(note.id) ?? [])
      )
      .map((note) => note.id);
    for (let start = 0; start < misplacedIds.length; start += NOTES_PER_TURN) {
      if (!stillCurrent()) return;
      // Read just before writing: a note edited since the summaries were read
      // is written as it is now.
      for (const note of db.getNotesForMirror(misplacedIds.slice(start, start + NOTES_PER_TURN))) {
        if (!note.deleted_at) writeOne(note, placements);
      }
      await yieldToEventLoop();
      placements = loadPlacements();
    }
    if (!stillCurrent()) return;

    const otherIds = [...new Set([...filesByNote.keys(), ...legacy])].filter(
      (noteId) => !liveIds.has(noteId)
    );
    const rows = db.getNotesForMirror(otherIds);
    for (const note of rows) {
      if (note.deleted_at) mirror.deleteNote(note.id, note, getSpeakerMappings(note.id));
    }
    // Recorded here, so the mirror wrote them for this database; an old-layout
    // file with no row stays, since after a reset it may be the only copy.
    const existing = new Set(db.getExistingNoteIds(otherIds));
    for (const noteId of otherIds) {
      if (!existing.has(noteId)) mirror.deleteNote(noteId);
    }

    for (const entry of recorded.filter((row) => row.kind === "dir")) {
      const location = placements.folderLocation(entry.ownerId);
      if (!location) mirror.releaseFolderDir(entry.relPath);
      else if (mirror.relPathFor(null, location, "dir") !== entry.relPath) {
        mirror.moveFolderDir(entry.relPath, location, entry.ownerId);
      }
    }
    mirror.removeVacatedDirs(
      new Set(
        placements.folderLocations().map((location) => mirror.relPathFor(null, location, "dir"))
      )
    );
    const { folders } = db.getMirrorContainers();
    mirror.removeEmptyOldDirs(["Personal", ...folders.map((folder) => folder.name)]);
  };

  const reconcile = () => {
    clearTimeout(reconcileTimer);
    reconcileTimer = null;
    if (!enabled) return Promise.resolve();
    if (reconcilePromise) {
      reconcileAgain = true;
      return reconcilePromise;
    }
    reconcilePromise = (async () => {
      try {
        do {
          reconcileAgain = false;
          await runReconcile(generation);
        } while (reconcileAgain && enabled);
      } catch (error) {
        debugLogger.error("Note file reconcile failed", { error: error.message }, "note-files");
      } finally {
        reconcilePromise = null;
      }
    })();
    return reconcilePromise;
  };

  // Runs a reconcile unless nothing placement depends on changed since the last.
  const scheduledReconcile = () => {
    reconcileTimer = null;
    const skip =
      !reconcileForced &&
      guarded(
        "Failed to read note file placement",
        () => containersSignature() === reconciledContainers
      );
    return skip ? (reconcilePromise ?? Promise.resolve()) : reconcile();
  };

  const start = (basePath) => {
    if (mirror.getBasePath() !== basePath) generation++;
    useDatabaseLedger();
    mirror.init(basePath);
  };

  const rebuild = async () => {
    const placements = loadPlacements();
    const notes = database().getNotes(null, ALL_NOTES_LIMIT);
    for (const note of notes) writeOne(note, placements);
    debugLogger.info("Markdown mirror rebuild complete", { count: notes.length }, "note-files");
    await reconcile();
  };

  return {
    get enabled() {
      return enabled;
    },

    async enable(basePath, { skipRebuild = false } = {}) {
      enabled = true;
      start(basePath);
      if (!skipRebuild) {
        await rebuild();
        return;
      }
      // Not awaited: a first launch may have thousands of files to move, and
      // the window asking doesn't wait on them.
      reconcile();
    },

    disable() {
      enabled = false;
      generation++;
      queuedNoteIds.clear();
      clearTimeout(noteBatchTimer);
      clearTimeout(reconcileTimer);
      noteBatchTimer = null;
      reconcileTimer = null;
    },

    async setPath(basePath) {
      start(basePath);
      await rebuild();
    },

    rebuild() {
      return rebuild();
    },

    writeNote(note) {
      whenEnabled(() => writeOne(note, loadPlacements()));
    },

    // The row, while there is one, lets old-layout files be checked against it.
    // A caller holding a row the database has already lost passes it, with the
    // speaker names it had.
    deleteNote(noteId, deletedRow = null, speakerMappings = null) {
      if (!enabled) return;
      const [note] = deletedRow ? [deletedRow] : database().getNotesForMirror([noteId]);
      const mappings = speakerMappings ?? getSpeakerMappings(noteId);
      whenEnabled(() => mirror.deleteNote(noteId, note ?? null, mappings));
    },

    // A note that arrived or changed through sync.
    queueNote(noteId) {
      if (!enabled) return;
      queuedNoteIds.add(noteId);
      noteBatchTimer ??= setTimeout(flushQueuedNotes, NOTE_BATCH_DELAY_MS);
    },

    // A workspace, space or folder that may have been renamed, moved or removed.
    // Nothing runs when none actually changed.
    containersChanged() {
      if (!enabled) return;
      reconcileTimer ??= setTimeout(scheduledReconcile, RECONCILE_DELAY_MS);
    },

    // Notes moved between spaces or folders in bulk, by SQL that wrote no files.
    notesMoved() {
      if (!enabled) return;
      reconcileForced = true;
      reconcileTimer ??= setTimeout(scheduledReconcile, RECONCILE_DELAY_MS);
    },

    ensureFolder(folderId) {
      whenEnabled(() => {
        const location = loadPlacements().folderLocation(folderId);
        if (location) mirror.ensureFolder(location, folderId);
      });
    },

    // A folder with no notes may have no directory yet, so it's made here.
    folderPath(folderId) {
      const location = loadPlacements().folderLocation(folderId);
      if (!location) return null;
      if (enabled) mirror.ensureFolder(location, folderId);
      return mirror.getFolderPath(location);
    },

    notePath(noteId) {
      return mirror.getNotePath(noteId);
    },

    // The new account's notes may still be in the old layout or misplaced.
    accountChanged() {
      generation++;
      if (enabled) reconcile();
    },

    flushSync,

    // Runs everything scheduled now. Deletes finish before directories are
    // checked for being empty.
    async flush() {
      flushSync();
      if (reconcileTimer) {
        clearTimeout(reconcileTimer);
        await scheduledReconcile();
      }
      await reconcilePromise;
    },
  };
}

module.exports = { createNoteFilesSync };
