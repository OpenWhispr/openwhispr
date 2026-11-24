import fs from 'fs';
import path from 'path';
import { PENDING } from './themeAtRenderPending';

/**
 * Dark theme §3b: a screen half-drawn during a light/dark switch can't keep old colours, so every
 * colour has to come from `useTheme()` / `makeStyles()` at render. A file fails when it
 *  - imports a static palette or recipe (`theme`, `flat`, `raised`, … from `theme.ts`, or the
 *    older token objects `home`, `look`, `notesLook`, `colors`, `ink`, `palette`, `authColors`),
 *  - builds a `StyleSheet` at module level, or
 *  - writes a colour (hex, rgb/rgba) into a module-level constant.
 * Files still to move are listed in `themeAtRenderPending.ts`, grouped by the segment that moves
 * them; an entry whose file is clean fails too, so take files off the list as you move them.
 */
const ROOT = path.resolve(__dirname, '../../..');

/** The theme itself, and third-party marks, which keep their own colours. */
const EXEMPT = new Set([
  'src/android/theme.ts',
  'src/android/ThemeProvider.tsx',
  'src/android/processingFable/providerLogos.ts',
  'src/android/style/appLogos.ts',
]);

const STATIC_THEME = new Set([
  'theme',
  'lightTheme',
  'darkTheme',
  'flat',
  'raised',
  'raisedPressed',
  'knob',
  'inset',
  'glass',
  'glassPressed',
]);
const LEGACY_TOKENS = new Set([
  'home',
  'look',
  'notesLook',
  'colors',
  'ink',
  'palette',
  'authColors',
  // home/kit's light-only exports, kept for files not moved yet (read `useHome()` instead).
  'type',
  'glassEdge',
  'TILE_FILL',
  // settings/look's static light surfaces and text.
  'edge',
  'edgeCard',
  'edgeField',
  'bodyText',
  'sectionLabel',
  'cardStyle',
  // settings/kit's light-only tokens (read `useSettings()` instead).
  'settings',
]);
const COLOUR = /#[0-9a-f]{3,8}\b|\brgba?\(/i;

export function screenFiles(): string[] {
  const out: string[] = [];
  const walk = (dir: string) => {
    for (const entry of fs.readdirSync(path.join(ROOT, dir), { withFileTypes: true })) {
      const rel = path.posix.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (entry.name !== '__tests__' && entry.name !== 'assets') walk(rel);
      } else if (/\.tsx?$/.test(entry.name) && !/\.d\.ts$/.test(entry.name)) out.push(rel);
    }
  };
  walk('src/android');
  // Android overrides of shared components, anywhere under src/components.
  const walkAndroid = (dir: string) => {
    for (const entry of fs.readdirSync(path.join(ROOT, dir), { withFileTypes: true })) {
      const rel = path.posix.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (entry.name !== '__tests__') walkAndroid(rel);
      } else if (/\.android\.tsx?$/.test(entry.name)) out.push(rel);
    }
  };
  walkAndroid('src/components');
  for (const dir of ['src/screens', 'src/config'])
    for (const name of fs.readdirSync(path.join(ROOT, dir)))
      if (/\.android\.tsx?$/.test(name)) out.push(path.posix.join(dir, name));
  for (const name of fs.readdirSync(path.join(ROOT, 'app')))
    if (/^android-.*\.tsx?$/.test(name)) out.push(path.posix.join('app', name));
  return out.filter((file) => !EXEMPT.has(file)).sort();
}

/** Every reason [file] reads a colour outside render, as `line: why`. */
export function moduleLevelColours(file: string): string[] {
  const source = fs.readFileSync(path.join(ROOT, file), 'utf8');
  const hits: string[] = [];
  // Value imports (not `import type`) from a relative module or from `@/android/…`.
  const imports = /import\s+(?!type\b)\{([^}]*)\}\s+from\s+'(\.[^']*|@\/android\/[^']*)'/g;
  for (let match = imports.exec(source); match; match = imports.exec(source)) {
    const names = match[1]
      .split(',')
      .map((part) => part.trim())
      .filter((part) => part && !part.startsWith('type '))
      .map((part) => part.split(/\s+as\s+/)[0].trim());
    const fromTheme = /(^|\/)theme$/.test(match[2]);
    for (const name of names)
      if ((fromTheme && STATIC_THEME.has(name)) || LEGACY_TOKENS.has(name))
        hits.push(`imports ${name} from ${match[2]}`);
  }
  // Module-level declarations: a line at column 0 opens one and it runs until its brackets close.
  const lines = source.split('\n');
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    if (!/^(export\s+)?(const|let|var)\s/.test(line)) continue;
    let depth = 0;
    let end = index;
    for (; end < lines.length; end += 1) {
      for (const char of lines[end].replace(/'[^']*'|"[^"]*"|`[^`]*`/g, '')) {
        if ('({['.includes(char)) depth += 1;
        else if (')}]'.includes(char)) depth -= 1;
      }
      if (depth <= 0) break;
    }
    const body = lines.slice(index, end + 1).join('\n');
    const start = index + 1;
    index = end;
    // A function (component, hook, helper) reads its colours when it runs.
    if (
      /^[^=]*=\s*(async\s+)?(\([^)]*\)|\w+)\s*(:[^=]*)?=>/.test(line) ||
      /=\s*function\b/.test(line)
    )
      continue;
    if (/=\s*makeStyles\(/.test(line)) continue;
    if (/StyleSheet\.create\(/.test(body)) hits.push(`${start}: module-level StyleSheet`);
    else if (COLOUR.test(body)) hits.push(`${start}: colour in a module-level constant`);
  }
  return hits;
}

describe('theme at render guard (dark theme §3b)', () => {
  const files = screenFiles();
  const pending = new Set(PENDING);

  it('finds Android screen files to check', () => {
    expect(files.length).toBeGreaterThan(100);
    expect(files).toContain('src/android/Root.tsx');
  });

  it('reads colours at render outside the pending list', () => {
    const offenders = files
      .filter((file) => !pending.has(file))
      .flatMap((file) => moduleLevelColours(file).map((hit) => `${file}: ${hit}`));
    expect(offenders).toEqual([]);
  });

  it('lists only files that still need moving', () => {
    const clean = PENDING.filter(
      (file) => !files.includes(file) || moduleLevelColours(file).length === 0,
    );
    expect(clean).toEqual([]);
  });
});
