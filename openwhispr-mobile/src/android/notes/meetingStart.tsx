import React, { useState } from 'react';
import { router } from 'expo-router';
import type { GoogleCalendarEvent } from '@/data/calendarTypes';
import { useNotesStore } from '@/android/store/useNotesStore';
import { meetingOnDevice } from '../meetingRouting';
import { StartSheet } from './sheets';
import { startMeeting } from './start';
import { useTodayMeetings } from './calendar';

/**
 * R0 from any Notes screen: "Record a meeting" opens the Start sheet; Start recording goes to
 * the recorder, which starts at once in the folder (or space) the user was in.
 */
export function useMeetingStart(place: { folderId?: number; spaceId?: number }) {
  const { events, now } = useTodayMeetings();
  const [visible, setVisible] = useState(false);
  const [event, setEvent] = useState<GoogleCalendarEvent | null>(null);
  const [onDevice, setOnDevice] = useState(false);
  const [keyName, setKeyName] = useState<string | null>(null);
  const [needsModel, setNeedsModel] = useState(false);
  const checkModel = () =>
    useNotesStore
      .getState()
      .isLocalAsrModelReady()
      .then((ready) => setNeedsModel(!ready))
      .catch(() => setNeedsModel(false));
  return {
    open(preferred?: GoogleCalendarEvent | null) {
      const local = meetingOnDevice();
      setOnDevice(local);
      // Named as Settings → Processing → Meetings names it, since that key is what records.
      const { meetingKey } =
        require('../providers/liveMeeting') as typeof import('../providers/liveMeeting');
      const { KEY_PROVIDERS } =
        require('../settings/ownKey') as typeof import('../settings/ownKey');
      const key = local ? null : meetingKey();
      setKeyName(
        key ? (KEY_PROVIDERS.find(({ id }) => id === key.providerId)?.name ?? null) : null,
      );
      setNeedsModel(false);
      if (local) void checkModel();
      // A meeting under way or within the hour is the likely one; otherwise none.
      setEvent(
        preferred !== undefined
          ? preferred
          : (events.find((value) => Date.parse(value.startAt) - now <= 60 * 60 * 1000) ?? null),
      );
      setVisible(true);
    },
    sheet: (
      <StartSheet
        visible={visible}
        onClose={() => setVisible(false)}
        events={events}
        event={event}
        onPickEvent={setEvent}
        onDevice={onDevice}
        keyName={keyName}
        needsModel={needsModel}
        now={now}
        onChange={() => {
          setVisible(false);
          router.push('/(account)/ai-models');
        }}
        onModelsChanged={() => void checkModel()}
        onStart={() => {
          setVisible(false);
          startMeeting({ ...place, eventId: event?.id, autostart: true });
        }}
      />
    ),
  };
}
