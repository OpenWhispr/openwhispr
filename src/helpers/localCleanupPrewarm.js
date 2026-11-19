const debugLogger = require("./debugLogger");
const { DICTATION_LIFECYCLE } = require("./dictationLifecycle");

// The renderer can prepare and cancel without opening a recording. Once confirmed,
// keep the take's model eligible through processing, including a slow transcription.
function createLocalCleanupPrewarm(modelManager) {
  let active = false;
  let modelId = null;
  let controller = null;

  function update() {
    controller?.abort();
    controller = null;
    if (!active || !modelId) return;

    controller = new AbortController();
    modelManager.prewarmServer(modelId, controller.signal).catch((error) => {
      debugLogger.debug("llama-server dictation pre-warm failed", { error: error.message });
    });
  }

  return {
    setModel(nextModel) {
      if (modelId === nextModel) return;
      modelId = nextModel;
      update();
    },
    setLifecycleState(state) {
      if (state !== DICTATION_LIFECYCLE.RECORDING && state !== DICTATION_LIFECYCLE.IDLE) return;
      const recording = state === DICTATION_LIFECYCLE.RECORDING;
      if (active === recording) return;
      active = recording;
      update();
    },
  };
}

module.exports = { createLocalCleanupPrewarm };
