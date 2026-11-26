import type { DictationTone, ToneKind } from './toneStyle';
import type { AppLogo } from './appLogos';
import { EXAMPLE_TRANSLATIONS, type ExampleSet } from './examplesI18n';

/**
 * The example for each kind and tone (Figma "Styles · Variant B", 20 Nov): one spoken sentence as
 * it lands in that kind of app. `~words~` were dropped by the tone, `+words+` added or changed;
 * everything else was said as is. Other languages are in `examplesI18n.ts`.
 */
export const EXAMPLES: Record<ToneKind, Partial<Record<DictationTone, string>>> = {
  personal: {
    formal:
      '~um~ +Hey,+ are you around this evening+?+ +I+ was thinking we could ~like~ grab a coffee around ~six~ +6.+ +Let+ me know+.+',
    casual:
      '~um~ +Hey+ are you around this evening+?+ ~I was~ +Thinking+ ~we could like grab a~ coffee around ~six~ +6ish,+ let me know',
    very_casual:
      '~um~ hey ~are you~ +u+ around this evening+?+ ~I was~ thinking ~we could like grab a~ coffee ~around six~ +6ish+ ~let me know~ +lmk+',
  },
  work: {
    formal:
      '~um~ +Hey,+ could you send me the deck before the call+?+ +The+ numbers on slide ~three~ +3+ look out of date+.+ +No+ rush+.+',
    casual:
      '~um~ +Hey+ ~could~ +can+ you send ~me~ the deck before the call+?+ ~the numbers on slide three look out of date~ +Think slide 3 numbers are old,+ no rush+.+',
    excited:
      '~um~ +Hey!+ +Could+ you send me the deck before the call+?+ +The+ numbers on slide ~three~ +3+ look out of date+.+ +No+ rush+!+',
  },
  email: {
    formal:
      '+Hi Sarah,+\n\n+Thank+ you for your time today+.+ ~um~ +I+ will send the updated proposal by +Thursday.+ +Please let+ me know if you need anything before then+.+\n\n+Best regards+',
    casual:
      '+Hi Sarah,+\n\n~thank you~ +Thanks+ for ~your time~ today+.+ ~um I will~ +I’ll+ send the updated proposal by +Thursday,+ let me know if you need anything before then+.+\n\n+Thanks+',
    excited:
      '+Hi Sarah,+\n\n~thank you~ +Thanks so much+ for your time today+!+ ~um I will~ +I’ll+ send the updated proposal by +Thursday.+ +Let+ me know if you need anything before then+!+\n\n+Thanks+',
  },
  other: {
    formal:
      '+Notes+ from the call+:+ ~uh~ they liked the pricing page and would like a shorter onboarding+.+ +Follow+ up with them next week+.+',
    casual:
      '~notes from the call~ +Call notes:+ ~uh they~ liked the pricing page+,+ ~and would like a shorter onboarding~ +want onboarding shorter.+ +Follow+ up ~with them~ next week',
    excited:
      '~notes from the call~ +Call notes:+ ~uh~ they ~liked~ +loved+ the pricing page+!+ ~and would like a shorter onboarding~ +Want onboarding shorter.+ +Follow+ up with them next week+!+',
  },
};

/** The setup intro's fanned cards: a short line in each personal tone. */
export const INTRO_EXAMPLES: Record<'formal' | 'casual' | 'very_casual', string> = {
  formal: '~um hey~ +Hi,+ are you free ~tonight~ +this evening?+',
  casual: '~um~ +Hey+ are you free tonight+?+',
  very_casual: '~um~ hey ~are you~ +u+ free tonight+?+ +lmk+',
};

export type DiffPart = { text: string; change?: 'drop' | 'add' };

/** Splits an example into said, dropped and added runs. */
export function parseExample(example: string): DiffPart[] {
  return example
    .split(/(~[^~]+~|\+[^+]+\+)/)
    .filter(Boolean)
    .map((part) =>
      part.startsWith('~') && part.endsWith('~') && part.length > 1
        ? { text: part.slice(1, -1), change: 'drop' as const }
        : part.startsWith('+') && part.endsWith('+') && part.length > 1
          ? { text: part.slice(1, -1), change: 'add' as const }
          : { text: part },
    );
}

/** The written result, without the dropped words: what TalkBack reads. */
export function exampleResult(example: string): string {
  return parseExample(example)
    .filter((part) => part.change !== 'drop')
    .map((part) => part.text)
    .join('')
    .replace(/ {2,}/g, ' ')
    .replace(/ ([?.,!:])/g, '$1')
    .trim();
}

export const KIND_APPS: Record<ToneKind, AppLogo[]> = {
  personal: ['whatsapp', 'messages', 'telegram'],
  work: ['slack', 'teams', 'googleChat'],
  email: ['gmail', 'outlook', 'protonMail'],
  other: ['notion', 'chatgpt'],
};

const ENGLISH: ExampleSet = {
  question: 'What are you up to later?',
  to: 'To',
  notes: 'Call notes',
  intro: INTRO_EXAMPLES,
  examples: EXAMPLES,
};

/** The examples in the app's language (`zh-CN`, `pt-BR`…), English when it has none. */
export function exampleSet(language: string | undefined): ExampleSet {
  const code = language ?? 'en';
  return EXAMPLE_TRANSLATIONS[code] ?? EXAMPLE_TRANSLATIONS[code.split('-')[0]] ?? ENGLISH;
}
