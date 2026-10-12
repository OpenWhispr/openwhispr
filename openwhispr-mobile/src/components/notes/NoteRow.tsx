import { View } from 'react-native';
import { Text } from '@/components/ui/Text';
import { CloudOff } from 'lucide-react-native';
import { GroupedList } from './GroupedList';
import { SwipeableCard } from '@/components/ui/SwipeableCard';
import { SystemIcon } from '@/components/ui/SystemIcon';
import { iosColor, BRAND } from '@/config/colors';
import { formatNoteRowTime } from '@/lib/formatNoteRowTime';
import type { DateBucketKey } from '@/lib/groupNotesByDate';
import type { Note } from '@/data';

type NoteRowProps = {
  note: Note;
  bucket: DateBucketKey;
  onPress: () => void;
  onLongPress?: () => void;
  onDelete: () => void;
  onMove?: () => void;
  /** Match the parent GroupedList's tinted background. */
  tinted?: boolean;
};

export function NoteRow({
  note,
  bucket,
  onPress,
  onLongPress,
  onDelete,
  onMove,
  tinted = false,
}: NoteRowProps) {
  const title = note.title || 'Untitled';
  const preview = (note.content || 'No additional text').replace(/\s+/g, ' ').trim();
  const timeLabel = formatNoteRowTime(note.updatedAt, bucket);

  return (
    <SwipeableCard
      onDelete={onDelete}
      onMove={onMove}
      inset
      cardBackground={tinted ? iosColor('systemBackground') : undefined}
    >
      <GroupedList.Row
        onPress={onPress}
        onLongPress={onLongPress}
        accessibilityRole="button"
        accessibilityLabel={`${title}, ${timeLabel}, ${preview}`}
        contentInsetLeft={16}
      >
        <View className="gap-0.5">
          <View className="flex-row items-center gap-1.5">
            <View className="min-w-0 flex-1 flex-row items-center gap-1.5">
              {note.noteType === 'meeting' && (
                <SystemIcon name="person.2" mdName="Users" size={14} color="secondaryLabel" />
              )}
              {note.noteType === 'upload' && (
                <SystemIcon
                  name="waveform"
                  mdName="AudioWaveform"
                  size={14}
                  color="secondaryLabel"
                />
              )}
              <Text className="flex-1 text-[16px] font-semibold text-label" numberOfLines={1}>
                {title}
              </Text>
            </View>
            {note.isPrivate === 1 && (
              <View className="shrink-0">
                <CloudOff size={14} color={BRAND} strokeWidth={2} />
              </View>
            )}
          </View>
          <Text className="text-[13px] text-secondaryLabel" numberOfLines={1}>
            <Text className="font-semibold text-secondaryLabel">{timeLabel}</Text>
            {timeLabel ? '  ' : ''}
            {preview}
          </Text>
        </View>
      </GroupedList.Row>
    </SwipeableCard>
  );
}
