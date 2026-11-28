// The release the user skipped from the sidebar's update button, kept in
// localStorage like the GPU banner's dismissal. Only that version is hidden: a
// newer release brings the button back, and Settings still offers the skipped
// one to anyone who checks there.
export const SKIPPED_UPDATE_VERSION_KEY = "skippedUpdateVersion";

export interface SidebarUpdateState {
  updateAvailable: boolean;
  updateDownloaded: boolean;
  isDownloading: boolean;
  isInstalling: boolean;
  version?: string | null;
}

// A download the user started, or one automatic updates finished, is past
// skipping: the button then shows its progress or the install.
export function canSkipUpdate(state: SidebarUpdateState): boolean {
  return (
    Boolean(state.version) &&
    state.updateAvailable &&
    !state.updateDownloaded &&
    !state.isDownloading &&
    !state.isInstalling
  );
}

export function isUpdateSkipped(
  state: SidebarUpdateState,
  skippedVersion: string | null | undefined
): boolean {
  return canSkipUpdate(state) && state.version === skippedVersion;
}
