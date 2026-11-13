const path = require("path");
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
  let noteBatchPromise = null;
  let reconcileTimer = null;
  const pendingWrites = new Set();
  let reconcilePromise = null;
  let reconcileAgain = false;
  // What placement depends on, as last reconciled. A sync pass upserts every
  // space and folder, and most passes change none of them.
  let reconciledContainers = null;
  let placementSnapshot = null;
  let reconcileForced = false;

  const database = () => getDatabase();
  const containersSignature = () => JSON.stringify(database().getMirrorContainers());
  // A save or Show in folder can beat the debounced reconcile. Move safe folders
  // first, while their attachments still share the notes' original directory.
  const preparePlacements = () => {
    const containers = database().getMirrorContainers();
    const signature = JSON.stringify(containers);
    const placements = buildNotePlacements(containers);
    if (enabled && placementSnapshot && signature !== placementSnapshot) {
      const previous = JSON.parse(placementSnapshot);
      const oldPlacements = buildNotePlacements(previous);
      const existingPath = (location) => {
        const absolutePath = mirror.getFolderPath(location);
        return absolutePath === null
          ? null
          : path.relative(mirror.getBasePath(), absolutePath).split(path.sep).join("/");
      };
      const folderPaths = (snapshot, layout, resolvePath) => {
        const paths = new Map();
        for (const folder of snapshot.folders) {
          const location = layout.folderLocation(folder.id);
          const relPath = location && resolvePath(location);
          if (!relPath) continue;
          if (!paths.has(relPath)) paths.set(relPath, []);
          paths.get(relPath).push(folder.id);
        }
        return paths;
      };
      const newPaths = folderPaths(containers, placements, (location) =>
        mirror.relPathFor(null, location, "dir")
      );
      const oldPaths = folderPaths(previous, oldPlacements, existingPath);
      const occupiedPaths = folderPaths(containers, placements, existingPath);
      const previousSources = new Map();
      for (const [relPath, owners] of oldPaths) {
        for (const owner of owners) previousSources.set(owner, relPath);
      }
      const summaries = new Map(
        database()
          .getMirrorNoteSummaries()
          .map((note) => [note.id, note])
      );
      const recorded = mirror.recordedFiles();
      const pendingMoves = [];
      for (const folder of previous.folders) {
        const before = oldPlacements.folderLocation(folder.id);
        const after = placements.folderLocation(folder.id);
        if (!before || !after) continue;
        const oldPath = mirror.relPathFor(null, before, "dir");
        const newPath = mirror.relPathFor(null, after, "dir");
        // A deferred case rename leaves the ledger at the actual on-disk spelling.
        const actualOldPath = previousSources.get(folder.id);
        if (
          oldPath === newPath ||
          !actualOldPath ||
          oldPaths.get(actualOldPath)?.length !== 1 ||
          newPaths.get(newPath)?.length !== 1
        )
          continue;
        const claimants = [
          ...(newPaths.get(oldPath) ?? []),
          ...(occupiedPaths.get(actualOldPath) ?? []),
        ];
        if (
          claimants.some(
            (id) =>
              id !== folder.id &&
              (!previousSources.has(id) || previousSources.get(id) === actualOldPath)
          )
        )
          continue;
        const descendants = recorded.filter(
          (entry) =>
            entry.relPath === actualOldPath || entry.relPath.startsWith(`${actualOldPath}/`)
        );
        if (
          descendants.length === 0 ||
          !descendants.every((entry) => {
            if (entry.kind === "dir")
              return entry.ownerId === folder.id && entry.relPath === actualOldPath;
            const note = summaries.get(entry.ownerId);
            if (!note) return false;
            const expectedDir = mirror.relPathFor(null, placements.forNote(note), "dir");
            const previousDir = entry.relPath.slice(0, entry.relPath.lastIndexOf("/"));
            return expectedDir === newPath + previousDir.slice(actualOldPath.length);
          })
        )
          continue;
        pendingMoves.push({ before, after, folderId: folder.id });
      }
      // A sibling may take a vacated name after disambiguation changes. Free its
      // destination first, independently of database order; leave cycles alone.
      let madeProgress = true;
      while (madeProgress && pendingMoves.length > 0) {
        madeProgress = false;
        for (let index = 0; index < pendingMoves.length;) {
          const { before, after, folderId } = pendingMoves[index];
          if (mirror.getFolderPath(after)) {
            index++;
            continue;
          }
          pendingMoves.splice(index, 1);
          const source = existingPath(before);
          if (source && mirror.relocateFolderDir(source, after, folderId)) madeProgress = true;
        }
      }
    }
    if (enabled) placementSnapshot = signature;
    return placements;
  };

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
    clearTimeout(noteBatchTimer);
    noteBatchTimer = null;
    writeQueuedNotes();
  };

  const writeQueuedNotes = (limit = queuedNoteIds.size) => {
    if (!enabled || queuedNoteIds.size === 0) return;
    const noteIds = [];
    for (const noteId of queuedNoteIds) {
      noteIds.push(noteId);
      queuedNoteIds.delete(noteId);
      if (noteIds.length >= limit) break;
    }
    guarded("Failed to write pulled note files", () => {
      const placements = preparePlacements();
      for (const note of database().getNotesForMirror(noteIds)) {
        if (note.deleted_at) mirror.deleteNote(note.id, note, getSpeakerMappings(note.id));
        else writeOne(note, placements);
      }
    });
  };

  const flushQueuedNotes = () => {
    clearTimeout(noteBatchTimer);
    noteBatchTimer = null;
    if (noteBatchPromise || !enabled || queuedNoteIds.size === 0) return noteBatchPromise;
    const startedGeneration = generation;
    noteBatchPromise = (async () => {
      while (enabled && startedGeneration === generation && queuedNoteIds.size > 0) {
        writeQueuedNotes(NOTES_PER_TURN);
        await yieldToEventLoop();
      }
    })().finally(() => {
      noteBatchPromise = null;
      if (enabled && queuedNoteIds.size > 0) {
        noteBatchTimer ??= setTimeout(flushQueuedNotes, NOTE_BATCH_DELAY_MS);
      }
    });
    return noteBatchPromise;
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
    let placements = preparePlacements();
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
      placements = preparePlacements();
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
    if (mirror.getBasePath() !== basePath) {
      generation++;
      placementSnapshot = null;
    }
    useDatabaseLedger();
    mirror.init(basePath);
  };

  const rebuild = async () => {
    const placements = preparePlacements();
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
      whenEnabled(() => writeOne(note, preparePlacements()));
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
      if (!noteBatchPromise) {
        noteBatchTimer ??= setTimeout(flushQueuedNotes, NOTE_BATCH_DELAY_MS);
      }
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
        const location = preparePlacements().folderLocation(folderId);
        if (location) mirror.ensureFolder(location, folderId);
      });
    },

    // A folder with no notes may have no directory yet, so it's made here.
    folderPath(folderId) {
      const location = preparePlacements().folderLocation(folderId);
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
      await noteBatchPromise;
      if (reconcileTimer) {
        clearTimeout(reconcileTimer);
        await scheduledReconcile();
      }
      await reconcilePromise;
    },
  };
}

module.exports = { createNoteFilesSync };
