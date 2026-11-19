import { router } from 'expo-router';
import { useNotesStore } from '@/store/useNotesStore';
import { safeHaptics } from '@/lib/utils';

/** Write a note: a new note in the folder the user is in, opened with the keyboard up. */
export function startNote(folderId: number | undefined) {
  safeHaptics('light');
  const note = useNotesStore.getState().createNote(undefined, undefined, folderId);
  router.push({ pathname: '/(tabs)/(notes)/[id]', params: { id: String(note.id), fresh: '1' } });
}

type Place = { folderId?: number; spaceId?: number };

function placeParams(place: Place): Record<string, string> {
  const params: Record<string, string> = {};
  if (place.folderId != null) params.folderId = String(place.folderId);
  else if (place.spaceId != null) params.spaceId = String(place.spaceId);
  return params;
}

/** Upload audio: the system file picker, then the new note with progress inside it. */
export function startUpload(place: Place) {
  safeHaptics('light');
  router.push({ pathname: '/(tabs)/(notes)/import-audio', params: placeParams(place) });
}

/** Record a meeting: the start sheet's choices are carried to the recorder, which starts at once. */
export function startMeeting(place: Place & { eventId?: number; autostart?: boolean }) {
  safeHaptics('light');
  const params = placeParams(place);
  if (place.eventId != null) params.eventId = String(place.eventId);
  if (place.autostart) params.autostart = '1';
  router.push({ pathname: '/(tabs)/(notes)/meeting-record', params });
}
