/**
 * Expo config plugin that adds a minimal Settings.bundle to the iOS app.
 *
 * Why: on iOS 18+, Apple deep-links `app-settings:` (the URL behind
 * Linking.openSettings()) to Settings → Apps → [App Name] only when the app
 * has registered "settings-like" state with the OS. A granted privacy
 * permission used to be enough; in iOS 26 it is sometimes not. Shipping an
 * empty Settings.bundle forces iOS to recognize the app as having a per-app
 * settings page, which makes the deep-link reliable.
 *
 * The bundle is intentionally empty (no preferences) — we only need its
 * existence. iOS still shows the OpenWhispr keyboard/permission rows in the
 * per-app page automatically.
 */

const { withXcodeProject, withDangerousMod } = require('expo/config-plugins');
const fs = require('fs');
const path = require('path');
const pbxFile = require('xcode/lib/pbxFile');

const BUNDLE_NAME = 'Settings.bundle';

const ROOT_PLIST_CONTENTS = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>StringsTable</key>
  <string>Root</string>
  <key>PreferenceSpecifiers</key>
  <array/>
</dict>
</plist>
`;

function writeSettingsBundleFiles(projectRoot, projectName) {
  const bundleDir = path.join(projectRoot, 'ios', projectName, BUNDLE_NAME);
  fs.mkdirSync(bundleDir, { recursive: true });
  fs.writeFileSync(path.join(bundleDir, 'Root.plist'), ROOT_PLIST_CONTENTS);
}

function findMainGroupKey(xcodeProject, projectName) {
  const groups = xcodeProject.hash.project.objects.PBXGroup || {};
  for (const key of Object.keys(groups)) {
    if (key.endsWith('_comment')) continue;
    const group = groups[key];
    if (!group || typeof group !== 'object') continue;
    if (group.name === projectName || group.path === projectName) {
      return key;
    }
  }
  return null;
}

function findMainTargetUuid(xcodeProject, projectName) {
  const targets = xcodeProject.pbxNativeTargetSection() || {};
  for (const key of Object.keys(targets)) {
    if (key.endsWith('_comment')) continue;
    const target = targets[key];
    if (!target || typeof target !== 'object') continue;
    const name = (target.name ?? '').replace(/"/g, '');
    if (name === projectName) return key;
  }
  return null;
}

function alreadyAdded(xcodeProject) {
  const refs = xcodeProject.pbxFileReferenceSection() || {};
  for (const key of Object.keys(refs)) {
    if (key.endsWith('_comment')) continue;
    const ref = refs[key];
    const candidate = ref?.name ?? ref?.path ?? '';
    if (candidate.includes(BUNDLE_NAME)) return true;
  }
  return false;
}

function findResourcesBuildPhase(xcodeProject, targetUuid) {
  if (!targetUuid) return null;
  const target = xcodeProject.pbxNativeTargetSection()[targetUuid];
  if (!target?.buildPhases) return null;
  const phases = xcodeProject.hash.project.objects.PBXResourcesBuildPhase || {};
  for (const ref of target.buildPhases) {
    const phase = phases[ref.value];
    if (phase) return phase;
  }
  return null;
}

function addBundleToXcodeProject(xcodeProject, projectName) {
  if (alreadyAdded(xcodeProject)) return;

  const groupKey = findMainGroupKey(xcodeProject, projectName);
  if (!groupKey) {
    console.warn(`[settings-bundle] Could not find PBXGroup for ${projectName}`);
    return;
  }

  const targetUuid = findMainTargetUuid(xcodeProject, projectName);
  const resourcesPhase = findResourcesBuildPhase(xcodeProject, targetUuid);
  if (!resourcesPhase) {
    console.warn('[settings-bundle] Could not find PBXResourcesBuildPhase');
    return;
  }

  // Use SOURCE_ROOT (= the ios/ folder where the .xcodeproj lives) and an
  // explicit path so we don't depend on whichever PBXGroup we attach to
  // having its own path set correctly.
  const file = new pbxFile(`${projectName}/${BUNDLE_NAME}`, {
    lastKnownFileType: 'wrapper.plug-in',
    sourceTree: 'SOURCE_ROOT',
  });
  file.name = BUNDLE_NAME;
  file.basename = BUNDLE_NAME;
  file.uuid = xcodeProject.generateUuid();
  file.fileRef = xcodeProject.generateUuid();

  // The xcode lib leaks undefined fields as literal "undefined" strings in
  // the serialized pbxproj. Strip them so Xcode sees a clean entry.
  delete file.explicitFileType;
  delete file.fileEncoding;

  // 1. PBXFileReference — the actual file on disk
  xcodeProject.addToPbxFileReferenceSection(file);

  // 2. Attach to the app's main group so it shows in the project navigator
  const mainGroup = xcodeProject.getPBXGroupByKey(groupKey);
  if (mainGroup) {
    mainGroup.children = mainGroup.children || [];
    mainGroup.children.push({ value: file.fileRef, comment: file.basename });
  }

  // 3. PBXBuildFile — the target-side reference
  xcodeProject.addToPbxBuildFileSection(file);

  // 4. Add to the Resources build phase so Xcode copies it into the app bundle
  resourcesPhase.files = resourcesPhase.files || [];
  resourcesPhase.files.push({
    value: file.uuid,
    comment: `${file.basename} in Resources`,
  });
}

module.exports = function withSettingsBundle(config) {
  config = withDangerousMod(config, [
    'ios',
    async (cfg) => {
      const projectName = cfg.modRequest.projectName ?? 'OpenWhispr';
      writeSettingsBundleFiles(cfg.modRequest.projectRoot, projectName);
      return cfg;
    },
  ]);

  config = withXcodeProject(config, (cfg) => {
    const projectName = cfg.modRequest.projectName ?? 'OpenWhispr';
    addBundleToXcodeProject(cfg.modResults, projectName);
    return cfg;
  });

  return config;
};
