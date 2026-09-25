import React, { useState } from 'react';
import { Modal, Pressable, ScrollView, StyleSheet, View } from 'react-native';
import { GroupedList } from '@/components/notes/GroupedList';
import { GlassIconButton } from '@/components/ui/GlassIconButton';
import { SearchField } from '@/components/ui/SearchField';
import { SystemIcon } from '@/components/ui/SystemIcon';
import { Text } from '@/components/ui/Text';
import {
  languageByCode,
  localModelLanguages,
  LOCAL_MODEL_TITLES,
  type LocalModelKey,
} from '@/lib/localModelCatalog';
import { getPreferredTranscriptionLanguages } from '@/lib/transcriptionLanguage';
import { localModelCoversLanguages } from '@/services/transcription/localEngine';

// Long enough that finding one language by scrolling is a chore.
const SEARCH_THRESHOLD = 30;

function SectionTitle({ children }: { children: string }): React.JSX.Element {
  return (
    <Text className="px-1 text-[13px] uppercase tracking-wider text-secondaryLabel">
      {children}
    </Text>
  );
}

function Flag({ flag }: { flag: string }): React.JSX.Element {
  return <Text className="text-[20px]">{flag}</Text>;
}

function ModelLanguagesSheet({
  model,
  onClose,
}: {
  model: LocalModelKey;
  onClose: () => void;
}): React.JSX.Element {
  const [query, setQuery] = useState('');
  const title = LOCAL_MODEL_TITLES[model];
  const languages = localModelLanguages(model);
  const yours = getPreferredTranscriptionLanguages().map(languageByCode);
  const searchable = languages.length > SEARCH_THRESHOLD;
  const needle = query.trim().toLowerCase();
  const shown = needle
    ? languages.filter((language) => language.label.toLowerCase().includes(needle))
    : languages;

  return (
    <Modal visible animationType="slide" presentationStyle="pageSheet" onRequestClose={onClose}>
      <View className="flex-1 bg-systemBackground">
        <View className="flex-row items-center justify-between px-6 pb-4 pt-8">
          <Text className="text-[22px] font-bold text-label">{`${title} Languages`}</Text>
          <GlassIconButton onPress={onClose} accessibilityLabel="Close">
            <SystemIcon name="xmark" mdName="X" size={15} color="secondaryLabel" />
          </GlassIconButton>
        </View>
        <ScrollView contentContainerStyle={styles.content} keyboardShouldPersistTaps="handled">
          {yours.length ? (
            <View className="gap-2">
              <SectionTitle>{yours.length > 1 ? 'Your Languages' : 'Your Language'}</SectionTitle>
              <GroupedList>
                {yours.map((language) => {
                  const supported = localModelCoversLanguages(model, [language.code]);
                  return (
                    <GroupedList.Row
                      key={language.code}
                      leadingIconSlot={<Flag flag={language.flag} />}
                      accessibilityLabel={`${language.label}, ${supported ? 'supported' : 'not supported'}`}
                    >
                      <View className="flex-row items-center justify-between gap-3">
                        <Text className="text-[17px] text-label">{language.label}</Text>
                        {supported ? (
                          <SystemIcon
                            name="checkmark.circle.fill"
                            mdName="CircleCheck"
                            size={18}
                            color="systemGreen"
                          />
                        ) : (
                          <Text className="text-[15px] text-secondaryLabel">Not supported</Text>
                        )}
                      </View>
                    </GroupedList.Row>
                  );
                })}
              </GroupedList>
            </View>
          ) : null}
          <View className="gap-2">
            <SectionTitle>{`All ${languages.length} Languages`}</SectionTitle>
            {searchable ? (
              <View className="flex-row">
                <SearchField
                  value={query}
                  onChangeText={setQuery}
                  placeholder="Search languages"
                  accessibilityLabel="Search languages"
                  returnKeyType="done"
                />
              </View>
            ) : null}
            {shown.length ? (
              <GroupedList>
                {shown.map((language) => (
                  <GroupedList.Row
                    key={language.code}
                    leadingIconSlot={<Flag flag={language.flag} />}
                  >
                    <Text className="text-[17px] text-label">{language.label}</Text>
                  </GroupedList.Row>
                ))}
              </GroupedList>
            ) : (
              <Text className="px-1 text-[15px] text-secondaryLabel">No matching languages.</Text>
            )}
            {model === 'whisper-base' ? (
              <Text className="px-1 text-[13px] text-secondaryLabel">
                Whisper base also detects the spoken language automatically, including many
                languages not listed here.
              </Text>
            ) : null}
          </View>
        </ScrollView>
      </View>
    </Modal>
  );
}

// A small "?" beside a model's language note that lists the languages it covers.
export function ModelLanguagesButton({
  model,
}: {
  model: LocalModelKey;
}): React.JSX.Element | null {
  const [open, setOpen] = useState(false);
  const bases = new Set(localModelLanguages(model).map(({ code }) => code.split('-')[0]));
  // A single-language model says so in its note already.
  if (bases.size < 2) return null;
  return (
    <>
      <Pressable
        hitSlop={10}
        accessibilityRole="button"
        accessibilityLabel={`${LOCAL_MODEL_TITLES[model]} languages`}
        onPress={() => setOpen(true)}
        style={({ pressed }) => ({ opacity: pressed ? 0.5 : 1 })}
      >
        <SystemIcon
          name="questionmark.circle"
          mdName="CircleHelp"
          size={15}
          color="secondaryLabel"
        />
      </Pressable>
      {open ? <ModelLanguagesSheet model={model} onClose={() => setOpen(false)} /> : null}
    </>
  );
}

const styles = StyleSheet.create({
  content: { paddingHorizontal: 24, paddingBottom: 40, gap: 16 },
});
