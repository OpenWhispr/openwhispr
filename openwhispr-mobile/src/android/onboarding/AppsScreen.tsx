import { useState } from 'react';
import { Image, View } from 'react-native';
import { makeStyles } from '../ThemeProvider';
import { AccentText, GlassButton, Screen } from './kit';
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
// 345 x 400 card, which sits 24 in and 6 down. Everything outside the card is transparent (only the
// shadow has alpha), so the page's canvas shows around it in both themes. Glows, logos and the two
// still rings are the export; nothing pulses (Josh, 25 Nov).
const EVERYWHERE = require('./assets/everywhere.png');
const CARD = { width: 345, height: 400, left: 24, top: 6, imageWidth: 393, imageHeight: 448 };

export function AppsScreen({ onBack, onNext }: { onBack: () => void; onNext: () => void }) {
  const t = useOnboardingT();
  const o = useStyles();
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
        ) : null}
      </View>
    </Screen>
  );
}

const useStyles = makeStyles(() => ({
  // Not clipped: the export carries the card's own blue shadow below it.
  card: { width: '100%', aspectRatio: CARD.width / CARD.height, marginBottom: 42 },
}));
