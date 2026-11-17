// ESM shared by main (require(esm)) and renderer. ipcMain.handle keeps only
// the message of a rejected promise, so handlers resolve with these fields and
// the renderer rebuilds the Error from them.

export const IPC_ERROR_FIELDS = Object.freeze([
  "code",
  "messageKey",
  "messageParams",
  "settingsTarget",
  "technicalDetails",
  "status",
  "surface",
]);

export function ipcErrorFields(error) {
  const fields = { error: error?.message || String(error) };
  for (const key of IPC_ERROR_FIELDS) {
    if (error?.[key] !== undefined) fields[key] = error[key];
  }
  return fields;
}

export function errorFromIpcResult(result) {
  const error = new Error(result?.error || "Request failed");
  for (const key of IPC_ERROR_FIELDS) {
    if (result?.[key] !== undefined) error[key] = result[key];
  }
  return error;
}
