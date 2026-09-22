import { Alert, ActivityIndicator, Pressable, useColorScheme } from 'react-native';
import { MenuView, type MenuAction } from '@react-native-menu/menu';
import * as Sentry from '@sentry/react-native';
import { SystemIcon } from '@/components/ui/SystemIcon';
import { GlassCapsule } from '@/components/ui/GlassIconButton';
import { useNotesStore } from '@/store/useNotesStore';
import { safeHaptics } from '@/lib/utils';
import { BRAND } from '@/config/colors';
import type { Action } from '@/data';

interface NoteActionsMenuProps {
  noteId: number;
  actions: Action[];
  hasContent: boolean;
  isRecording: boolean;
  processing: boolean;
  onRunAction: (action: Action) => void;
  onManageActions: () => void;
  onAskNote: () => void;
  askNoteDisabled?: boolean;
  onCopyGeneratedNote?: () => void;
  onCopyTranscript?: () => void;
  onShare: () => void;
  onDelete: () => void;
}

const MANAGE_ID = '__manage';
const ASK_NOTE_ID = '__ask_note';
const COPY_GENERATED_NOTE_ID = '__copy_generated_note';
const COPY_TRANSCRIPT_ID = '__copy_transcript';
const SHARE_ID = '__share';
const PRIVACY_ID = '__privacy';
const DELETE_ID = '__delete';

export function NoteActionsMenu({
  noteId,
  actions,
  hasContent,
  isRecording,
  processing,
  onRunAction,
  onManageActions,
  onAskNote,
  askNoteDisabled = false,
  onCopyGeneratedNote,
  onCopyTranscript,
  onShare,
  onDelete,
}: NoteActionsMenuProps) {
  const isPrivate = useNotesStore((s) => s.notes.find((n) => n.id === noteId)?.isPrivate === 1);
  const setNotePrivacy = useNotesStore((s) => s.setNotePrivacy);

  const scheme = useColorScheme();
  const iconColor = scheme === 'dark' ? 'rgba(255, 255, 255, 0.95)' : 'rgba(0, 0, 0, 0.85)';

  const disabled = isRecording || processing;

  const menuActions: MenuAction[] = [
    ...actions.map((action) => ({
      id: action.id.toString(),
      title: action.name,
      image: 'sparkles',
      imageColor: iconColor,
      attributes: { disabled: !hasContent },
    })),
    {
      id: MANAGE_ID,
      title: 'Manage Actions…',
      image: 'slider.horizontal.3',
      imageColor: iconColor,
    },
    {
      id: ASK_NOTE_ID,
      title: 'Ask about this note',
      image: 'message',
      imageColor: iconColor,
      attributes: { disabled: !hasContent || askNoteDisabled },
    },
    ...(onCopyGeneratedNote
      ? [
          {
            id: COPY_GENERATED_NOTE_ID,
            title: 'Copy Notes',
            image: 'doc.on.doc',
            imageColor: iconColor,
          },
        ]
      : []),
    ...(onCopyTranscript
      ? [
          {
            id: COPY_TRANSCRIPT_ID,
            title: 'Copy Transcript',
            image: 'doc.on.doc',
            imageColor: iconColor,
            attributes: { disabled: !hasContent },
          },
        ]
      : []),
    {
      id: SHARE_ID,
      title: 'Share',
      image: 'square.and.arrow.up',
      imageColor: iconColor,
      attributes: { disabled: !hasContent },
    },
    {
      id: PRIVACY_ID,
      title: isPrivate ? 'Enable Cloud Sync' : 'Disable Cloud Sync',
      image: isPrivate ? 'icloud' : 'icloud.slash',
      imageColor: iconColor,
    },
    {
      id: DELETE_ID,
      title: 'Delete',
      image: 'trash',
      // Hex literal — @react-native-menu/menu's processColor can't serialize
      // PlatformColor/iosColor; passing one collapses to imageColor=0 (transparent).
      imageColor: '#FF3B30',
      attributes: { destructive: true },
    },
  ];

  const handlePress = ({ nativeEvent }: { nativeEvent: { event: string } }) => {
    const id = nativeEvent.event;
    safeHaptics('light');

    if (id === MANAGE_ID) {
      onManageActions();
      return;
    }
    if (id === ASK_NOTE_ID) {
      onAskNote();
      return;
    }
    if (id === COPY_GENERATED_NOTE_ID) {
      onCopyGeneratedNote?.();
      return;
    }
    if (id === COPY_TRANSCRIPT_ID) {
      onCopyTranscript?.();
      return;
    }
    if (id === SHARE_ID) {
      onShare();
      return;
    }
    if (id === PRIVACY_ID) {
      safeHaptics('selection');
      setNotePrivacy(noteId, !isPrivate).catch((err) => {
        Sentry.captureException(err, { tags: { sync: 'setNotePrivacy.toggle' } });
        Alert.alert(
          'Cloud copy removal pending',
          'The note stays private on this device. Its cloud copy could not be removed yet; OpenWhispr will retry when sync is available.',
        );
      });
      return;
    }
    if (id === DELETE_ID) {
      onDelete();
      return;
    }

    const action = actions.find((a) => a.id.toString() === id);
    if (action) onRunAction(action);
  };

  return (
    <MenuView actions={menuActions} onPressAction={handlePress} shouldOpenOnLongPress={false}>
      <Pressable
        disabled={disabled}
        hitSlop={8}
        accessibilityRole="button"
        accessibilityLabel="Note actions"
        style={({ pressed }) => ({ opacity: disabled ? 0.4 : pressed ? 0.6 : 1 })}
      >
        <GlassCapsule>
          {processing ? (
            <ActivityIndicator size="small" color={BRAND} />
          ) : (
            <SystemIcon name="ellipsis" mdName="MoreHorizontal" size={20} color="brand" />
          )}
        </GlassCapsule>
      </Pressable>
    </MenuView>
  );
}
