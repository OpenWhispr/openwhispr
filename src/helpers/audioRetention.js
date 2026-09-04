/**
 * Decides which saved audio files may be deleted by the retention sweep.
 *
 * Split out of `audioStorage.js` because that module reads `app.getPath` in its
 * constructor and so cannot load under `node --test` — and this decision is
 * exactly the kind that must be tested. Deleting audio is irreversible.
 *
 * The rule that matters: a meeting whose notes were never generated keeps its
 * audio no matter how old it is. Otherwise deferring a meeting — which the app
 * now asks users to do when memory is tight — quietly becomes data loss thirty
 * days later.
 */

/** @returns {number|null} the note id for a meeting track, or null for anything else */
function parseMeetingNoteId(filename) {
  const match = /^OpenWhispr-meeting-(\d+)-/.exec(filename);
  return match ? Number(match[1]) : null;
}

function parseTranscriptionId(filename) {
  const basename = filename.replace(/\.webm$/, "");
  const lastDash = basename.lastIndexOf("-");
  return lastDash !== -1 ? basename.slice(lastDash + 1) : basename;
}

/**
 * @param {object} args
 * @param {Array<{name:string, mtimeMs:number}>} args.files
 * @param {number} args.cutoffMs files older than this are candidates for deletion
 * @param {(noteId:number) => boolean} args.isMeetingUnprocessed
 */
function planAudioCleanup({ files, cutoffMs, isMeetingUnprocessed }) {
  const deleteFiles = [];
  const expiredTranscriptionIds = [];
  const expiredNoteIds = new Set();
  const retainedNoteIds = new Set();
  let keptCount = 0;

  for (const { name, mtimeMs } of files || []) {
    if (mtimeMs >= cutoffMs) {
      keptCount++;
      continue;
    }

    const noteId = parseMeetingNoteId(name);
    if (noteId != null) {
      let unprocessed;
      try {
        unprocessed = isMeetingUnprocessed(noteId);
      } catch {
        // Unable to tell — keep it. Disk is cheap; a lost meeting is not.
        unprocessed = true;
      }
      if (unprocessed) {
        retainedNoteIds.add(noteId);
        keptCount++;
        continue;
      }
      deleteFiles.push(name);
      expiredNoteIds.add(noteId);
      continue;
    }

    if (name.endsWith(".webm")) {
      deleteFiles.push(name);
      expiredTranscriptionIds.push(parseTranscriptionId(name));
      continue;
    }

    deleteFiles.push(name);
  }

  return {
    deleteFiles,
    expiredTranscriptionIds,
    expiredNoteIds,
    retainedNoteIds,
    keptCount,
  };
}

module.exports = { planAudioCleanup, parseMeetingNoteId };
