#!/usr/bin/env node
// Keeps the Android and iOS apps apart. iOS ships from main and Android from android/beta;
// neither may carry the other's work. The fork point is where android/beta left main
// (`git merge-base origin/main HEAD`): every file of that tree belongs to iOS.
//
//   files       Into android/beta: a file of the fork point's tree may change only back to its
//               fork-point content, and new files go under Android-only paths. Into main: no
//               Android-only file may change.
//   fingerprint Writes what the iOS app is made of: its config and Info.plist, the generated Xcode
//               project, native autolinking, every module the iOS bundle contains (by content) with
//               its package version, and the NativeWind style data.
//   compare-ios Diffs two fingerprints (the PR's and the fork point's). Any difference fails:
//               Android work never changes what the iOS app is built from.
//   shared      Lists app files both bundles contain. Any one fails: Android loads no file iOS
//               loads.
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';

const MOBILE = 'openwhispr-mobile/';
const mobileRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const repoRoot = path.resolve(mobileRoot, '..');

// Files only the Android app can load. A PR that changes any of them is an Android PR.
const ANDROID_ONLY = [
  /\.android\.[cm]?[jt]sx?$/,
  /\.android\.(?:test|spec)\.[cm]?[jt]sx?$/,
  /^src\/android\//,
  /^modules\/android-[^/]+\//,
  /^modules\/[^/]+\/android\//,
  /^app\/android-[^/]+\.[jt]sx?$/,
  /^app-android\//,
  /^app\/\(tabs\)\/\(style\)\//,
  /^assets\/android\//,
  /^plugins\/android-[^/]+\//,
  /^scripts\/android-[^/]+/,
  /^config\/easignore\.android$/,
  /^config\/router-context\.android\.js$/,
];

// Files both platforms build from. A change to one is checked by compare-ios (iOS must come out
// the same), not by content.
const SHARED_BUILD = [
  /^package(?:-lock)?\.json$/,
  /^app\.base\.json$/,
  /^app\.config\.js$/,
  /^eas\.json$/,
  /^(?:metro|babel|jest)\.config\.js$/,
  // Its iOS output is the stylesheet, which the fingerprint's style data checks rule by rule.
  /^tailwind\.config\.js$/,
  /^jest\.setup\.js$/,
  /^react-native\.config\.js$/,
  /^config\/platform-styles(?:-transformer)?\.js$/,
  /^config\/router-context\.ios\.js$/,
  /^index\.ts$/,
  /^\.env\.example$/,
  /^scripts\/check-android-ui-isolation\.mjs$/,
  /^scripts\/__tests__\/android-ui-isolation\.test\.mjs$/,
  /^scripts\/__tests__\/fixtures\/android-ui-isolation\//,
];

// Text with no effect on either app.
const DOCS = [/\.md$/, /^docs\//];

// Packages with no iOS side, so a patch to them cannot change iOS.
const ANDROID_PACKAGES = ['@react-native/gradle-plugin'];

export const isAndroidOnly = (file) => ANDROID_ONLY.some((pattern) => pattern.test(file));
export const isSharedBuild = (file) => SHARED_BUILD.some((pattern) => pattern.test(file));

function git(args, options = {}) {
  return execFileSync('git', args, {
    cwd: repoRoot,
    encoding: 'utf8',
    maxBuffer: 256 * 1024 * 1024,
    ...options,
  });
}

function blob(ref, file) {
  try {
    return git(['rev-parse', `${ref}:${MOBILE}${file}`], {
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
  } catch {
    return null;
  }
}

// --- files -----------------------------------------------------------------------------------

// change: { status: 'A' | 'M' | 'D', file, head: blob|null, fork: blob|null }
export function fileViolations(changes, { target, iosExcludedPackages: excluded = [] }) {
  const problems = [];
  // Everything that isn't main is Android work (android/beta, or a PR stacked on one into it).
  const intoMain = target === 'main';
  for (const { status, file, head, fork, patchTargets: patched = [] } of changes) {
    if (intoMain) {
      if (isAndroidOnly(file))
        problems.push(`${file}: Android-only files never change in a pull request into ${target}`);
      continue;
    }
    if (isAndroidOnly(file) || DOCS.some((pattern) => pattern.test(file))) continue;
    if (fork !== null) {
      if (isSharedBuild(file)) continue;
      if (head !== fork)
        problems.push(
          `${file}: belongs to iOS (it is in main at the fork point) and may only change back to that content`,
        );
      continue;
    }
    if (status !== 'A') continue;
    if (isSharedBuild(file)) continue;
    if (/^patches\/[^/]+\.patch$/.test(file)) {
      const ios = patched.filter(
        (patchedFile) =>
          !/\/android\//.test(patchedFile) &&
          ![...ANDROID_PACKAGES, ...excluded].some((pkg) =>
            patchedFile.startsWith(`node_modules/${pkg}/`),
          ),
      );
      if (ios.length > 0)
        problems.push(
          `${file}: patches files iOS builds (${ios.join(', ')}); only Android parts may be patched`,
        );
      continue;
    }
    problems.push(
      `${file}: new Android code goes under an Android-only path (src/android/, *.android.ts, …)`,
    );
  }
  return problems.sort();
}

function changedFiles(base) {
  const out = git(['diff', '--name-status', '--no-renames', `${base}...HEAD`, '--', MOBILE]);
  return out
    .split('\n')
    .filter(Boolean)
    .map((line) => {
      const [status, name] = line.split('\t');
      return { status: status[0], file: name.slice(MOBILE.length) };
    });
}

function iosExcludedPackages() {
  const config = path.join(mobileRoot, 'react-native.config.js');
  if (!existsSync(config)) return [];
  const { dependencies = {} } = JSON.parse(
    execFileSync(
      process.execPath,
      ['-e', `console.log(JSON.stringify(require(${JSON.stringify(config)})))`],
      {
        encoding: 'utf8',
      },
    ),
  );
  return Object.entries(dependencies)
    .filter(([, value]) => value?.platforms && value.platforms.ios === null)
    .map(([name]) => name);
}

function patchTargets(file) {
  const text = readFileSync(path.join(mobileRoot, file), 'utf8');
  return [...text.matchAll(/^\+\+\+ b\/(\S+)/gm)].map((match) => match[1]);
}

function runFiles({ base, target, forkRef }) {
  const fork = git(['merge-base', forkRef, 'HEAD']).trim();
  const excluded = iosExcludedPackages();
  const changes = changedFiles(base).map((change) => ({
    ...change,
    head: blob('HEAD', change.file),
    fork: blob(fork, change.file),
    patchTargets:
      change.status !== 'D' && /^patches\//.test(change.file) ? patchTargets(change.file) : [],
  }));
  const problems = fileViolations(changes, { target, iosExcludedPackages: excluded });
  console.log(`Fork point with main: ${fork.slice(0, 9)}; ${changes.length} changed mobile files.`);
  if (problems.length === 0) {
    console.log('No file crosses between Android and iOS.');
    return 0;
  }
  console.error(
    'Android and iOS stay apart: nothing from Android goes into iOS and nothing from iOS into Android.\n' +
      problems.map((problem) => `  ${MOBILE}${problem}`).join('\n') +
      '\n\nCopy the file under src/android/ (or a .android.ts sibling) and change the copy. ' +
      'A file iOS owns may only be restored to its fork-point content.',
  );
  return 1;
}

// --- source maps -----------------------------------------------------------------------------

function mapFiles(dir) {
  return readdirSync(dir, { recursive: true })
    .map(String)
    .filter((file) => file.endsWith('.map'))
    .map((file) => path.join(dir, file));
}

// Metro writes app sources rooted at the project ("/src/...").
export function normaliseSource(source) {
  if (!source || source.startsWith('\u0000')) return null;
  let file = source.replace(/\\/g, '/').replace(/^\/+/, '');
  const index = file.indexOf('node_modules/');
  if (index > 0) file = file.slice(index);
  // The iOS bundle reads NativeWind from the `nativewind-ios` alias (the version main uses).
  return file
    .replace(/^node_modules\/nativewind-ios\/node_modules\//, 'node_modules/')
    .replace(/^node_modules\/nativewind-ios\//, 'node_modules/nativewind/');
}

// Returns normalised path -> { raw, content }.
export function readSources(dir, { withContent = false } = {}) {
  const maps = mapFiles(dir);
  if (maps.length === 0) throw new Error(`No source map under ${dir}; export with --source-maps`);
  const sources = new Map();
  for (const map of maps) {
    const { sources: list = [], sourcesContent = [] } = JSON.parse(readFileSync(map, 'utf8'));
    list.forEach((source, index) => {
      const file = normaliseSource(source);
      if (!file) return;
      const raw = source.replace(/\\/g, '/').replace(/^\/+/, '');
      const nodeModules = raw.indexOf('node_modules/');
      sources.set(file, {
        raw: nodeModules > 0 ? raw.slice(nodeModules) : raw,
        content: withContent ? (sourcesContent[index] ?? '') : '',
      });
    });
  }
  return sources;
}

export function appFiles(sources) {
  return [...sources.keys()].filter((file) => !file.startsWith('node_modules/')).sort();
}

// --- fingerprint -----------------------------------------------------------------------------

// Not iOS code: the entry shim and Expo Router's context, which the isolation itself replaces.
// Also skipped: Metro's per-build debug id, the route context's virtual module (named by a hash
// of its file filter), and NativeWind's generated stylesheet cache, which the style entries cover.
const PLUMBING_MODULES = new Set([
  'index.ts',
  'config/router-context.ios.js',
  'node_modules/expo-router/_ctx.ios.js',
  '__debugid__',
]);
const isPlumbingModule = (file) =>
  PLUMBING_MODULES.has(file) ||
  file.startsWith('app?ctx=') ||
  /^node_modules\/react-native-css-interop\/\.cache\//.test(file);

const sha = (text) => createHash('sha256').update(text).digest('hex').slice(0, 16);

// Package versions from the project's lockfile, looked up by the path Metro actually read (so the
// nativewind-ios alias reports its own version) and reported under the normalised path.
function packageVersions(projectDir, sources) {
  const lock = JSON.parse(
    readFileSync(path.join(projectDir, 'package-lock.json'), 'utf8'),
  ).packages;
  const keys = Object.keys(lock)
    .filter(Boolean)
    .sort((a, b) => b.length - a.length);
  const versions = {};
  for (const { raw } of sources.values()) {
    if (!raw.startsWith('node_modules/')) continue;
    const key = keys.find((candidate) => raw.startsWith(`${candidate}/`));
    if (key) versions[normaliseSource(key + '/x').slice(0, -2)] = lock[key].version;
  }
  return versions;
}

// Pulls the object passed to NativeWind's injectData() out of a plain-JS bundle.
export function extractStyleData(bundle) {
  const calls = [];
  const marker = /injectData\)\(/g;
  let match;
  while ((match = marker.exec(bundle))) {
    let depth = 0;
    let index = match.index + match[0].length;
    const start = index;
    // NativeWind's own forwarding call passes a variable; only the stylesheet passes a literal.
    if (bundle[start] !== '{') continue;
    for (; index < bundle.length; index += 1) {
      const char = bundle[index];
      if (char === '"' || char === "'") {
        const quote = char;
        for (index += 1; index < bundle.length && bundle[index] !== quote; index += 1)
          if (bundle[index] === '\\') index += 1;
      } else if (char === '(' || char === '{' || char === '[') depth += 1;
      else if (char === ')' || char === '}' || char === ']') {
        if (depth === 0) break;
        depth -= 1;
      }
    }
    calls.push(vm.runInNewContext(`(${bundle.slice(start, index)})`, Object.create(null)));
  }
  return calls;
}

// Each rule's first specificity number is its position in the stylesheet; it shifts whenever a
// rule is added before it. Compare rule bodies without it, and the order of shared rules apart.
export function styleEntries(calls) {
  const entries = {};
  calls.forEach((data, call) => {
    const { rules = {}, ...rest } = data;
    entries[`style:${call}:meta`] = sha(JSON.stringify(rest));
    const order = [];
    for (const [name, body] of Object.entries(rules)) {
      const positions = [];
      const stripped = JSON.parse(JSON.stringify(body), (key, value) => {
        if (key === 's' && Array.isArray(value)) {
          positions.push(value[0]);
          return ['#', ...value.slice(1)];
        }
        return value;
      });
      entries[`style:${call}:rule:${name}`] = sha(JSON.stringify(stripped));
      order.push([Math.min(...positions, Infinity), name]);
    }
    entries[`style:${call}:order`] = order
      .sort((a, b) => a[0] - b[0])
      .map(([, name]) => name)
      .join(' ');
  });
  return entries;
}

function introspect(projectDir, env) {
  const out = execFileSync(
    path.join(projectDir, 'node_modules/.bin/expo'),
    ['config', '--type', 'introspect', '--json'],
    {
      cwd: projectDir,
      encoding: 'utf8',
      maxBuffer: 64 * 1024 * 1024,
      env: {
        ...process.env,
        CI: '1',
        EXPO_NO_DOTENV: '1',
        OPENWHISPR_APP_ENV: env,
        EXPO_PLATFORM: 'ios',
      },
      stdio: ['ignore', 'pipe', 'ignore'],
    },
  );
  return JSON.parse(out).ios ?? {};
}

function flatten(value, prefix, out) {
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    for (const key of Object.keys(value).sort())
      flatten(value[key], prefix ? `${prefix}.${key}` : key, out);
  } else out[prefix] = JSON.stringify(value);
  return out;
}

function prebuiltProject(projectDir) {
  const iosDir = path.join(projectDir, 'ios');
  if (existsSync(iosDir)) throw new Error(`${iosDir} already exists; run on a clean checkout`);
  execFileSync(
    path.join(projectDir, 'node_modules/.bin/expo'),
    ['prebuild', '-p', 'ios', '--no-install'],
    {
      cwd: projectDir,
      env: { ...process.env, CI: '1', EXPO_NO_DOTENV: '1', OPENWHISPR_APP_ENV: 'production' },
      stdio: ['ignore', 'ignore', 'inherit'],
    },
  );
  const entries = {};
  try {
    for (const file of readdirSync(iosDir, { recursive: true }).map(String).sort()) {
      const full = path.join(iosDir, file);
      if (
        !/\.(?:plist|entitlements|pbxproj|storyboard|json|xcprivacy|swift|h|m|mm)$|^Podfile$/.test(
          path.basename(full),
        )
      )
        continue;
      let text = readFileSync(full, 'utf8');
      // Xcode object ids are random per prebuild.
      if (file.endsWith('.pbxproj'))
        text = text
          .replace(/[0-9A-F]{24}/g, 'ID')
          .split('\n')
          .sort()
          .join('\n');
      entries[`native:${file}`] = sha(text);
    }
  } finally {
    rmSync(iosDir, { recursive: true, force: true });
  }
  return entries;
}

function autolinking(projectDir) {
  const bin = path.join(
    projectDir,
    'node_modules/expo-modules-autolinking/bin/expo-modules-autolinking.js',
  );
  const run = (args) =>
    JSON.parse(
      execFileSync(process.execPath, [bin, ...args], {
        cwd: projectDir,
        encoding: 'utf8',
        maxBuffer: 64 * 1024 * 1024,
      }),
    );
  const expo = run(['resolve', '-p', 'ios', '--json']).modules.map((module) => module.packageName);
  const native = Object.keys(
    run(['react-native-config', '--platform', 'ios', '--json']).dependencies,
  );
  return {
    'autolink:expo': [...expo].sort().join(' '),
    'autolink:react-native': [...native].sort().join(' '),
  };
}

export function buildFingerprint({ sources, versions, styles, config, native = {}, links = {} }) {
  const entries = {};
  for (const [file, { content }] of sources) {
    if (isPlumbingModule(file)) continue;
    entries[`module:${file}`] = sha(content);
  }
  for (const [pkg, version] of Object.entries(versions)) entries[`package:${pkg}`] = version;
  Object.assign(entries, styles, native, links);
  for (const [env, ios] of Object.entries(config)) {
    for (const [key, value] of Object.entries(flatten(ios, '', {})))
      entries[`config:${env}:${key}`] = value;
  }
  return Object.fromEntries(Object.entries(entries).sort(([a], [b]) => a.localeCompare(b)));
}

function runFingerprint({ project, exportDir, out }) {
  const projectDir = path.resolve(project);
  const sources = readSources(path.resolve(exportDir), { withContent: true });
  const bundles = readdirSync(path.resolve(exportDir), { recursive: true })
    .map(String)
    .filter((file) => file.endsWith('.js') && /(^|[\\/])ios[\\/]/.test(file));
  if (bundles.length === 0) throw new Error('No plain-JS iOS bundle; export with --no-bytecode');
  const styles = styleEntries(
    bundles.flatMap((file) =>
      extractStyleData(readFileSync(path.join(path.resolve(exportDir), file), 'utf8')),
    ),
  );
  const config = {
    production: introspect(projectDir, 'production'),
    development: introspect(projectDir, 'development'),
  };
  const fingerprint = buildFingerprint({
    sources,
    versions: packageVersions(projectDir, sources),
    styles,
    config,
    native: prebuiltProject(projectDir),
    links: autolinking(projectDir),
  });
  writeFileSync(path.resolve(out), `${JSON.stringify(fingerprint, null, 1)}\n`);
  console.log(`Wrote ${Object.keys(fingerprint).length} iOS fingerprint entries to ${out}`);
  return 0;
}

// --- compare-ios / shared --------------------------------------------------------------------

export function diffFingerprints(head, fork) {
  const keys = new Set([...Object.keys(head), ...Object.keys(fork)]);
  return [...keys].filter((key) => head[key] !== fork[key]).sort();
}

function report(found, { what, fix }) {
  if (found.length === 0) {
    console.log(`${what}: none.`);
    return 0;
  }
  console.error(`${what}:\n${found.map((entry) => `  + ${entry}`).join('\n')}\n\n${fix}`);
  return 1;
}

function runCompareIos({ head, fork }) {
  return report(
    diffFingerprints(
      JSON.parse(readFileSync(path.resolve(head), 'utf8')),
      JSON.parse(readFileSync(path.resolve(fork), 'utf8')),
    ),
    {
      what: 'iOS differs from main at the fork point',
      fix: 'Android work must not change what the iOS app is built from. Move the change to an Android-only file.',
    },
  );
}

export function sharedFiles(ios, android) {
  const iosSet = new Set(appFiles(ios));
  return appFiles(android).filter((file) => iosSet.has(file));
}

function runShared({ iosExport, androidExport }) {
  return report(
    sharedFiles(readSources(path.resolve(iosExport)), readSources(path.resolve(androidExport))),
    {
      what: 'Android loads files iOS loads',
      fix: 'Give Android its own copy (src/android/ or a .android.ts sibling) instead of importing the iOS file.',
    },
  );
}

// --- cli -------------------------------------------------------------------------------------

function main() {
  const [command, ...args] = process.argv.slice(2);
  const value = (name) => {
    const index = args.indexOf(name);
    return index === -1 ? undefined : args[index + 1];
  };
  const need = (...names) => {
    const missing = names.filter((name) => !value(name));
    if (missing.length) {
      console.error(`${command}: missing ${missing.join(', ')}`);
      process.exit(2);
    }
  };
  switch (command) {
    case 'files':
      need('--base', '--target');
      return runFiles({
        base: value('--base'),
        target: value('--target'),
        forkRef: value('--fork-ref') ?? 'origin/main',
      });
    case 'fingerprint':
      need('--project', '--export-dir', '--out');
      return runFingerprint({
        project: value('--project'),
        exportDir: value('--export-dir'),
        out: value('--out'),
      });
    case 'compare-ios':
      need('--head', '--fork');
      return runCompareIos({ head: value('--head'), fork: value('--fork') });
    case 'shared':
      need('--ios-export', '--android-export');
      return runShared({
        iosExport: value('--ios-export'),
        androidExport: value('--android-export'),
      });
    default:
      console.error('usage: check-android-ui-isolation.mjs files|fingerprint|compare-ios|shared …');
      return 2;
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url))
  process.exit(main());
