// Kick the matching cloud push once a local write has landed in SQLite. The backup check is a
// cheap first canSync(), and keeps the import out of a context with no localStorage (tests).
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
