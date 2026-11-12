import { View, type PressableProps } from 'react-native';
import { Text } from '@/components/ui/Text';
import { CloudOff } from 'lucide-react-native';
import { GroupedList } from './GroupedList';
import { SwipeableCard, type RestoreRow } from '@/components/ui/SwipeableCard';
import { SystemIcon } from '@/components/ui/SystemIcon';
import { iosColor, BRAND } from '@/config/colors';
import { formatNoteRowTime } from '@/lib/formatNoteRowTime';
import type { DateBucketKey } from '@/lib/groupNotesByDate';
import type { Note } from '@/data';

export type NoteRowProps = {
  note: Note;
  bucket: DateBucketKey;
  onPress: () => void;
  onLongPress?: () => void;
  onDelete: (restore?: RestoreRow) => void;
  onMove?: () => void;
  /** Match the parent GroupedList's tinted background. */
  tinted?: boolean;
};

type NotePresentation = {
  copy?: (key: string, fallback: string) => string;
  formatTime?: typeof formatNoteRowTime;
  rowAccessibility?: () => Pick<PressableProps, 'accessibilityActions' | 'onAccessibilityAction'>;
};

const defaultCopy = (_key: string, fallback: string) => fallback;

export function createNoteRow(
  usePresentation: (
    props: Pick<NoteRowProps, 'onDelete' | 'onMove'>,
  ) => NotePresentation = () => ({}),
) {
  return function NoteRow({
    note,
    bucket,
    onPress,
    onLongPress,
    onDelete,
    onMove,
    tinted = false,
  }: NoteRowProps) {
    const presentation = usePresentation({ onDelete, onMove });
    const copy = presentation.copy ?? defaultCopy;
    const title = note.title || copy('library.untitled', 'Untitled');
    const preview = (note.content || copy('library.noAdditionalText', 'No additional text'))
      .replace(/\s+/g, ' ')
      .trim();
    const timeLabel = (presentation.formatTime ?? formatNoteRowTime)(note.updatedAt, bucket);

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
          {...presentation.rowAccessibility?.()}
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
  };
}
