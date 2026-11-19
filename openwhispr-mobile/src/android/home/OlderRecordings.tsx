import { Modal, Pressable, ScrollView, View } from 'react-native';
import { GestureDetector, GestureHandlerRootView } from 'react-native-gesture-handler';
import Animated from 'react-native-reanimated';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Text } from '@/components/ui/Text';
import { SystemIcon } from '@/components/ui/SystemIcon';
import { useSheetDragToDismiss } from '@/hooks/useSheetDragToDismiss';
import type { Transcript } from '@/types';
import { useHomeT } from './strings';
import { home, IconTile, TileButton, type } from './kit';
import { edge, edgeCard, look } from '../settings/look';

const SHEET_TOP_PEEK = 8;
const TITLE = { fontSize: 16, lineHeight: 22, fontWeight: '500' as const, color: home.text };

/** Home's entry to recordings saved before accounts: shown signed out, when there are some. */
export function OlderRecordingsRow({ count, onPress }: { count: number; onPress: () => void }) {
  const t = useHomeT();
  return (
    <Pressable
      cssInterop={false}
      accessibilityRole="button"
      onPress={onPress}
      style={({ pressed }) => [
        edgeCard,
        {
          flexDirection: 'row',
          alignItems: 'center',
          gap: 12,
          paddingLeft: 14,
          paddingRight: 12,
          paddingVertical: 12,
        },
        pressed && { backgroundColor: look.idleFill },
      ]}
    >
      <IconTile icon="Archive" color={home.secondary} />
      <View style={{ flex: 1, gap: 2 }}>
        <Text style={TITLE}>{t('olderRecordings')}</Text>
        <Text style={type.footnote}>{t('savedBeforeAccountsCount', { count })}</Text>
      </View>
      <SystemIcon name="chevron.right" mdName="ChevronRight" size={20} color={home.tertiary} />
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
  const text = item.text || item.errorMessage || '';
  const audioOnly = !text;
  return (
    <View>
      <View
        style={{
          flexDirection: 'row',
          alignItems: 'center',
          gap: 12,
          paddingLeft: 14,
          paddingRight: 12,
          paddingVertical: 12,
        }}
      >
        <View style={{ flex: 1, gap: 2 }}>
          <Text selectable={!audioOnly} numberOfLines={2} style={TITLE}>
            {audioOnly ? t('audioOnly') : text}
          </Text>
          <Text style={type.footnote}>{longDate(item.createdAt)}</Text>
        </View>
        {audioOnly ? (
          <View accessible={false}>
            <IconTile icon="AudioLines" color={home.secondary} />
          </View>
        ) : (
          <TileButton icon="Copy" label={t('copy')} onPress={() => onCopy(text)} />
        )}
      </View>
      {!last && (
        <View style={{ paddingLeft: 14 }}>
          <View style={{ height: 1, backgroundColor: look.hairline }} />
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
              backgroundColor: look.canvas,
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
                  backgroundColor: look.track,
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
                    color: home.text,
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
                  style={({ pressed }) => ({
                    ...edge,
                    width: 36,
                    height: 36,
                    borderRadius: 18,
                    alignItems: 'center',
                    justifyContent: 'center',
                    opacity: pressed ? 0.7 : 1,
                  })}
                >
                  <SystemIcon name="xmark" mdName="X" size={18} color={home.text} />
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
            <View style={[edgeCard, { padding: 14, gap: 6 }]}>
              <Text style={TITLE}>{t('savedBeforeAccounts')}</Text>
              <Text style={[type.footnote, { fontSize: 15, lineHeight: 21 }]}>
                {t('savedBeforeAccountsBody')}
              </Text>
            </View>
            {items.length ? (
              <View style={edgeCard}>
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
