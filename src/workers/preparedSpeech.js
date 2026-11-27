// Short lines the assistant says often (the filler while a tool runs) are synthesized
// ahead of time so they play at once. Preparation runs one line at a time and pauses
// whenever real speech is outstanding, so an answer never waits behind more than the
// line already in progress. Lines are prepared for one speech profile (voice, rate,
// language) at a time: a line asked for in another profile is never served.
function createPreparedSpeech({ synthesize, onError }) {
  const ready = new Map();
  let waiting = [];
  let preparing = false;
  let speaking = 0;
  let generation = 0;
  let profileKey = null;
  let profile = null;

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
    synthesize(text, profile)
      .then((samples) => {
        if (preparedFor === generation) ready.set(text, samples);
      }, onError)
      .finally(() => {
        preparing = false;
        pump();
      });
  };

  const clear = () => {
    generation += 1;
    ready.clear();
    waiting = [];
  };

  return {
    prepare(texts, nextProfile, nextProfileKey) {
      if (nextProfileKey !== profileKey) {
        clear();
        profileKey = nextProfileKey;
        profile = nextProfile;
      }
      waiting = texts.filter((text) => !ready.has(text));
      pump();
    },
    get: (text, key) => (key === profileKey ? ready.get(text) : undefined),
    speakStarted() {
      speaking += 1;
    },
    speakEnded() {
      speaking -= 1;
      pump();
    },
    // A new voice configuration makes every prepared line stale.
    clear() {
      clear();
      profileKey = null;
      profile = null;
    },
  };
}

module.exports = { createPreparedSpeech };
