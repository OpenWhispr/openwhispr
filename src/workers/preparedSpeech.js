// Short lines the assistant says often (the filler while a tool runs) are synthesized
// ahead of time so they play at once. Preparation runs one line at a time and pauses
// whenever real speech is outstanding, so an answer never waits behind more than the
// line already in progress.
function createPreparedSpeech({ synthesize, onError }) {
  const ready = new Map();
  let waiting = [];
  let preparing = false;
  let speaking = 0;
  let generation = 0;

  const pump = () => {
    if (preparing || speaking > 0) return;
    const text = waiting.shift();
    if (text === undefined) return;
    if (ready.has(text)) {
      pump();
      return;
    }
    preparing = true;
    const preparedFor = generation;
    synthesize(text)
      .then((samples) => {
        if (preparedFor === generation) ready.set(text, samples);
      }, onError)
      .finally(() => {
        preparing = false;
        pump();
      });
  };

  return {
    prepare(texts) {
      waiting = texts.filter((text) => !ready.has(text));
      pump();
    },
    get: (text) => ready.get(text),
    speakStarted() {
      speaking += 1;
    },
    speakEnded() {
      speaking -= 1;
      pump();
    },
    // A new voice configuration makes every prepared line stale.
    clear() {
      generation += 1;
      ready.clear();
      waiting = [];
    },
  };
}

module.exports = { createPreparedSpeech };
