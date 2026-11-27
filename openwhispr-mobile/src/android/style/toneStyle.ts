import { useConfigStore } from '@/android/store/useConfigStore';
import type { KeyboardTone, UserConfig } from '@/android/types';
import { dlog } from '@/android/lib/debugLog';

/**
 * Tone & Style on Android: the tone cleanup writes in, picked per kind of app. Categories, tones
 * and defaults are desktop's (`src/config/toneStyle.ts`); the values are the ones openwhispr-api's
 * /api/reason takes as `appCategory` and `tone`.
 */
export const TONE_KINDS = ['personal', 'work', 'email', 'other'] as const;
export type ToneKind = (typeof TONE_KINDS)[number];

export type DictationTone = Exclude<KeyboardTone, 'default'>;

export const TONE_OPTIONS: Record<ToneKind, readonly DictationTone[]> = {
  personal: ['formal', 'casual', 'very_casual'],
  work: ['formal', 'casual', 'excited'],
  email: ['formal', 'casual', 'excited'],
  other: ['formal', 'casual', 'excited'],
};

export type ToneStyles = Record<ToneKind, DictationTone>;

export const DEFAULT_TONE_STYLES: ToneStyles = {
  personal: 'casual',
  work: 'formal',
  email: 'formal',
  other: 'formal',
};

/** Words dictated before Home offers the setup (desktop's TONE_STYLE_PROMPT_MIN_WORDS). */
export const TONE_STYLE_NUDGE_MIN_WORDS = 70;

/**
 * Saved in the config blob beside the shared fields. Off until the setup's Done or the Style
 * tab's switch turns it on; `setUp` once the setup finished; `nudgeDismissed` after Home's Not now.
 */
export interface AndroidToneStyle {
  enabled: boolean;
  tones: ToneStyles;
  setUp?: boolean;
  nudgeDismissed?: boolean;
}

type ToneStyleConfig = UserConfig & { androidToneStyle?: Partial<AndroidToneStyle> };

/** Keeps only tones offered for each kind; anything else reads as that kind's default. */
export function normalizeToneStyles(value: unknown): ToneStyles {
  const stored = (value && typeof value === 'object' ? value : {}) as Record<string, unknown>;
  return Object.fromEntries(
    TONE_KINDS.map((kind) => {
      const tone = stored[kind];
      return [
        kind,
        TONE_OPTIONS[kind].includes(tone as DictationTone) ? tone : DEFAULT_TONE_STYLES[kind],
      ];
    }),
  ) as ToneStyles;
}

export function readToneStyle(config: UserConfig | null | undefined): AndroidToneStyle {
  const stored = (config as ToneStyleConfig | null | undefined)?.androidToneStyle;
  return {
    enabled: stored?.enabled === true,
    tones: normalizeToneStyles(stored?.tones),
    setUp: stored?.setUp === true,
    nudgeDismissed: stored?.nudgeDismissed === true,
  };
}

/** Saves a change; throws when the shared store reports the save failed. */
export async function saveToneStyle(change: Partial<AndroidToneStyle>): Promise<void> {
  const store = useConfigStore.getState();
  const next: AndroidToneStyle = { ...readToneStyle(store.config), ...change };
  await store.updateConfig({ androidToneStyle: next } as Partial<ToneStyleConfig>);
  const error = useConfigStore.getState().error;
  if (error) throw new Error(error);
}

export function useToneStyle(): AndroidToneStyle {
  return readToneStyle(useConfigStore((s) => s.config));
}

/*
 * The kind of app a dictation goes into, from the package of the focused field. Exact packages
 * first; an unknown app is matched on whole name parts with desktop's app words, and anything
 * else (browsers, notes, documents, OpenWhispr itself) is "other".
 */
const PACKAGES: Record<Exclude<ToneKind, 'other'>, readonly string[]> = {
  personal: [
    'com.whatsapp',
    'com.whatsapp.w4b',
    'com.google.android.apps.messaging',
    'com.samsung.android.messaging',
    'org.telegram.messenger',
    'org.telegram.messenger.web',
    'org.telegram.plus',
    'org.thunderdog.challegram',
    'org.thoughtcrime.securesms',
    'com.facebook.orca',
    'com.facebook.mlite',
    'com.facebook.katana',
    'com.instagram.android',
    'com.instagram.barcelona',
    'com.twitter.android',
    'com.snapchat.android',
    'com.discord',
    'com.tencent.mm',
    'jp.naver.line.android',
    'com.viber.voip',
    'com.kakao.talk',
    'ch.threema.app',
    'ch.threema.app.libre',
    'com.zing.zalo',
    'com.beeper.android',
    'im.vector.app',
  ],
  work: [
    'com.Slack',
    'com.microsoft.teams',
    'com.google.android.apps.dynamite',
    'com.linkedin.android',
    'com.mattermost.rn',
    'chat.rocket.android',
    'com.zulipmobile',
    'com.cisco.wx2.android',
    'us.zoom.videomeetings',
    'com.larksuite.suite',
    'com.ss.android.lark',
    'com.alibaba.android.rimet',
    'com.tencent.wework',
    'com.glip.mobile',
    'com.ringcentral.android',
  ],
  email: [
    'com.google.android.gm',
    'com.google.android.gm.lite',
    'com.microsoft.office.outlook',
    'ch.protonmail.android',
    'com.samsung.android.email.provider',
    'com.yahoo.mobile.client.android.mail',
    'com.readdle.spark',
    'me.bluemail.mail',
    'com.easilydo.mail',
    'com.fsck.k9',
    'net.thunderbird.android',
    'de.tutao.tutanota',
    'com.fastmail.app',
    'com.zoho.mail',
    'com.superhuman.android',
    'com.aol.mobile.aolapp',
  ],
};

const NAME_PARTS: Record<Exclude<ToneKind, 'other'>, readonly string[]> = {
  personal: ['whatsapp', 'telegram', 'signal', 'messenger', 'instagram', 'wechat', 'viber'],
  work: ['slack', 'teams', 'mattermost', 'zulip', 'webex', 'lark', 'dingtalk', 'wecom'],
  email: ['mail', 'email', 'gmail', 'outlook', 'protonmail', 'thunderbird', 'tutanota'],
};

export function toneKindForApp(app: string | undefined | null): ToneKind {
  if (!app) return 'other';
  for (const kind of ['personal', 'work', 'email'] as const)
    if (PACKAGES[kind].includes(app)) return kind;
  const parts = app.toLowerCase().split(/[._]/);
  for (const kind of ['personal', 'work', 'email'] as const)
    if (NAME_PARTS[kind].some((word) => parts.includes(word))) return kind;
  return 'other';
}

/**
 * The tone one dictation is cleaned in, read when it starts: none while Tone & Style is off, so
 * cleanup keeps the speaker's own tone.
 */
export function dictationToneStyle(
  config: UserConfig | null | undefined,
  app: string | undefined,
): { appCategory: ToneKind; tone: DictationTone } | undefined {
  const style = readToneStyle(config);
  if (!style.enabled) return undefined;
  const appCategory = toneKindForApp(app);
  const tone = style.tones[appCategory];
  // The kind of app and the tone only: never the app's name or the style's words.
  dlog.info('style', 'applied', { category: appCategory, tone });
  return { appCategory, tone };
}
