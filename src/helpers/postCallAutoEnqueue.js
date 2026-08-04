"use strict";

/**
 * Decide whether a finished meeting should kick off the post-call pipeline, and
 * queue it if so. Kept as a pure, injectable helper (queue + pipeline manager
 * passed in) so the trigger is unit-testable without standing up the whole IPC
 * layer — the pipeline itself was well covered while the thing that starts it
 * was not.
 *
 * @param {object} deps
 * @param {number|null|undefined} deps.noteId
 * @param {boolean} deps.disabled - user turned the automatic pipeline off
 * @param {{ enqueue: (id: string, fn: Function) => void }} deps.backgroundJobQueue
 * @param {{ run: (noteId: number) => any }} deps.postCallPipelineManager
 * @param {{ info: Function }} [deps.logger]
 * @returns {boolean} true when a job was queued
 */
function enqueuePostCallPipeline({
  noteId,
  disabled,
  backgroundJobQueue,
  postCallPipelineManager,
  logger,
}) {
  if (disabled) {
    logger?.info("Post-call pipeline disabled by user setting", {}, "meeting");
    return false;
  }
  if (noteId === null || noteId === undefined) return false;

  backgroundJobQueue.enqueue(`post-call-${noteId}`, () => postCallPipelineManager.run(noteId));
  return true;
}

module.exports = { enqueuePostCallPipeline };
