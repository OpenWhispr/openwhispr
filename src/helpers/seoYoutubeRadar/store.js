const fs = require("fs");
const path = require("path");
const { normalizeRadarConfig } = require("./scoring");

const EMPTY_STATE = Object.freeze({
  config: {},
  videos: {},
  runs: [],
});

function cloneState(data) {
  return {
    config: { ...(data?.config || {}) },
    videos: { ...(data?.videos || {}) },
    runs: Array.isArray(data?.runs) ? [...data.runs] : [],
  };
}

function readJsonFile(filePath) {
  try {
    if (!fs.existsSync(filePath)) return cloneState(EMPTY_STATE);
    const parsed = JSON.parse(fs.readFileSync(filePath, "utf8"));
    return cloneState(parsed);
  } catch {
    return cloneState(EMPTY_STATE);
  }
}

function writeJsonAtomic(filePath, data) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const tmpPath = `${filePath}.tmp`;
  fs.writeFileSync(tmpPath, JSON.stringify(data, null, 2), "utf8");
  fs.renameSync(tmpPath, filePath);
}

function createSeoYoutubeRadarStore({ filePath }) {
  if (!filePath) throw new Error("SEO YouTube Radar store filePath is required");

  const load = () => readJsonFile(filePath);
  const save = (data) => {
    const state = cloneState(data);
    writeJsonAtomic(filePath, state);
    return state;
  };

  return {
    load,
    save,

    getConfig() {
      return normalizeRadarConfig(load().config);
    },

    setConfig(config = {}) {
      const state = load();
      state.config = normalizeRadarConfig({ ...state.config, ...config });
      save(state);
      return state.config;
    },

    markVideo(videoId, status, meta = {}) {
      if (!videoId) return;
      const state = load();
      state.videos[videoId] = {
        ...(state.videos[videoId] || {}),
        ...meta,
        status,
        updatedAt: new Date().toISOString(),
      };
      save(state);
    },

    hasProcessed(videoId) {
      const entry = load().videos[videoId];
      return entry?.status === "processed";
    },

    appendRun(run) {
      const state = load();
      state.runs.unshift({ ...run, createdAt: run.createdAt || new Date().toISOString() });
      state.runs = state.runs.slice(0, 30);
      save(state);
    },
  };
}

module.exports = {
  createSeoYoutubeRadarStore,
};
