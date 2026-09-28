import type React from 'react';
import { Modal, ScrollView, View } from 'react-native';
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

export function AttendeesSheet({
  visible,
  participants,
  onClose,
}: AttendeesSheetProps): React.JSX.Element {
  const insets = useSafeAreaInsets();
  const people = sortAttendees(participants);

  return (
    <Modal
      visible={visible}
      animationType="slide"
      presentationStyle="pageSheet"
      onRequestClose={onClose}
    >
      <View className="flex-1 bg-systemBackground">
        <View className="flex-row items-center justify-between px-6 pb-4 pt-8">
          <Text accessibilityRole="header" className="text-[22px] font-bold text-label">
            Attendees
          </Text>
          <GlassIconButton onPress={onClose} accessibilityLabel="Close">
            <SystemIcon name="xmark" mdName="X" size={15} color="secondaryLabel" />
          </GlassIconButton>
        </View>
        <ScrollView
          contentContainerClassName="px-6"
          contentContainerStyle={{ paddingBottom: insets.bottom + 24 }}
        >
          <GroupedList>
            {people.map((participant, index) => {
              const name = attendeeName(participant);
              const showEmail = !!participant.email && participant.email !== name;
              return (
                <GroupedList.Row
                  key={participant.email ?? `${name}-${index}`}
                  contentInsetLeft={16}
                >
                  <View testID={`attendee-row-${index}`} className="flex-1 py-1">
                    <View className="flex-row items-center gap-2">
                      <Text className="text-[17px] text-label">{name}</Text>
                      {participant.organizer ? (
                        <Text className="text-[12px] font-medium text-secondaryLabel">
                          Organizer
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
}
