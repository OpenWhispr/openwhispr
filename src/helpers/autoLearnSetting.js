/**
 * Pure resolver for the "auto-learn-changed" IPC sync.
 *
 * Every renderer window syncs its auto-learn preference to the main process on
 * mount (see `useSettings.ts`). With the dual-window architecture (main overlay
 * + control panel) the main process therefore receives the same value more than
 * once at startup. Returning `changed: false` for a repeated value lets the
 * handler skip redundant work and the duplicate "[AutoLearn] Setting changed"
 * log reported in #1080.
 *
 * @param {boolean} current - the main process's current auto-learn state
 * @param {*} incoming - the raw value received over IPC (coerced to boolean)
 * @returns {{ changed: boolean, enabled: boolean }}
 */
function applyAutoLearnSetting(current, incoming) {
  const enabled = !!incoming;
  return { changed: enabled !== !!current, enabled };
}

module.exports = { applyAutoLearnSetting };
