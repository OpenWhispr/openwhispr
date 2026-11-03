import type { TOptions } from 'i18next';
import { useEffect, useMemo, useRef, useState } from 'react';
import {
  Pressable,
  StyleSheet,
  TextInput,
  View,
  type PressableProps,
  type TextInputProps,
  type TextProps,
  type ViewStyle,
} from 'react-native';
import { Text } from '@/components/ui/Text';
import { FormSheet } from '@/components/ui/FormSheet';
import { SystemIcon } from '@/components/ui/SystemIcon';
import { iosColor } from '@/config/colors';
import { AppFont } from '@/lib/fonts';
import { safeHaptics } from '@/lib/utils';

const LABEL_COLOR = iosColor('label');
const PLACEHOLDER_COLOR = iosColor('tertiaryLabel');
// Subtle brand wash for context-phrase chips (multi-word entries).
const CONTEXT_TINT = 'rgba(0,122,255,0.12)';

type Props = {
  visible: boolean;
  onClose: () => void;
  onSubmit: (input: string) => void;
};

type WordsPresentation = {
  copy?: (key: string, fallback: string, options?: TOptions) => string;
  inputProps?: () => Pick<TextInputProps, 'accessibilityLabel' | 'multiline' | 'submitBehavior'>;
  chipStyle?: (base: ViewStyle) => PressableProps['style'];
  chipClassName?: string;
  chipTextProps?: Pick<TextProps, 'style'>;
};

const defaultCopy = (_key: string, fallback: string, _options?: TOptions) => fallback;

export function createAddWordsSheet(usePresentation: () => WordsPresentation = () => ({})) {
  return function AddWordsSheet({ visible, onClose, onSubmit }: Props) {
    const presentation = usePresentation();
    const copy = presentation.copy ?? defaultCopy;
    const [input, setInput] = useState('');
    const inputRef = useRef<TextInput>(null);

    useEffect(() => {
      if (visible) {
        const t = setTimeout(() => inputRef.current?.focus(), 120);
        return () => clearTimeout(t);
      }
      setInput('');
    }, [visible]);

    // Keep raw indices so a chip can splice its own comma segment out of the input.
    const segments = useMemo(
      () =>
        input
          .split(',')
          .map((value, index) => ({ value: value.trim(), index }))
          .filter((segment) => segment.value.length > 0),
      [input],
    );

    const wordCount = segments.length;
    const canSubmit = wordCount > 0;
    const addLabel =
      wordCount <= 1
        ? copy('library.addWord', 'Add word')
        : copy('library.addWordCount', `Add ${wordCount} words`, { count: wordCount });

    const handleSubmit = () => {
      if (!canSubmit) return;
      safeHaptics('light');
      onSubmit(input);
      onClose();
    };

    const removeSegment = (target: number) => {
      const next = input
        .split(',')
        .filter((_, index) => index !== target)
        .join(',')
        .replace(/^[\s,]+/, '');
      setInput(next);
      inputRef.current?.focus();
    };

    return (
      <FormSheet
        visible={visible}
        onClose={onClose}
        title={copy('library.addDictionary', 'Add to dictionary')}
        subtitle={copy('library.commaWords', 'Separate multiple words with commas.')}
        submitLabel={addLabel}
        canSubmit={canSubmit}
        onSubmit={handleSubmit}
      >
        <View
          style={{ borderCurve: 'continuous' }}
          className="rounded-xl bg-tertiarySystemFill px-3.5 py-3"
        >
          <TextInput
            ref={inputRef}
            value={input}
            onChangeText={setInput}
            placeholder={copy('library.wordPlaceholder', 'Add words, names, or terms…')}
            {...presentation.inputProps?.()}
            placeholderTextColor={PLACEHOLDER_COLOR}
            returnKeyType="done"
            onSubmitEditing={handleSubmit}
            autoCorrect={false}
            autoCapitalize="none"
            style={styles.input}
          />
        </View>

        {wordCount > 0 ? (
          <View className="mt-3 flex-row flex-wrap gap-2">
            {segments.map((segment) => {
              const isContext = segment.value.includes(' ');
              const chipStyle = {
                borderCurve: 'continuous' as const,
                backgroundColor: isContext ? CONTEXT_TINT : undefined,
              };
              return (
                <Pressable
                  key={segment.index}
                  onPress={() => removeSegment(segment.index)}
                  accessibilityRole="button"
                  accessibilityLabel={copy('library.removeWord', `Remove ${segment.value}`, {
                    word: segment.value,
                  })}
                  style={
                    presentation.chipStyle?.(chipStyle) ??
                    (({ pressed }) => ({ ...chipStyle, opacity: pressed ? 0.6 : 1 }))
                  }
                  className={`${presentation.chipClassName ?? 'h-8'} flex-row items-center gap-1.5 rounded-[10px] pl-3 pr-2 ${
                    isContext ? '' : 'bg-tertiarySystemFill'
                  }`}
                >
                  <Text
                    {...presentation.chipTextProps}
                    className={`text-[13.5px] font-medium ${isContext ? 'text-link' : 'text-label'}`}
                  >
                    {segment.value}
                  </Text>
                  <SystemIcon
                    name="xmark.circle.fill"
                    mdName="X"
                    size={15}
                    color={isContext ? 'link' : 'tertiaryLabel'}
                  />
                </Pressable>
              );
            })}
          </View>
        ) : null}

        <View className="mt-4 flex-row items-start gap-1.5">
          <SystemIcon name="info.circle" mdName="Info" size={13} color="tertiaryLabel" />
          <View className="flex-1">
            <Text className="text-[12px] text-tertiaryLabel">
              {copy('library.contextHint', 'For tricky pronunciations, try a context phrase like')}
            </Text>
            <Text className="mt-0.5 text-[12px] italic text-secondaryLabel">
              {copy('library.contextExample', '“The word is Synty”')}
            </Text>
          </View>
        </View>
      </FormSheet>
    );
  };
}

const styles = StyleSheet.create({
  input: {
    color: LABEL_COLOR,
    fontFamily: AppFont.regular,
    fontSize: 15,
    fontWeight: '400',
  },
});
