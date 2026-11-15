import assert from 'node:assert/strict';
import test from 'node:test';
import { findViolations, isAndroidOnly } from '../check-android-ui-isolation.mjs';

const iosLoaded = new Set([
  'src/screens/HomeScreen.tsx',
  'src/components/ui/Fab.tsx',
  'src/lib/utils.ts',
  'tailwind.config.js',
]);

test('recognises files only Android loads', () => {
  for (const file of [
    'src/screens/HomeScreen.android.tsx',
    'src/android/Tabs.tsx',
    'modules/android-dictation/android/src/main/Bubble.kt',
    'app/android-setup.tsx',
  ]) {
    assert.equal(isAndroidOnly(file), true, file);
  }
  for (const file of ['src/screens/HomeScreen.tsx', 'app/index.tsx', 'src/lib/android.ts']) {
    assert.equal(isAndroidOnly(file), false, file);
  }
});

test('an Android change may not touch a file iOS loads', () => {
  assert.deepEqual(
    findViolations(
      ['src/screens/HomeScreen.android.tsx', 'src/screens/HomeScreen.tsx', 'src/lib/utils.ts'],
      iosLoaded,
    ),
    ['src/lib/utils.ts', 'src/screens/HomeScreen.tsx'],
  );
});

test('Android-only changes and shared design tokens pass', () => {
  assert.deepEqual(
    findViolations(['src/android/Tabs.tsx', 'tailwind.config.js', 'src/android/ui.tsx'], iosLoaded),
    [],
  );
});

test('a change with no Android file is not an Android change', () => {
  assert.deepEqual(findViolations(['src/screens/HomeScreen.tsx'], iosLoaded), []);
});
