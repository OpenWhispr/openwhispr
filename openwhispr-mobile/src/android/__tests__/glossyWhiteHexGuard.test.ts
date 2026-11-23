import fs from 'fs';
import path from 'path';

/**
 * Glossy white 3b: colours live only in `src/android/theme.ts`. This fails on any warm grey,
 * warm ink or retired blue the design system replaced, anywhere in Android's own files, so the
 * drift can't come back.
 */
const RETIRED = [
  // Warm pages and panels.
  'F8F6F5',
  'F2F1EF',
  'F1F0EE',
  'F7F6F4',
  'F8F7F5',
  'F7F7F6',
  'F1F1F0',
  // Warm tracks, fills and dividers.
  'E8E7E4',
  'E7E6E3',
  'E6E5E2',
  'E9E8E4',
  'E9E8E5',
  'E1E0DC',
  'E2E0DB',
  'D9D8D4',
  'E6E1DE',
  'CFCEC9',
  'C9C6C0',
  'C9C8C4',
  'C0BFBB',
  // Warm inks and greys.
  '181714',
  '1A1A1A',
  '1C1B19',
  '22211F',
  '6E6D69',
  '55534F',
  'A8A7A3',
  '8C8A85',
  // Blues other than the one accent (D3).
  '1E55D6',
  '154BD4',
  '2457C5',
];
const RETIRED_RGBA = [/rgba\(\s*28,\s*27,\s*25\b/i, /rgba\(\s*21,\s*75,\s*212\b/i];
const HEX = new RegExp(`#(${RETIRED.join('|')})(?![0-9a-f])`, 'i');

const ROOT = path.resolve(__dirname, '../../..');

/** Third-party marks keep their own colours. */
const LOGOS = new Set([
  'src/android/processingFable/providerLogos.ts',
  'src/android/style/appLogos.ts',
]);

/**
 * Files the later segments of the glossy white build still sweep (build plan, segments 2–7).
 * Each segment takes its files off this list; an entry whose file is already clean fails too,
 * so the list only shrinks.
 */
const PENDING = new Set([
  // 5 · Settings
  'src/android/settings/SizeLookScreen.tsx',
  'src/android/settings/ModelListRow.tsx',
  'src/android/settings/BubbleAssistantScreen.tsx',
  // 6 · Onboarding + native bubble
  'src/android/onboarding/kit.tsx',
  'src/android/onboarding/practiceParts.tsx',
  'src/android/onboarding/PracticeBubble.tsx',
  'src/android/onboarding/LanguagesScreen.tsx',
  'src/android/onboarding/EndScreens.tsx',
  'src/android/onboarding/PermissionScreens.tsx',
  'src/android/onboarding/DeviceSetupScreens.tsx',
  // 7 · Account flows
  'src/android/launch/LaunchScreens.tsx',
]);

function androidFiles(): string[] {
  const out: string[] = [];
  const walk = (dir: string) => {
    for (const entry of fs.readdirSync(path.join(ROOT, dir), { withFileTypes: true })) {
      const rel = path.posix.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (entry.name !== '__tests__' && entry.name !== 'assets') walk(rel);
      } else if (/\.(tsx?|jsx?)$/.test(entry.name)) out.push(rel);
    }
  };
  walk('src/android');
  for (const dir of ['src/components/ui', 'src/screens', 'src/config'])
    for (const name of fs.readdirSync(path.join(ROOT, dir)))
      if (/\.android\.(tsx?|jsx?)$/.test(name)) out.push(path.posix.join(dir, name));
  for (const name of fs.readdirSync(path.join(ROOT, 'app')))
    if (/^android-.*\.(tsx?|jsx?)$/.test(name)) out.push(path.posix.join('app', name));
  return out;
}

function offends(file: string): string[] {
  return fs
    .readFileSync(path.join(ROOT, file), 'utf8')
    .split('\n')
    .flatMap((line, index) =>
      HEX.test(line) || RETIRED_RGBA.some((pattern) => pattern.test(line))
        ? [`${file}:${index + 1}: ${line.trim()}`]
        : [],
    );
}

describe('glossy white colour guard', () => {
  const files = androidFiles();

  it('finds Android files to check', () => {
    expect(files.length).toBeGreaterThan(100);
    expect(files).toContain('src/android/theme.ts');
  });

  it('leaves no retired warm colour outside the theme', () => {
    const hits = files.filter((file) => !LOGOS.has(file) && !PENDING.has(file)).flatMap(offends);
    expect(hits).toEqual([]);
  });

  it('keeps the pending list to files that still need their sweep', () => {
    const clean = [...PENDING].filter((file) => !offends(file).length);
    expect(clean).toEqual([]);
  });
});
