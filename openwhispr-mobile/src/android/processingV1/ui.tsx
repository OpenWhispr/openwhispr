import { useState } from 'react';
import { ScrollView, TextInput, View } from 'react-native';
import { Text } from '@/components/ui/Text';
import { home } from '../home/kit';
import { BottomSheet, ListRow, cardStyle, settings } from '../settings/kit';
import { KEY_CHECK_COLORS, KeyCheckMark } from '../settings/KeyCheckMark';
import type { KeyCheckResult, KeyCheckState } from '../settings/keyCheck';
import type { V1T } from './strings';

export type Option = { id: string; title: string; subtitle?: string; disabled?: boolean };

/** 9.2 / 9.3: a bottom sheet of choices, the chosen one tinted. Twelve models scroll. */
export function OptionSheet({
  visible,
  onClose,
  title,
  body,
  options,
  selected,
  onChoose,
  footer,
}: {
  visible: boolean;
  onClose: () => void;
  title: string;
  body?: string;
  options: Option[];
  selected?: string;
  onChoose: (id: string) => void;
  footer?: React.ReactNode;
}) {
  return (
    <BottomSheet visible={visible} onClose={onClose} title={title} body={body}>
      {/* The scroll area reaches the sheet's edges and pads inside, so the card's shadow
          (8 px down, 24 px blur) is never cut at the sides or the bottom. */}
      <ScrollView
        style={{ maxHeight: 480, marginHorizontal: -16, marginTop: -8, marginBottom: -16 }}
        contentContainerStyle={{ paddingHorizontal: 16, paddingTop: 8, paddingBottom: 32 }}
      >
        <View style={cardStyle}>
          {options.map((option, index) => (
            <View key={option.id}>
              {index > 0 && (
                <View style={{ height: 1, marginLeft: 16, backgroundColor: home.divider }} />
              )}
              <ListRow
                title={option.title}
                subtitle={option.subtitle}
                selected={option.id === selected}
                dimmed={option.disabled}
                trailing={option.id === selected ? undefined : null}
                onPress={option.disabled ? undefined : () => onChoose(option.id)}
              />
            </View>
          ))}
        </View>
      </ScrollView>
      {footer}
    </BottomSheet>
  );
}

/** 9.4 / 9.9: a text field in its own card, its label inside above the value. */
export function FieldCard({
  label,
  value,
  onChangeText,
  placeholder,
  secure,
  mark,
  failed,
  accessibilityLabel,
  keyboardType,
  autoFocus,
  locked,
}: {
  label: string;
  value: string;
  onChangeText?: (value: string) => void;
  placeholder?: string;
  secure?: boolean;
  mark?: React.ReactNode;
  failed?: boolean;
  accessibilityLabel?: string;
  keyboardType?: 'default' | 'url';
  autoFocus?: boolean;
  /** Shown as text, not editable (a key that passed its check). */
  locked?: boolean;
}) {
  const [focused, setFocused] = useState(false);
  return (
    <View
      style={[
        cardStyle,
        {
          flexDirection: 'row',
          alignItems: 'center',
          paddingHorizontal: 16,
          paddingVertical: 10,
          gap: 10,
          borderWidth: 1.5,
          borderColor: failed
            ? KEY_CHECK_COLORS.failed
            : focused
              ? home.accent
              : home.borderDefault,
        },
      ]}
    >
      <View style={{ flex: 1, gap: 2 }}>
        <Text style={[settings.subtitle, { fontSize: 12, lineHeight: 16 }]}>{label}</Text>
        {locked ? (
          <Text
            style={[settings.title, { fontWeight: '400', paddingVertical: 4 }]}
            numberOfLines={1}
          >
            {value}
          </Text>
        ) : (
          <TextInput
            value={value}
            onChangeText={onChangeText}
            placeholder={placeholder}
            placeholderTextColor={home.tertiary}
            secureTextEntry={secure}
            autoCapitalize="none"
            autoCorrect={false}
            autoComplete="off"
            autoFocus={autoFocus}
            importantForAutofill="no"
            keyboardType={keyboardType === 'url' ? 'url' : 'default'}
            accessibilityLabel={accessibilityLabel ?? label}
            onFocus={() => setFocused(true)}
            onBlur={() => setFocused(false)}
            style={[settings.title, { fontWeight: '400', padding: 0, paddingVertical: 4 }]}
          />
        )}
      </View>
      {mark}
    </View>
  );
}

/** The check's mark, read out as it changes. */
export function CheckMark({ t, state }: { t: V1T; state: KeyCheckState; animate?: boolean }) {
  if (state === 'idle') return null;
  return (
    <View
      accessible
      accessibilityLiveRegion="polite"
      accessibilityLabel={t('keyCheckState', {
        state: t(
          state === 'checking'
            ? 'keyChecking'
            : state === 'connected'
              ? 'keyAccepted'
              : 'keyNotAccepted',
        ),
      })}
    >
      <KeyCheckMark state={state} />
    </View>
  );
}

/** Plain words for why a check didn't pass; the mark says the rest. */
export function reasonText(
  t: V1T,
  provider: string,
  result: KeyCheckResult & { message?: string; invalidAddress?: boolean },
) {
  if (result.invalidAddress) return t('serverInvalid');
  if (result.state === 'unverified') return t('keyNoAnswer', { provider });
  if (result.reason === 'managementKey') return t('keyManagement');
  if (result.reason === 'status' && result.message) return result.message;
  if (result.reason === 'status') return t('keyStatus', { provider, status: result.status });
  return t('keyRefused', { provider });
}

/** "Check connection" row value: the mark and one word (Works, Failed, Couldn't check). */
export function ConnectionValue({ t, state }: { t: V1T; state: KeyCheckState }) {
  const word =
    state === 'checking'
      ? t('checking')
      : state === 'connected'
        ? t('works')
        : state === 'failed'
          ? t('failed')
          : state === 'unverified'
            ? t('couldntCheck')
            : '';
  const color =
    state === 'connected'
      ? home.accent
      : state === 'failed'
        ? KEY_CHECK_COLORS.failed
        : state === 'unverified'
          ? KEY_CHECK_COLORS.unverified
          : home.tertiary;
  return (
    <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
      <Text style={[settings.rowValue, { color }]}>{word}</Text>
      {state !== 'idle' && <KeyCheckMark state={state} />}
    </View>
  );
}
