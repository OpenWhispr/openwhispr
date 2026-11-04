import type { TOptions } from 'i18next';
import type React from 'react';
import { Modal, ScrollView, View, type ViewStyle } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Text } from '@/components/ui/Text';
import { SystemIcon } from '@/components/ui/SystemIcon';
import { GlassIconButton } from '@/components/ui/GlassIconButton';
import type { CalendarParticipant } from '@/data/calendarTypes';
import { attendeeName, sortAttendees } from '@/lib/notes/noteMeta';
import { GroupedList } from './GroupedList';

interface AttendeesSheetProps {
  visible: boolean;
  participants: CalendarParticipant[];
  onClose: () => void;
}

type AttendeesPresentation = {
  copy?: (key: string, fallback: string, options?: TOptions) => string;
  name?: typeof attendeeName;
  headerStyle?: (top: number) => ViewStyle;
  headerClassName?: string;
  personClassName?: string;
};

const defaultCopy = (_key: string, fallback: string) => fallback;

export function createAttendeesSheet(usePresentation: () => AttendeesPresentation = () => ({})) {
  return function AttendeesSheet({
    visible,
    participants,
    onClose,
  }: AttendeesSheetProps): React.JSX.Element {
    const insets = useSafeAreaInsets();
    const presentation = usePresentation();
    const copy = presentation.copy ?? defaultCopy;
    const people = sortAttendees(participants);

    return (
      <Modal
        visible={visible}
        animationType="slide"
        presentationStyle="pageSheet"
        onRequestClose={onClose}
      >
        <View className="flex-1 bg-systemBackground">
          <View
            className="flex-row items-center justify-between px-6 pb-4 pt-8"
            style={presentation.headerStyle?.(insets.top)}
          >
            <Text
              accessibilityRole="header"
              className={presentation.headerClassName ?? 'text-[22px] font-bold text-label'}
            >
              {copy('noteDetails.attendees', 'Attendees')}
            </Text>
            <GlassIconButton onPress={onClose} accessibilityLabel={copy('close', 'Close')}>
              <SystemIcon name="xmark" mdName="X" size={15} color="secondaryLabel" />
            </GlassIconButton>
          </View>
          <ScrollView
            contentContainerClassName="px-6"
            contentContainerStyle={{ paddingBottom: insets.bottom + 24 }}
          >
            <GroupedList>
              {people.map((participant, index) => {
                const name = (presentation.name ?? attendeeName)(participant);
                const showEmail = !!participant.email && participant.email !== name;
                return (
                  <GroupedList.Row
                    key={participant.email ?? `${name}-${index}`}
                    contentInsetLeft={16}
                  >
                    <View testID={`attendee-row-${index}`} className="flex-1 py-1">
                      <View
                        className={presentation.personClassName ?? 'flex-row items-center gap-2'}
                      >
                        <Text className="text-[17px] text-label">{name}</Text>
                        {participant.organizer ? (
                          <Text className="text-[12px] font-medium text-secondaryLabel">
                            {copy('noteDetails.organizer', 'Organizer')}
                          </Text>
                        ) : null}
                      </View>
                      {showEmail ? (
                        <Text className="text-[13px] text-secondaryLabel">{participant.email}</Text>
                      ) : null}
                    </View>
                  </GroupedList.Row>
                );
              })}
            </GroupedList>
          </ScrollView>
        </View>
      </Modal>
    );
  };
}
