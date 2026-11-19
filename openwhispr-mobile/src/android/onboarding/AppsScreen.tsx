import { useState } from 'react';
import { Image, StyleSheet, View } from 'react-native';
import { AccentText, GlassButton, PulseRings, Screen } from './kit';
import { useOnboardingT } from './strings';

const app = (name: string) => {
  switch (name) {
    case 'gmail':
      return require('./assets/apps/gmail.png');
    case 'slack':
      return require('./assets/apps/slack.png');
    case 'whatsapp':
      return require('./assets/apps/whatsapp.png');
    case 'outlook':
      return require('./assets/apps/outlook.png');
    case 'chatgpt':
      return require('./assets/apps/chatgpt.png');
    case 'notes':
      return require('./assets/apps/notes.png');
    case 'docs':
      return require('./assets/apps/docs.png');
    case 'calendar':
      return require('./assets/apps/calendar.png');
    case 'mail':
      return require('./assets/apps/mail.png');
    case 'teams':
      return require('./assets/apps/teams.png');
    case 'claude':
      return require('./assets/apps/claude.png');
    case 'x':
      return require('./assets/apps/x.png');
    case 'word':
      return require('./assets/apps/word.png');
    case 'safari':
      return require('./assets/apps/safari.png');
    case 'imessage':
      return require('./assets/apps/imessage.png');
    default:
      throw new Error(`Unknown app icon ${name}`);
  }
};
export const appIcon = app;

// The v3 graphic (Figma 4860:90) exported at 3x, its drop shadow included: 393 x 448 around the
// 345 x 400 card, which sits 24 in and 6 down. Glows, logos and the two rings at rest are the export;
// the rings' pulse is drawn on top, centred on the bubble at (172.5, 202).
const EVERYWHERE = require('./assets/everywhere.png');
const CARD = { width: 345, height: 400, left: 24, top: 6, imageWidth: 393, imageHeight: 448 };
const BUBBLE_CENTER = { x: 172.5, y: 202 };

export function AppsScreen({ onBack, onNext }: { onBack: () => void; onNext: () => void }) {
  const t = useOnboardingT();
  const [width, setWidth] = useState(0);
  const scale = width / CARD.width;
  return (
    <Screen onBack={onBack} footer={<GlassButton label={t('continue')} onPress={onNext} />}>
      <AccentText center text={t('appsTitle')} />
      <View
        style={o.card}
        onLayout={(event) => setWidth(event.nativeEvent.layout.width)}
        accessible={false}
        importantForAccessibility="no-hide-descendants"
      >
        {width > 0 ? (
          <>
            <Image
              source={EVERYWHERE}
              style={{
                position: 'absolute',
                left: -CARD.left * scale,
                top: -CARD.top * scale,
                width: CARD.imageWidth * scale,
                height: CARD.imageHeight * scale,
              }}
            />
            <View
              pointerEvents="none"
              style={{
                position: 'absolute',
                left: (BUBBLE_CENTER.x - 56) * scale,
                top: (BUBBLE_CENTER.y - 56) * scale,
                width: 112 * scale,
                height: 112 * scale,
              }}
            >
              <PulseRings size={112 * scale} color="rgba(255,255,255,0.16)" />
            </View>
          </>
        ) : null}
      </View>
    </Screen>
  );
}

const o = StyleSheet.create({
  // Not clipped: the export carries the card's own blue shadow below it.
  card: { width: '100%', aspectRatio: CARD.width / CARD.height, marginBottom: 42 },
});
