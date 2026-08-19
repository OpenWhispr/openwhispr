// In-flight audio-upload work keyed by requestId, so one cancel aborts every
// operation the upload spawned (transcription and diarization run in parallel
// under the same id). Pure seam: no Electron imports, unit-tested in
// test/helpers/uploadCancelRegistry.test.js.
function createUploadCancelRegistry() {
  // requestId -> Set<AbortController>, one controller per in-flight operation.
  const controllers = new Map();

  return {
    // Registers one operation. Missing/invalid ids are inert — flows without a
    // requestId (dictation, voice drafts, warm-ups) get no signal and a no-op
    // release, so their behavior is untouched.
    register(requestId) {
      if (typeof requestId !== "string" || !requestId) {
        return { signal: undefined, release: () => {} };
      }
      let set = controllers.get(requestId);
      if (!set) {
        set = new Set();
        controllers.set(requestId, set);
      }
      const controller = new AbortController();
      set.add(controller);
      return {
        signal: controller.signal,
        release: () => {
          set.delete(controller);
          // Guard against deleting a successor set registered after a cancel.
          if (set.size === 0 && controllers.get(requestId) === set) {
            controllers.delete(requestId);
          }
        },
      };
    },

    // Aborts every operation registered under the id and returns how many were
    // aborted. Unknown or already-finished ids are a safe no-op — the renderer
    // fires a cancel for every provider, including ones that never register.
    cancel(requestId) {
      const set = controllers.get(requestId);
      if (!set) return 0;
      controllers.delete(requestId);
      for (const controller of set) controller.abort();
      return set.size;
    },
  };
}

module.exports = { createUploadCancelRegistry };
