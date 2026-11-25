const path = require("path");
const debugLogger = require("./debugLogger");
const defaultMirror = require("./markdownMirror");
const { buildNotePlacements } = require("./notePlacement");

// A sync pull touches notes one IPC call at a time, so it is written in batches.
const NOTE_BATCH_DELAY_MS = 1000;
const RECONCILE_DELAY_MS = 200;
const NOTES_PER_TURN = 50;
const ALL_NOTES_LIMIT = 99999;

// How often one change plans folder moves again after some moved: a parent's
// directory can move whole only after a subfolder leaving it has gone.
const MAX_RELOCATION_ROUNDS = 5;

const yieldToEventLoop = () => new Promise((resolve) => setImmediate(resolve));

// Paths a case-insensitive disk may treat as one count as one, so a move waits
// rather than risk landing in a directory about to leave.
const foldPath = (relPath) =>
  String(relPath).normalize("NFC").toLowerCase().toUpperCase().normalize("NFC");
const isInsidePath = (relPath, ancestorRelPath) =>
  foldPath(relPath).startsWith(`${foldPath(ancestorRelPath)}/`);
const isSameOrInsidePath = (relPath, ancestorRelPath) =>
  foldPath(relPath) === foldPath(ancestorRelPath) || isInsidePath(relPath, ancestorRelPath);

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
  let pendingInitialization = null;
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

  // Where a placement's directory is now, as the disk spells it.
  const existingPath = (location) => {
    const absolutePath = mirror.getFolderPath(location);
    return absolutePath === null
      ? null
      : path.relative(mirror.getBasePath(), absolutePath).split(path.sep).join("/");
  };
  // Every folder's directory, nested ones and other accounts' included, by path.
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

  // The folders whose whole directory can move to where it now belongs: it is that
  // folder's alone, before and after, and every file the mirror recorded in it is
  // one of this account's notes, or a subfolder's directory, that goes along to the
  // same place inside the new directory.
  const planFolderMoves = ({
    previous,
    oldPlacements,
    containers,
    placements,
    summaries,
    done,
  }) => {
    const newPaths = folderPaths(containers, placements, (location) =>
      mirror.relPathFor(null, location, "dir")
    );
    const oldPaths = folderPaths(previous, oldPlacements, existingPath);
    const occupiedPaths = folderPaths(containers, placements, existingPath);
    const previousSources = new Map();
    for (const [relPath, owners] of oldPaths) {
      for (const owner of owners) previousSources.set(owner, relPath);
    }
    const recorded = mirror.recordedFiles();
    const moves = [];
    for (const folder of previous.folders) {
      if (done.has(folder.id)) continue;
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
        newPaths.get(newPath)?.length !== 1 ||
        // Never into itself or one of its subfolders' directories, nor over an ancestor's.
        newPath.startsWith(`${actualOldPath}/`) ||
        actualOldPath.startsWith(`${newPath}/`)
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
          (entry.relPath === actualOldPath || entry.relPath.startsWith(`${actualOldPath}/`)) &&
          !mirror.isEmptyRecord(entry)
      );
      if (
        descendants.length === 0 ||
        !descendants.every((entry) => {
          if (entry.kind === "dir") {
            const within = entry.relPath.slice(actualOldPath.length);
            if (entry.ownerId === folder.id) return within === "";
            const owner = placements.folderLocation(entry.ownerId);
            return (
              owner !== null &&
              placements.isInsideFolder(entry.ownerId, folder.id) &&
              mirror.relPathFor(null, owner, "dir") === newPath + within
            );
          }
          const note = summaries.get(entry.ownerId);
          if (!note) return false;
          const expectedDir = mirror.relPathFor(null, placements.forNote(note), "dir");
          const previousDir = entry.relPath.slice(0, entry.relPath.lastIndexOf("/"));
          return expectedDir === newPath + previousDir.slice(actualOldPath.length);
        })
      )
        continue;
      moves.push({ before, after, folderId: folder.id, source: actualOldPath, newPath });
    }
    return moves;
  };

  // A move waits while another would carry its directory along, while its
  // destination sits in a directory about to leave, and until the directory its
  // destination sits in has arrived. A sibling may take a vacated name after
  // disambiguation changes, so moves free their destinations first, independently
  // of database order; cycles are left alone, except the one below.
  const runFolderMoves = (moves, done) => {
    const pending = [...moves];
    // On a disk that ignores case, nesting a folder under one whose name differs
    // only in case ("projects" under "Projects") is a cycle: the parent's new
    // directory is the subfolder's own, spelled differently, and the subfolder
    // waits for its new parent. Left alone, the next write would hand the
    // subfolder's directory, attachments and all, to the parent. The subfolder
    // steps aside to a free name first, so the parent moves in whole and the
    // subfolder follows from there.
    const parkCaseFoldedOccupant = () => {
      for (const move of pending) {
        const destination = mirror.getFolderPath(move.after);
        if (!destination) continue;
        const occupant = pending.find(
          (other) =>
            other !== move &&
            !other.parkedAt &&
            isInsidePath(other.newPath, move.newPath) &&
            mirror.isSameDirectory(destination, mirror.getFolderPath(other.before))
        );
        if (!occupant) continue;
        const parkedAt = mirror.parkFolderDir(occupant.source, occupant.before, occupant.folderId);
        if (!parkedAt) continue;
        occupant.parkedAt = parkedAt;
        occupant.source = parkedAt;
        return true;
      }
      return false;
    };
    const mustWait = (move) =>
      pending.some(
        (other) =>
          other !== move &&
          (isInsidePath(move.source, other.source) ||
            isSameOrInsidePath(move.newPath, other.source) ||
            isInsidePath(move.newPath, other.newPath))
      );
    let movedAny = false;
    for (;;) {
      let madeProgress = true;
      while (madeProgress && pending.length > 0) {
        madeProgress = false;
        for (let index = 0; index < pending.length;) {
          const move = pending[index];
          if (mirror.getFolderPath(move.after) || mustWait(move)) {
            index++;
            continue;
          }
          pending.splice(index, 1);
          // Even a move that can't happen frees the moves waiting on it.
          madeProgress = true;
          const source = move.parkedAt ?? existingPath(move.before);
          if (source && mirror.relocateFolderDir(source, move.after, move.folderId)) {
            done.add(move.folderId);
            movedAny = true;
          }
        }
      }
      if (pending.length > 0 && parkCaseFoldedOccupant()) continue;
      // A destination still taken now stays taken (the user's directory, or a
      // cycle), so those moves never happen and the moves waiting on them go alone.
      const stuck = pending.filter((move) => mirror.getFolderPath(move.after));
      if (stuck.length === 0 || stuck.length === pending.length) break;
      for (const move of stuck) pending.splice(pending.indexOf(move), 1);
    }
    return movedAny;
  };

  // A save or Show in folder can beat the debounced reconcile. Move safe folders
  // first, while their attachments still share the notes' original directory. A
  // parent can move whole only once a subfolder leaving it has gone, so moves are
  // planned again after any happen.
  const preparePlacements = () => {
    const containers = database().getMirrorContainers();
    const signature = JSON.stringify(containers);
    const placements = buildNotePlacements(containers);
    if (enabled && placementSnapshot && signature !== placementSnapshot) {
      const previous = JSON.parse(placementSnapshot);
      const plan = {
        previous,
        oldPlacements: buildNotePlacements(previous),
        containers,
        placements,
        summaries: new Map(
          database()
            .getMirrorNoteSummaries()
            .map((note) => [note.id, note])
        ),
        done: new Set(),
      };
      for (let round = 0; round < MAX_RELOCATION_ROUNDS; round++) {
        const moves = planFolderMoves(plan);
        if (moves.length === 0 || !runFolderMoves(moves, plan.done)) break;
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
    const expected = summary.is_transcript_only_upload
      ? []
      : [mirror.relPathFor(summary, location, "note")];
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
      if (enabled && !pendingInitialization) guarded("Note file update failed", work);
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
    const stillCurrent = () =>
      enabled && !pendingInitialization && startedGeneration === generation;
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
    // The old layout predates subfolders, so only a top-level folder's name can be
    // an old directory; an empty directory named like a subfolder is the user's.
    const { folders } = db.getMirrorContainers();
    mirror.removeEmptyOldDirs([
      "Personal",
      ...folders.filter((folder) => folder.parent_folder_id == null).map((folder) => folder.name),
    ]);
  };

  const reconcile = () => {
    clearTimeout(reconcileTimer);
    reconcileTimer = null;
    if (!enabled || pendingInitialization) return Promise.resolve();
    if (reconcilePromise) {
      reconcileAgain = true;
      return reconcilePromise;
    }
    reconcilePromise = (async () => {
      try {
        do {
          reconcileAgain = false;
          await runReconcile(generation);
        } while (reconcileAgain && enabled && !pendingInitialization);
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

  const configurePath = (basePath) => {
    if (mirror.getBasePath() !== basePath) {
      generation++;
      placementSnapshot = null;
    }
    pendingInitialization = { basePath };
  };

  const initialize = () => {
    useDatabaseLedger();
    mirror.init(pendingInitialization.basePath);
    pendingInitialization = null;
  };

  const rebuild = async () => {
    if (pendingInitialization) initialize();
    const placements = preparePlacements();
    const notes = database().getNotes(null, ALL_NOTES_LIMIT);
    for (const note of notes) writeOne(note, placements);
    debugLogger.info("Markdown mirror rebuild complete", { count: notes.length }, "note-files");
    await reconcile();
  };

  const retryInitialization = async () => {
    if (!enabled || !pendingInitialization) return false;
    // Edits made during the outage may already have files at the expected paths.
    await rebuild();
    return true;
  };

  return {
    get enabled() {
      return enabled;
    },

    async enable(basePath, { skipRebuild = false } = {}) {
      enabled = true;
      configurePath(basePath);
      if (!skipRebuild) {
        await rebuild();
        return;
      }
      initialize();
      // A first launch may have thousands of files to move.
      reconcile();
    },

    retryInitialization,

    disable() {
      enabled = false;
      pendingInitialization = null;
      generation++;
      queuedNoteIds.clear();
      clearTimeout(noteBatchTimer);
      clearTimeout(reconcileTimer);
      noteBatchTimer = null;
      reconcileTimer = null;
    },

    async setPath(basePath) {
      configurePath(basePath);
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

    // Keep merged rows until a usable destination can check their old files.
    deleteMergedNotes(mergedNotes) {
      if (mergedNotes.length === 0) return;
      whenEnabled(() => {
        for (const note of mergedNotes.splice(0)) {
          mirror.deleteNote(note.id, note, note.speakerMappings ?? getSpeakerMappings(note.id));
        }
      });
    },

    // Take the repairs only once their files can be updated.
    queueAccountRepairNotes() {
      whenEnabled(() => {
        for (const note of database().takeAccountRepairNotes()) {
          guarded("Note file update failed", () => writeOne(note, preparePlacements()));
        }
      });
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
