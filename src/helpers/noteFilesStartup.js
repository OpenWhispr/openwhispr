// The control panel used to be the only caller. A tray or login launch never
// creates that window, so the saved setting has to be requested from the
// renderer entry both windows load. skipRebuild still reconciles, which writes
// a note that has no file yet and does not rewrite every note.
function requestSavedNoteFiles(settings, api) {
  if (!settings?.noteFilesEnabled) return false;
  const call = api?.noteFilesSetEnabled;
  if (typeof call !== "function") return false;
  call(true, settings.noteFilesPath || undefined, { skipRebuild: true });
  return true;
}

module.exports = { requestSavedNoteFiles };
