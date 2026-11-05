// Kick the matching cloud push once a local write has landed in SQLite. Only a pass with
// Cloud backup on pushes anything, so the service isn't loaded while it's off.
export function syncAfterLocalWrite(
  method: "syncDictionaryNow" | "syncSnippetsNow" | "syncSkillsNow"
): void {
  if (
    typeof localStorage === "undefined" ||
    localStorage.getItem("cloudBackupEnabled") !== "true"
  ) {
    return;
  }
  void import("./SyncService.js").then(({ syncService }) => {
    if (syncService.canSync()) void syncService[method]();
  });
}
