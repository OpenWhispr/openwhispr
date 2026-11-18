import fs from 'node:fs';
import path from 'node:path';
import en from '@/locales/en/translation.json';

describe.each(['library', 'workflowSettings'] as const)('%s translations', (namespace) => {
  it.each(['en', 'es', 'fr', 'de', 'pt', 'it', 'ru', 'zh-CN', 'zh-TW', 'ja', 'ar'])(
    'ships all copy and preserves interpolation tokens in %s',
    (locale) => {
      const strings = JSON.parse(
        fs.readFileSync(path.join(__dirname, '../../locales', locale, 'translation.json'), 'utf8'),
      ).android[namespace];
      expect(Object.keys(strings).sort()).toEqual(Object.keys(en.android[namespace]).sort());
      for (const [key, english] of Object.entries(en.android[namespace])) {
        expect(typeof strings[key]).toBe('string');
        expect(strings[key].trim().length).toBeGreaterThan(0);
        expect((strings[key].match(/{{\w+}}/g) ?? []).sort()).toEqual(
          (english.match(/{{\w+}}/g) ?? []).sort(),
        );
      }
    },
  );
});
