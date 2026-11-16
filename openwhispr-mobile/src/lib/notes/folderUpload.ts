import type { Folder } from '@/data/types';

/**
 * True while a live folder has no cloud id yet but pushFolders will upload it: it only
 * uploads a folder that is queued and has a client id. A note filed in it waits for it,
 * since pushed now it would reach the server unfiled.
 */
export const isFolderAwaitingUpload = (folder: Folder | null | undefined): boolean =>
  !!folder &&
  folder.deletedAt == null &&
  !folder.remoteId &&
  folder.pendingSync === 1 &&
  folder.clientFolderId != null;
