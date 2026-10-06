import type React from 'react';
import { Pressable, View } from 'react-native';
import { Text } from '@/components/ui/Text';
import { SystemIcon } from '@/components/ui/SystemIcon';

interface NoteMetaRowProps {
  dateLabel: string;
  attendeeLabel: string | null;
  folderLabel: string | null;
  onPressAttendees: () => void;
  /** Omitted when the note can't be moved; the folder chip is then hidden. */
  onPressFolder?: () => void;
}

const CHIP = 'h-9 max-w-full flex-row items-center gap-1.5 rounded-full bg-tertiarySystemFill px-3';

/** The row under a note's title: when it was taken, who attended, and where it lives. */
export function NoteMetaRow({
  dateLabel,
  attendeeLabel,
  folderLabel,
  onPressAttendees,
  onPressFolder,
}: NoteMetaRowProps): React.JSX.Element {
  return (
    <View className="mb-4 flex-row flex-wrap items-center gap-2">
      {dateLabel || attendeeLabel ? (
        <View className={CHIP} style={{ borderCurve: 'continuous' }}>
          {dateLabel ? (
            <Text className="text-[14px] font-medium text-secondaryLabel">{dateLabel}</Text>
          ) : null}
          {attendeeLabel ? (
            <Pressable
              testID="note-meta-attendees"
              accessibilityRole="button"
              accessibilityLabel={`Attendees: ${attendeeLabel}`}
              hitSlop={6}
              onPress={onPressAttendees}
              className="shrink flex-row items-center gap-1.5"
            >
              {dateLabel ? <Text className="text-[14px] text-tertiaryLabel">·</Text> : null}
              <SystemIcon name="person.2" mdName="Users" size={14} color="secondaryLabel" />
              <Text
                numberOfLines={1}
                // A long name gives way in the middle, so the "+3" count stays visible.
                ellipsizeMode="middle"
                className="shrink text-[14px] font-medium text-secondaryLabel"
              >
                {attendeeLabel}
              </Text>
            </Pressable>
          ) : null}
        </View>
      ) : null}
      {onPressFolder ? (
        <Pressable
          testID="note-meta-folder"
          accessibilityRole="button"
          accessibilityLabel={folderLabel ? `Folder: ${folderLabel}. Move note` : 'Add to folder'}
          onPress={onPressFolder}
          className={CHIP}
          style={{ borderCurve: 'continuous' }}
        >
          <SystemIcon
            name={folderLabel ? 'folder' : 'folder.badge.plus'}
            mdName={folderLabel ? 'Folder' : 'FolderPlus'}
            size={14}
            color="secondaryLabel"
          />
          <Text numberOfLines={1} className="shrink text-[14px] font-medium text-secondaryLabel">
            {folderLabel ?? 'Add to folder'}
          </Text>
        </Pressable>
      ) : null}
    </View>
  );
}
