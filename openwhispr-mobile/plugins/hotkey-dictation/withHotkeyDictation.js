/**
 * Expo config plugin that compiles the hotkey dictation Swift sources into the
 * main app target.
 *
 * Why the app target and not a module pod: App Intents metadata (and the
 * AppShortcutsProvider that surfaces the action in Shortcuts) is extracted from
 * the app target's own sources, and the intent must run in the app's process,
 * where the warm-mic session lives.
 */

const { withDangerousMod, withXcodeProject } = require('expo/config-plugins');
const fs = require('fs');
const path = require('path');

const SOURCE_DIR = path.join(__dirname, 'ios');

function sourceFiles() {
  return fs
    .readdirSync(SOURCE_DIR)
    .filter((name) => name.endsWith('.swift'))
    .sort();
}

function findMainGroupKey(xcodeProject, projectName) {
  const groups = xcodeProject.hash.project.objects.PBXGroup || {};
  for (const key of Object.keys(groups)) {
    if (key.endsWith('_comment')) continue;
    const group = groups[key];
    if (group?.name === projectName || group?.path === projectName) return key;
  }
  return null;
}

function findMainTargetUuid(xcodeProject, projectName) {
  const targets = xcodeProject.pbxNativeTargetSection() || {};
  for (const key of Object.keys(targets)) {
    if (key.endsWith('_comment')) continue;
    if ((targets[key]?.name ?? '').replace(/"/g, '') === projectName) return key;
  }
  return null;
}

function hasFileReference(xcodeProject, fileName) {
  const refs = xcodeProject.pbxFileReferenceSection() || {};
  return Object.keys(refs).some((key) => {
    if (key.endsWith('_comment')) return false;
    const ref = refs[key];
    return (ref?.path ?? ref?.name ?? '').replace(/"/g, '').endsWith(`/${fileName}`);
  });
}

module.exports = function withHotkeyDictation(config) {
  config = withDangerousMod(config, [
    'ios',
    async (cfg) => {
      const projectName = cfg.modRequest.projectName ?? 'OpenWhispr';
      for (const fileName of sourceFiles()) {
        fs.copyFileSync(
          path.join(SOURCE_DIR, fileName),
          path.join(cfg.modRequest.platformProjectRoot, projectName, fileName),
        );
      }
      return cfg;
    },
  ]);

  config = withXcodeProject(config, (cfg) => {
    const xcodeProject = cfg.modResults;
    const projectName = cfg.modRequest.projectName ?? 'OpenWhispr';
    const groupKey = findMainGroupKey(xcodeProject, projectName);
    const targetUuid = findMainTargetUuid(xcodeProject, projectName);
    if (!groupKey || !targetUuid) {
      console.warn('[hotkey-dictation] Could not find the main group or target');
      return cfg;
    }
    for (const fileName of sourceFiles()) {
      if (hasFileReference(xcodeProject, fileName)) continue;
      // Same shape as AppDelegate.swift: a <group>-relative path under the unpathed main group.
      const file = xcodeProject.addSourceFile(
        `${projectName}/${fileName}`,
        { target: targetUuid, lastKnownFileType: 'sourcecode.swift' },
        groupKey,
      );
      // The xcode lib leaks undefined fields as literal "undefined" strings; an
      // explicitFileType of "undefined" would override the Swift file type.
      const ref = file && xcodeProject.pbxFileReferenceSection()[file.fileRef];
      if (ref) {
        delete ref.explicitFileType;
        delete ref.includeInIndex;
      }
    }
    return cfg;
  });

  return config;
};
