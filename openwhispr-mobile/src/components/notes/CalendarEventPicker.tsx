import type React from 'react';
import { Pressable, StyleSheet, View } from 'react-native';
import { Text } from '@/components/ui/Text';
import { SystemIcon } from '@/components/ui/SystemIcon';
import type { GoogleCalendarAccount, GoogleCalendarEvent } from '@/data/calendarTypes';
import { buildCalendarMeetingContext } from '@/lib/calendar/meetingContext';
import { DEFAULT_MEETING_TITLE } from '@/lib/notes/meetingConstants';
import { cn } from '@/lib/utils';

type CalendarEventPickerProps = {
  events: GoogleCalendarEvent[];
  selectedEventId: number | null;
  accountsById: Map<number, GoogleCalendarAccount>;
  onSelect: (eventId: number | null) => void;
};

const parseEventDate = (value: string): Date | null => {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
};

const isSameDay = (left: Date, right: Date): boolean =>
  left.getFullYear() === right.getFullYear() &&
  left.getMonth() === right.getMonth() &&
  left.getDate() === right.getDate();

const formatEventTime = (event: GoogleCalendarEvent, now = new Date()): string => {
  if (event.allDay === 1) return 'All day';
  const start = parseEventDate(event.startAt);
  if (!start) return 'Time unavailable';
  const tomorrow = new Date(now);
  tomorrow.setDate(now.getDate() + 1);
  const day = isSameDay(start, now)
    ? 'Today'
    : isSameDay(start, tomorrow)
      ? 'Tomorrow'
      : start.toLocaleDateString(undefined, {
          weekday: 'short',
          month: 'short',
          day: 'numeric',
        });
  return `${day} ${start.toLocaleTimeString(undefined, {
    hour: 'numeric',
    minute: '2-digit',
  })}`;
};

type EventRowProps = {
  testID: string;
  selected: boolean;
  iconName: string;
  iconMdName: 'Calendar' | 'AudioLines';
  title: string;
  subtitle: string;
  isFirst: boolean;
  onPress: () => void;
};

const EventRow = ({
  testID,
  selected,
  iconName,
  iconMdName,
  title,
  subtitle,
  isFirst,
  onPress,
}: EventRowProps): React.JSX.Element => (
  <Pressable
    testID={testID}
    accessibilityRole="button"
    accessibilityState={{ selected }}
    onPress={onPress}
    className={cn(
      'flex-row items-center gap-3 px-3.5 py-3 active:opacity-70',
      !isFirst && 'border-t border-separator',
      selected && 'bg-brand/10',
    )}
  >
    <View
      className={cn(
        'h-9 w-9 items-center justify-center rounded-[10px]',
        selected ? 'bg-brand/10' : 'bg-tertiarySystemFill',
      )}
      style={styles.continuous}
    >
      <SystemIcon
        name={iconName}
        mdName={iconMdName}
        size={18}
        color={selected ? 'brand' : 'secondaryLabel'}
      />
    </View>
    <View className="min-w-0 flex-1">
      <Text numberOfLines={1} className="text-[15px] font-semibold text-label">
        {title}
      </Text>
      <Text numberOfLines={1} className="mt-0.5 text-[12.5px] font-medium text-secondaryLabel">
        {subtitle}
      </Text>
    </View>
    <SystemIcon
      name={selected ? 'checkmark.circle.fill' : 'circle'}
      mdName={selected ? 'CircleCheck' : 'Circle'}
      size={22}
      color={selected ? 'brand' : 'tertiaryLabel'}
    />
  </Pressable>
);

export const CalendarEventPicker = ({
  events,
  selectedEventId,
  accountsById,
  onSelect,
}: CalendarEventPickerProps): React.JSX.Element | null => {
  if (events.length === 0) return null;

  return (
    <View>
      <Text className="mb-2 text-[13px] font-semibold uppercase tracking-wider text-secondaryLabel">
        Calendar event
      </Text>
      <View
        className="overflow-hidden rounded-[16px] border border-separator bg-secondarySystemGroupedBackground"
        style={styles.continuous}
      >
        <EventRow
          testID="calendar-event-none"
          selected={selectedEventId === null}
          iconName="waveform"
          iconMdName="AudioLines"
          title="No event"
          subtitle="Just record this audio"
          isFirst
          onPress={() => onSelect(null)}
        />
        {events.map((event) => {
          const selected = selectedEventId === event.id;
          const context = buildCalendarMeetingContext(event, accountsById.get(event.accountId));
          const title = event.summary?.trim() || DEFAULT_MEETING_TITLE;
          const countLabel =
            context.suggestedSpeakerCount != null
              ? `${context.suggestedSpeakerCount} ${
                  context.suggestedSpeakerCount === 1 ? 'person' : 'people'
                }`
              : null;

          return (
            <EventRow
              key={event.id}
              testID={`calendar-event-${event.id}`}
              selected={selected}
              iconName="calendar"
              iconMdName="Calendar"
              title={title}
              subtitle={
                countLabel ? `${formatEventTime(event)} · ${countLabel}` : formatEventTime(event)
              }
              isFirst={false}
              onPress={() => onSelect(event.id)}
            />
          );
        })}
      </View>
    </View>
  );
};

const styles = StyleSheet.create({
  continuous: {
    borderCurve: 'continuous',
  },
});
