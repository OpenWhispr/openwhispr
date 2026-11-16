import type React from 'react';
import { Alert, Modal, Pressable, ScrollView, Share, View } from 'react-native';
import { MenuView } from '@react-native-menu/menu';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Text } from '@/components/ui/Text';
import { SystemIcon } from '@/components/ui/SystemIcon';
import { GlassCapsule, GlassIconButton } from '@/components/ui/GlassIconButton';
import { displayFontFamily } from '@/lib/fonts';
import type { TranscriptBlock } from '@/lib/diarization/transcriptDisplay';
import { SpeakerTranscript } from './SpeakerTranscript';

interface TranscriptSheetProps {
  visible: boolean;
  blocks: TranscriptBlock[];
  selectedSpeakerId: number | null;
  shareText: string;
  onSpeakerPress: (block: TranscriptBlock) => void;
  onExport: (format: 'md' | 'txt') => void;
  onClose: () => void;
  /** Sheets opened from a speaker (rename, merge, voiceprint). iOS only presents a modal above
   * this one when it is rendered inside it. */
  children?: React.ReactNode;
}

export function TranscriptSheet({
  visible,
  blocks,
  selectedSpeakerId,
  shareText,
  onSpeakerPress,
  onExport,
  onClose,
  children,
}: TranscriptSheetProps): React.JSX.Element {
  const insets = useSafeAreaInsets();

  const handleShare = async (): Promise<void> => {
    try {
      await Share.share({ message: shareText });
    } catch {
      Alert.alert('Error', 'Unable to share transcript');
    }
  };

  return (
    <Modal
      visible={visible}
      animationType="slide"
      presentationStyle="pageSheet"
      onRequestClose={onClose}
    >
      <View className="flex-1 bg-systemBackground">
        <View className="flex-row items-start justify-between gap-4 px-6 pb-4 pt-8">
          <View className="flex-1">
            <Text
              accessibilityRole="header"
              className="text-[28px] text-label"
              style={{ fontFamily: displayFontFamily }}
            >
              Transcript
            </Text>
            <Text className="mt-1 text-[15px] leading-5 text-secondaryLabel">
              Review, share or export the full transcript.
            </Text>
          </View>
          <View className="flex-row gap-3">
            <MenuView
              actions={[
                { id: 'share', title: 'Share', image: 'square.and.arrow.up' },
                { id: 'export-md', title: 'Export Markdown', image: 'doc.text' },
                { id: 'export-txt', title: 'Export Plain Text', image: 'doc.plaintext' },
              ]}
              onPressAction={({ nativeEvent }) => {
                if (nativeEvent.event === 'share') handleShare().catch(() => {});
                else if (nativeEvent.event === 'export-md') onExport('md');
                else if (nativeEvent.event === 'export-txt') onExport('txt');
              }}
              shouldOpenOnLongPress={false}
            >
              <Pressable
                hitSlop={8}
                accessibilityRole="button"
                accessibilityLabel="Share or export transcript"
                style={({ pressed }) => ({ opacity: pressed ? 0.6 : 1 })}
              >
                <GlassCapsule>
                  <SystemIcon name="square.and.arrow.up" mdName="Share2" size={15} color="label" />
                </GlassCapsule>
              </Pressable>
            </MenuView>
            <GlassIconButton onPress={onClose} accessibilityLabel="Close">
              <SystemIcon name="xmark" mdName="X" size={15} color="secondaryLabel" />
            </GlassIconButton>
          </View>
        </View>

        <ScrollView
          contentContainerClassName="px-6"
          contentContainerStyle={{ paddingBottom: insets.bottom + 24 }}
        >
          <SpeakerTranscript
            blocks={blocks}
            selectedSpeakerId={selectedSpeakerId}
            selectable
            onSpeakerPress={onSpeakerPress}
          />
        </ScrollView>
        {children}
      </View>
    </Modal>
  );
}
