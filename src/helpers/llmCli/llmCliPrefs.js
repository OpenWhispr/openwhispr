// Non-secret CLI-seat preferences, owned by main so the Claude gate cannot be
// bypassed from the renderer. Only the keys in SCHEMA are accepted.
const nodeFs = require("fs");

const SCHEMA = Object.freeze({ claudeEnabled: "boolean" });
const DEFAULTS = Object.freeze({ claudeEnabled: false });

function createPrefs({ fs = nodeFs, file, log = () => {} } = {}) {
  if (typeof file !== "string" || file.length === 0) throw new Error("file is required");

  function read() {
    try {
      const parsed = JSON.parse(fs.readFileSync(file, "utf8"));
      const out = { ...DEFAULTS };
      for (const [key, type] of Object.entries(SCHEMA)) {
        if (typeof parsed?.[key] === type) out[key] = parsed[key];
      }
      return out;
    } catch {
      return { ...DEFAULTS };
    }
  }

  return {
    get: read,
    // Returns the new prefs, or null when the key or value type is not allowed.
    set(key, value) {
      if (!Object.prototype.hasOwnProperty.call(SCHEMA, key) || typeof value !== SCHEMA[key]) {
        return null;
      }
      const next = { ...read(), [key]: value };
      try {
        fs.writeFileSync(file, JSON.stringify(next));
      } catch (error) {
        log("llm-cli prefs write failed", error && error.code);
        return null;
      }
      return next;
    },
  };
}

module.exports = { createPrefs, DEFAULTS };
