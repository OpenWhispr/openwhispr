import React, { useState } from 'react';
import { router } from 'expo-router';
import type { GoogleCalendarEvent } from '@/data/calendarTypes';
import { useNotesStore } from '@/store/useNotesStore';
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
  const [needsModel, setNeedsModel] = useState(false);
  return {
    open(preferred?: GoogleCalendarEvent | null) {
      const local = meetingOnDevice();
      setOnDevice(local);
      setNeedsModel(false);
      if (local)
        useNotesStore
          .getState()
          .isLocalAsrModelReady()
          .then((ready) => setNeedsModel(!ready))
          .catch(() => setNeedsModel(false));
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
        needsModel={needsModel}
        now={now}
        onChange={() => {
          setVisible(false);
          router.push('/(account)/ai-models');
        }}
        onStart={() => {
          setVisible(false);
          startMeeting({ ...place, eventId: event?.id, autostart: true });
        }}
      />
    ),
  };
}
