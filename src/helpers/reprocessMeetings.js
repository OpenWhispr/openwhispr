"use strict";

/**
 * Enqueue a full post-call pipeline re-run for every meeting note that still
 * has saved audio on disk. Kept as a pure, injectable helper (db + queue +
 * pipeline manager passed in) so the orchestration is unit-testable without
 * standing up the whole IPC layer.
 *
 * @param {object} deps
 * @param {{ prepare: Function }} deps.db - better-sqlite3 database handle
 * @param {{ enqueue: (id: string, fn: Function) => void }} deps.backgroundJobQueue
 * @param {{ run: (noteId: number, opts: object) => any }} deps.postCallPipelineManager
 * @returns {number} count of meetings queued
 */
function enqueueMeetingReprocess({ db, backgroundJobQueue, postCallPipelineManager }) {
  const rows = db
    .prepare(
      "SELECT id FROM notes WHERE note_type = 'meeting' AND (system_audio_path IS NOT NULL OR mic_audio_path IS NOT NULL)"
    )
    .all();

  for (const { id } of rows) {
    backgroundJobQueue.enqueue(`post-call-reprocess-${id}`, () =>
      postCallPipelineManager.run(id, { fromStep: "retranscribe" })
    );
  }

  return rows.length;
}

module.exports = { enqueueMeetingReprocess };
