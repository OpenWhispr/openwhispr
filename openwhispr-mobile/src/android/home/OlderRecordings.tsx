import { Modal, Pressable, ScrollView, View } from 'react-native';
import { GestureDetector, GestureHandlerRootView } from 'react-native-gesture-handler';
import Animated from 'react-native-reanimated';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Text } from '@/components/ui/Text';
import { SystemIcon } from '@/components/ui/SystemIcon';
import { useSheetDragToDismiss } from '@/hooks/useSheetDragToDismiss';
import type { Transcript } from '@/types';
import { useHomeT } from './strings';
import { IconTile, TileButton, useHome } from './kit';

const SHEET_TOP_PEEK = 8;

/** Home's entry to recordings saved before accounts: shown signed out, when there are some. */
export function OlderRecordingsRow({ count, onPress }: { count: number; onPress: () => void }) {
  const t = useHomeT();
  const { c, type, card } = useHome();
  return (
    <Pressable
      cssInterop={false}
      accessibilityRole="button"
      onPress={onPress}
      style={({ pressed }) => [
        card,
        {
          flexDirection: 'row',
          alignItems: 'flex-start',
          gap: 12,
          paddingLeft: 14,
          paddingRight: 12,
          paddingVertical: 12,
        },
        pressed && { backgroundColor: c.tile },
      ]}
    >
      <IconTile icon="Archive" color={c.secondary} />
      <View style={{ flex: 1, gap: 2 }}>
        <Text style={type.rowTitle}>{t('olderRecordings')}</Text>
        <Text style={type.footnote}>{t('savedBeforeAccountsCount', { count })}</Text>
      </View>
      <SystemIcon name="chevron.right" mdName="ChevronRight" size={20} color={c.tertiary} />
    </Pressable>
  );
}

const longDate = (createdAt: number) =>
  new Date(createdAt).toLocaleDateString(undefined, {
    day: 'numeric',
    month: 'short',
    year: 'numeric',
  });

function OlderRow({
  item,
  last,
  onCopy,
}: {
  item: Transcript;
  last: boolean;
  onCopy: (text: string) => void;
}) {
  const t = useHomeT();
  const { c, type } = useHome();
  const text = item.text || item.errorMessage || '';
  const audioOnly = !text;
  return (
    <View>
      <View
        style={{
          flexDirection: 'row',
          alignItems: 'flex-start',
          gap: 12,
          paddingLeft: 14,
          paddingRight: 12,
          paddingVertical: 12,
        }}
      >
        <View style={{ flex: 1, gap: 2, paddingTop: 7 }}>
          <Text selectable={!audioOnly} style={type.rowTitle}>
            {audioOnly ? t('audioOnly') : text}
          </Text>
          <Text style={type.footnote}>{longDate(item.createdAt)}</Text>
        </View>
        {audioOnly ? (
          <View accessible={false}>
            <IconTile icon="AudioLines" color={c.secondary} />
          </View>
        ) : (
          <TileButton icon="Copy" label={t('copy')} onPress={() => onCopy(text)} />
        )}
      </View>
      {!last && (
        <View style={{ paddingLeft: 14 }}>
          <View style={{ height: 1, backgroundColor: c.hairline }} />
        </View>
      )}
    </View>
  );
}

/**
 * Recordings saved on this phone before accounts existed, read and copy only. A sheet over
 * Home: ✕, a swipe down on the handle or title, or back closes it.
 */
export function OlderRecordingsSheet({
  visible,
  items,
  onClose,
  onCopy,
}: {
  visible: boolean;
  items: Transcript[];
  onClose: () => void;
  onCopy: (text: string) => void;
}) {
  const t = useHomeT();
  const { c, type, card, theme } = useHome();
  const insets = useSafeAreaInsets();
  const { dragGesture, sheetStyle } = useSheetDragToDismiss(visible, onClose);
  return (
    <Modal
      visible={visible}
      transparent
      animationType="slide"
      statusBarTranslucent
      onRequestClose={onClose}
    >
      <GestureHandlerRootView style={{ flex: 1 }}>
        <Pressable
          accessibilityLabel={t('close')}
          onPress={onClose}
          style={{ position: 'absolute', top: 0, right: 0, bottom: 0, left: 0 }}
        >
          <View style={{ flex: 1, backgroundColor: 'rgba(0,0,0,0.4)' }} />
        </Pressable>
        <Animated.View
          style={[
            {
              position: 'absolute',
              left: 0,
              right: 0,
              bottom: 0,
              top: insets.top + SHEET_TOP_PEEK,
              borderTopLeftRadius: 24,
              borderTopRightRadius: 24,
              backgroundColor: c.canvas,
              overflow: 'hidden',
            },
            sheetStyle,
          ]}
        >
          <GestureDetector gesture={dragGesture}>
            <View style={{ paddingHorizontal: 16, paddingTop: 10, paddingBottom: 8 }}>
              <View
                style={{
                  alignSelf: 'center',
                  width: 36,
                  height: 4,
                  borderRadius: 2,
                  backgroundColor: c.fill,
                  marginBottom: 14,
                }}
              />
              <View style={{ flexDirection: 'row', alignItems: 'center', gap: 12 }}>
                <Text
                  accessibilityRole="header"
                  style={{
                    flex: 1,
                    fontSize: 22,
                    lineHeight: 28,
                    fontWeight: '500',
                    color: c.text,
                  }}
                >
                  {t('olderRecordings')}
                </Text>
                <Pressable
                  cssInterop={false}
                  accessibilityRole="button"
                  accessibilityLabel={t('close')}
                  onPress={onClose}
                  hitSlop={6}
                  style={({ pressed }) => [
                    theme.raised,
                    {
                      width: 36,
                      height: 36,
                      borderRadius: 18,
                      alignItems: 'center',
                      justifyContent: 'center',
                    },
                    pressed && theme.raisedPressed,
                  ]}
                >
                  <SystemIcon name="xmark" mdName="X" size={18} color={c.text} />
                </Pressable>
              </View>
            </View>
          </GestureDetector>
          <ScrollView
            contentContainerStyle={{
              padding: 16,
              paddingBottom: Math.max(insets.bottom, 16) + 24,
              gap: 16,
            }}
          >
            <View style={[card, { padding: 14, gap: 6 }]}>
              <Text style={type.rowTitle}>{t('savedBeforeAccounts')}</Text>
              <Text style={[type.footnote, { fontSize: 15, lineHeight: 21 }]}>
                {t('savedBeforeAccountsBody')}
              </Text>
            </View>
            {items.length ? (
              <View style={card}>
                {items.map((item, index) => (
                  <OlderRow
                    key={item.id}
                    item={item}
                    last={index === items.length - 1}
                    onCopy={onCopy}
                  />
                ))}
              </View>
            ) : (
              <View style={{ alignItems: 'center', gap: 4, paddingTop: 40, paddingHorizontal: 24 }}>
                <Text style={[type.headline, { textAlign: 'center' }]}>
                  {t('nothingFromBefore')}
                </Text>
                <Text style={[type.footnote, { textAlign: 'center' }]}>
                  {t('nothingFromBeforeBody')}
                </Text>
              </View>
            )}
          </ScrollView>
        </Animated.View>
      </GestureHandlerRootView>
    </Modal>
  );
}
