// App-update policy, kept free of Electron so it can be unit-tested.
//
// One predicate backs both update gates in updater.js so they cannot drift:
// the automatic checks (startup timer, periodic timer) and the update-available
// popup. The "App updates" toggle (notifyUpdates) gates the checks themselves,
// not just the notification they produce: with the toggle off the app must not
// reach out to the update feed, and a background check that never runs can
// never surface a connection error dialog on offline or firewalled machines
// (#1605). A manual "Check for updates" from Settings is an explicit user
// action and is never gated here.
//
// Same tri-state convention as the other notification prefs: only an explicit
// false disables. An empty or partial prefs object (renderer sync not arrived
// yet) keeps today's check-by-default behavior.
function appUpdatesEnabled({ notificationsEnabled, notifyUpdates } = {}) {
  return notificationsEnabled !== false && notifyUpdates !== false;
}

module.exports = { appUpdatesEnabled };
