#!/usr/bin/env node
// Fails a pull request that changes Android-only files together with a file the iOS app loads.
// "Loads" is read from the iOS export's source map, so it is what Metro bundled, not a guess
// from file names. Design tokens are the one thing both platforms share on purpose.
//
//   node scripts/check-android-ui-isolation.mjs --base <git ref> --export-dir <expo export dir>
import { execFileSync } from 'node:child_process';
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const MOBILE = 'openwhispr-mobile/';
const mobileRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const repoRoot = path.resolve(mobileRoot, '..');

// Files only the Android app can load. A PR that changes any of them is an Android PR.
const ANDROID_ONLY = [
  /\.android\.[cm]?[jt]sx?$/,
  /^src\/android\//,
  /^modules\/android-[^/]+\//,
  /^modules\/[^/]+\/android\//,
  /^app\/android-[^/]+\.[jt]sx?$/,
  /^scripts\/android-[^/]+/,
  /^config\/easignore\.android$/,
];

// Shared on purpose: design tokens only.
const SHARED_TOKENS = new Set(['tailwind.config.js', 'global.css']);

export function isAndroidOnly(file) {
  return ANDROID_ONLY.some((pattern) => pattern.test(file));
}

export function findViolations(changed, iosLoaded) {
  if (!changed.some(isAndroidOnly)) return [];
  return changed.filter((file) => iosLoaded.has(file) && !SHARED_TOKENS.has(file)).sort();
}

export function readSourceMaps(dir) {
  const maps = readdirSync(dir, { recursive: true })
    .map(String)
    .filter((file) => file.endsWith('.map') && /(^|[\\/])ios[\\/]|\.ios\b|entry-/.test(file));
  if (maps.length === 0)
    throw new Error(`No iOS source map under ${dir}; export with --source-maps`);
  const loaded = new Set();
  for (const map of maps) {
    const { sources = [], sourceRoot = '' } = JSON.parse(readFileSync(path.join(dir, map), 'utf8'));
    for (const source of sources) {
      if (!source || source.includes('node_modules')) continue;
      // Metro writes app sources rooted at the project ("/src/...") unless a sourceRoot is set.
      const absolute = sourceRoot
        ? path.resolve(sourceRoot, source)
        : source.startsWith(mobileRoot)
          ? source
          : path.join(mobileRoot, source);
      const relative = path.relative(mobileRoot, absolute).split(path.sep).join('/');
      if (!relative.startsWith('..')) loaded.add(relative);
    }
  }
  if (loaded.size === 0) throw new Error('The iOS source map lists no app files');
  return loaded;
}

function changedFiles(base) {
  // Both sides of a rename count: moving a file iOS loads changes what iOS loads.
  const out = execFileSync(
    'git',
    ['diff', '--name-status', '--no-renames', `${base}...HEAD`, '--', MOBILE],
    { cwd: repoRoot, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 },
  );
  return out
    .split('\n')
    .filter(Boolean)
    .map((line) => line.split('\t').pop().slice(MOBILE.length));
}

function main() {
  const args = process.argv.slice(2);
  const value = (name) => {
    const index = args.indexOf(name);
    return index === -1 ? undefined : args[index + 1];
  };
  const base = value('--base');
  const exportDir = value('--export-dir');
  if (!base || !exportDir) {
    console.error('usage: check-android-ui-isolation.mjs --base <ref> --export-dir <dir>');
    process.exit(2);
  }
  const changed = changedFiles(base);
  if (!changed.some(isAndroidOnly)) {
    console.log('No Android-only file changed; nothing to check.');
    return;
  }
  const violations = findViolations(changed, readSourceMaps(path.resolve(exportDir)));
  if (violations.length === 0) {
    console.log('Android change touches no file the iOS app loads.');
    return;
  }
  console.error(
    'This pull request changes Android-only files and also files the iOS app loads:\n' +
      violations.map((file) => `  ${MOBILE}${file}`).join('\n') +
      '\n\nAndroid UI must not change iOS. Copy the file to a .android.tsx sibling (or into ' +
      'src/android/) and edit the copy. A change iOS needs goes in its own pull request.',
  );
  process.exit(1);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
