// Automatic update-check decisions, kept free of Electron so they can be
// unit-tested.
//
// The "App updates" toggle (notifyUpdates) gates the automatic checks
// themselves, not just the notification they produce: with the toggle off the
// app must not reach out to the update feed at startup or on the periodic
// timer, and a background check that never runs can never surface a connection
// error dialog on offline or firewalled machines (#1605). A manual "Check for
// updates" from Settings is an explicit user action and is never gated here.
//
// Prefs default to enabled: an empty or partial prefs object (renderer sync
// not arrived yet) keeps today's check-by-default behavior.
function shouldAutoCheckForUpdates(prefs) {
  const p = prefs || {};
  return p.notificationsEnabled !== false && p.notifyUpdates !== false;
}

module.exports = { shouldAutoCheckForUpdates };
