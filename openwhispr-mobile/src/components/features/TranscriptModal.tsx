import React, { useState } from 'react';
import { View, Modal, ScrollView, Pressable, Share, Alert } from 'react-native';
import { Text } from '@/components/ui/Text';
import * as Clipboard from 'expo-clipboard';
import { Transcript } from '@/types';
import { SystemIcon } from '@/components/ui/SystemIcon';
import { GlassIconButton } from '@/components/ui/GlassIconButton';
import { GradientGlassSurface } from '@/components/ui/GradientGlassSurface';
import { formatRelativeTime, safeHaptics } from '@/lib/utils';

interface TranscriptModalProps {
  transcript: Transcript | null;
  visible: boolean;
  onClose: () => void;
}

export function TranscriptModal({ transcript, visible, onClose }: TranscriptModalProps) {
  const [activeTab, setActiveTab] = useState<'cleaned' | 'original'>('cleaned');

  if (!transcript) return null;

  const hasReasonedText = !!(
    transcript.reasonedText && transcript.reasonedText !== transcript.text
  );
  const displayText =
    hasReasonedText && activeTab === 'original'
      ? (transcript.originalText ?? transcript.text)
      : transcript.text;

  const copyToClipboard = async () => {
    await Clipboard.setStringAsync(displayText);
    safeHaptics('success');
  };

  const shareTranscript = async () => {
    try {
      await Share.share({ message: displayText });
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
      <View className="flex-1" style={{ backgroundColor: 'transparent' }}>
        <View className="flex-row items-center justify-between px-6 pt-12 pb-3">
          <View className="flex-row items-center flex-1">
            <Text className="text-sm text-secondaryLabel">
              {formatRelativeTime(transcript.createdAt, 'short')}
            </Text>
            {transcript.duration ? (
              <View className="ml-2 px-2 py-0.5 bg-tertiarySystemFill rounded">
                <Text className="text-xs text-secondaryLabel">
                  {Math.round(transcript.duration)}s
                </Text>
              </View>
            ) : null}
          </View>
          <GlassIconButton onPress={onClose} accessibilityLabel="Close">
            <SystemIcon name="xmark" mdName="X" size={15} color="secondaryLabel" />
          </GlassIconButton>
        </View>

        {hasReasonedText && (
          <View className="mx-6 mb-2 flex-row bg-tertiarySystemFill rounded-lg p-0.5">
            <Pressable
              onPress={() => setActiveTab('cleaned')}
              className={`flex-1 py-2 rounded-md items-center active:opacity-70 ${
                activeTab === 'cleaned' ? 'bg-systemBackground' : ''
              }`}
            >
              <Text
                className={`text-sm font-medium ${
                  activeTab === 'cleaned' ? 'text-label' : 'text-secondaryLabel'
                }`}
              >
                Cleaned
              </Text>
            </Pressable>
            <Pressable
              onPress={() => setActiveTab('original')}
              className={`flex-1 py-2 rounded-md items-center active:opacity-70 ${
                activeTab === 'original' ? 'bg-systemBackground' : ''
              }`}
            >
              <Text
                className={`text-sm font-medium ${
                  activeTab === 'original' ? 'text-label' : 'text-secondaryLabel'
                }`}
              >
                Original
              </Text>
            </Pressable>
          </View>
        )}

        <ScrollView
          className="flex-1 px-6 pt-4"
          showsVerticalScrollIndicator={false}
          contentInsetAdjustmentBehavior="automatic"
        >
          <Text className="text-lg text-label leading-7 pb-8">{displayText}</Text>
        </ScrollView>

        <View className="px-6 py-4 border-t border-separator flex-row gap-3">
          <Pressable
            onPress={copyToClipboard}
            style={{ borderCurve: 'continuous' }}
            className="relative flex-1 flex-row items-center justify-center py-3 bg-link rounded-lg active:opacity-90"
          >
            <GradientGlassSurface radius={8} />
            <SystemIcon name="doc.on.doc" mdName="Copy" size={18} color="#FFFFFF" />
            <Text className="ml-2 text-sm font-semibold text-white">Copy</Text>
          </Pressable>
          <Pressable
            onPress={shareTranscript}
            className="flex-1 flex-row items-center justify-center py-3 bg-tertiarySystemFill rounded-lg active:opacity-70"
          >
            <SystemIcon name="square.and.arrow.up" mdName="Share2" size={18} color="label" />
            <Text className="ml-2 text-sm font-semibold text-label">Share</Text>
          </Pressable>
        </View>
      </View>
    </Modal>
  );
}
