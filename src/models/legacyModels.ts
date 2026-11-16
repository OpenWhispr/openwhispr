/**
 * A legacy model stays in the registry so a selection made before it was
 * superseded keeps working, but pickers only list it while it is that
 * selection — or, for a local model, while its file is still on disk to be
 * deleted. Once the user moves off it, it is never offered again.
 */
export function isListedModel(
  model: { legacy?: boolean },
  isSelected: boolean,
  isDownloaded = false
): boolean {
  return !model.legacy || isSelected || isDownloaded;
}
