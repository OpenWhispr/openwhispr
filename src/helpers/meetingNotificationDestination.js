function isMeetingFolderRef(ref) {
  return Boolean(
    ref &&
    Number.isSafeInteger(ref.folderId) &&
    ref.folderId > 0 &&
    Number.isSafeInteger(ref.spaceId) &&
    ref.spaceId > 0
  );
}

function listMeetingDestinations(db) {
  const spaces = db.getSpaces();
  const spaceIds = new Set(spaces.map((space) => space.id));
  const folders = db
    .getFolders()
    .filter((folder) => !folder.left_team && spaceIds.has(folder.space_id));
  const defaultFolder = db.getMeetingsFolder();
  const eligibleDefault = folders.find((folder) => folder.id === defaultFolder?.id);
  return {
    folders,
    spaces,
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
