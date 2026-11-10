function isMeetingFolderRef(ref) {
  return Boolean(
    ref &&
    Number.isSafeInteger(ref.folderId) &&
    ref.folderId > 0 &&
    Number.isSafeInteger(ref.spaceId) &&
    ref.spaceId > 0
  );
}

// The spaces a meeting can go to: the active workspace's, as its notes tree shows them. That's its
// own Private (getSpaces lists the account's Private of every workspace) and its teamspaces. Main
// knows the active workspace but not the list, so a teamspace shows when it's that workspace's or
// no workspace's (legacy rows), or when no workspace is active yet.
function spacesInActiveWorkspace(db, spaces, privateSpaceId) {
  const activeWorkspaceId = db.activeWorkspaceId ?? null;
  return spaces.filter((space) =>
    space.kind === "private"
      ? space.id === privateSpaceId
      : activeWorkspaceId == null ||
        space.workspace_id == null ||
        space.workspace_id === activeWorkspaceId
  );
}

function listMeetingDestinations(db) {
  const allSpaces = db.getSpaces();
  // Where new meetings and new folders go unless the user picks another space.
  const privateSpaceId = db.getPrivateSpaceId();
  const spaces = spacesInActiveWorkspace(db, allSpaces, privateSpaceId);
  const spaceIds = new Set(spaces.map((space) => space.id));
  // First: a private space gets its Meetings folder the first time it's asked
  // for, and the list below must include it.
  const defaultFolder = db.getMeetingsFolder();
  const folders = db
    .getFolders()
    .filter((folder) => !folder.left_team && spaceIds.has(folder.space_id));
  const eligibleDefault = folders.find((folder) => folder.id === defaultFolder?.id);
  return {
    folders,
    spaces,
    privateSpaceId: spaceIds.has(privateSpaceId) ? privateSpaceId : null,
    defaultDestination: eligibleDefault
      ? { folderId: eligibleDefault.id, spaceId: eligibleDefault.space_id }
      : null,
  };
}

function resolveMeetingDestination(db, ref) {
  if (!isMeetingFolderRef(ref) || !db.getSpace(ref.spaceId)) return null;
  return (
    db.getFolders(ref.spaceId).find((folder) => folder.id === ref.folderId && !folder.left_team) ||
    null
  );
}

function rememberMeetingDestination(recent, ref) {
  return [
    { ...ref },
    ...recent.filter((item) => item.folderId !== ref.folderId || item.spaceId !== ref.spaceId),
  ].slice(0, 5);
}

function pruneMeetingDestinations(recent, folders) {
  return recent.filter((ref) =>
    folders.some((folder) => folder.id === ref.folderId && folder.space_id === ref.spaceId)
  );
}

function notificationCalendarEventId(owner) {
  const event = owner.detection.event;
  return event?.calendar_id && !["__detected__", "__manual__"].includes(event.calendar_id)
    ? event.id
    : null;
}

function describeMeetingNote(db, note) {
  if (!note || note.deleted_at || note.left_team) return null;
  const space = db.getSpace(note.space_id);
  if (!space) return null;
  const folder =
    note.folder_id == null
      ? null
      : resolveMeetingDestination(db, { folderId: note.folder_id, spaceId: note.space_id });
  if (note.folder_id != null && !folder) return null;
  return {
    noteId: note.id,
    spaceId: space.id,
    folderId: folder?.id ?? null,
    spaceName: space.name,
    folderName: folder?.name ?? null,
    shared: space.kind === "team",
  };
}

function meetingDestinationContext(db, owner, recent) {
  const context = listMeetingDestinations(db);
  const eventId = notificationCalendarEventId(owner);
  const note = owner.committedNoteId
    ? db.getNote(owner.committedNoteId)
    : eventId
      ? db.getOwnNoteByCalendarEventId(eventId, { throwOnError: true })
      : null;
  const existingNote = describeMeetingNote(db, note);
  if ((note || owner.committedNoteId) && !existingNote)
    throw Object.assign(new Error("Note unavailable"), { code: "NOTE_UNAVAILABLE" });
  return {
    ...context,
    selectedDestination: owner.selectedDestination,
    recentDestinations: pruneMeetingDestinations(recent, context.folders),
    existingNote,
  };
}

module.exports = {
  isMeetingFolderRef,
  listMeetingDestinations,
  resolveMeetingDestination,
  rememberMeetingDestination,
  pruneMeetingDestinations,
  notificationCalendarEventId,
  describeMeetingNote,
  meetingDestinationContext,
};
