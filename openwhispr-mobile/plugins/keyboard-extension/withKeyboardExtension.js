const {
  withXcodeProject,
  withEntitlementsPlist,
  withDangerousMod,
} = require('expo/config-plugins');
const fs = require('fs');
const path = require('path');
const xcode = require('xcode');
const plist = require('@expo/plist').default;
const {
  deriveAppGroupId,
  resolveOpenWhisprEnvironment,
} = require('../../config/openwhispr-environments');

const EXTENSION_NAME = 'OpenWhisprKeyboard';
const EXTENSION_BUNDLE_ID_SUFFIX = 'keyboard';
// Copied from ios/ into the generated project and wired into the keyboard target.
const EXTENSION_FILES = [
  { name: 'KeyboardViewController.swift', fileType: 'sourcecode.swift', phase: 'Sources' },
  { name: 'KeyboardCapitalization.swift', fileType: 'sourcecode.swift', phase: 'Sources' },
];
const BUILD_PHASE_ISA = {
  Sources: 'PBXSourcesBuildPhase',
};

function firstScheme(value) {
  if (Array.isArray(value)) {
    return value.find((item) => typeof item === 'string' && item.trim());
  }
  return typeof value === 'string' && value.trim() ? value : null;
}

function resolveKeyboardEnvironment(cfg) {
  const configured = cfg.extra?.openWhispr ?? resolveOpenWhisprEnvironment();
  const bundleIdentifier =
    configured.iosBundleIdentifier || cfg.ios?.bundleIdentifier || 'com.gizmolabs.openwhispr';
  const scheme = configured.scheme || firstScheme(cfg.scheme) || 'openwhispr';
  const displayName = configured.displayName || cfg.name || 'OpenWhispr';

  return {
    ...configured,
    displayName,
    keyboardDisplayName: configured.keyboardDisplayName || displayName,
    scheme,
    iosBundleIdentifier: bundleIdentifier,
    keyboardBundleIdentifier:
      configured.keyboardBundleIdentifier || `${bundleIdentifier}.${EXTENSION_BUNDLE_ID_SUFFIX}`,
    appGroupId: configured.appGroupId || deriveAppGroupId(bundleIdentifier),
  };
}

function setApplicationGroup(entitlements, appGroupId) {
  const key = 'com.apple.security.application-groups';
  entitlements[key] = [appGroupId];
}

function unique(values) {
  return [...new Set(values.filter(Boolean))];
}

function readPlist(filePath) {
  return plist.parse(fs.readFileSync(filePath, 'utf8'));
}

function writePlist(filePath, value) {
  fs.writeFileSync(filePath, plist.build(value));
}

function writeExtensionSupportFiles(platformProjectRoot, environment) {
  const pluginSourceDir = path.join(__dirname, 'ios');
  const extensionDir = path.join(platformProjectRoot, EXTENSION_NAME);

  if (!fs.existsSync(extensionDir)) {
    fs.mkdirSync(extensionDir, { recursive: true });
  }

  for (const file of EXTENSION_FILES) {
    fs.copyFileSync(path.join(pluginSourceDir, file.name), path.join(extensionDir, file.name));
  }

  const infoPlist = readPlist(path.join(pluginSourceDir, 'Info.plist'));
  infoPlist.CFBundleDisplayName = environment.keyboardDisplayName;
  infoPlist.OpenWhisprAppScheme = environment.scheme;
  infoPlist.OpenWhisprContainingAppBundleIdentifier = environment.iosBundleIdentifier;
  infoPlist.LSApplicationQueriesSchemes = unique([
    environment.scheme,
    environment.iosBundleIdentifier,
    ...(infoPlist.LSApplicationQueriesSchemes || []),
  ]);
  writePlist(path.join(extensionDir, 'Info.plist'), infoPlist);

  const entitlements = readPlist(path.join(pluginSourceDir, 'OpenWhisprKeyboard.entitlements'));
  setApplicationGroup(entitlements, environment.appGroupId);
  writePlist(path.join(extensionDir, `${EXTENSION_NAME}.entitlements`), entitlements);
}

function getBuildConfigurationIdsForTarget(xcodeProject, targetUuid) {
  const nativeTargets = xcodeProject.pbxNativeTargetSection();
  const target = nativeTargets?.[targetUuid];
  if (!target?.buildConfigurationList) {
    return [];
  }

  const configLists = xcodeProject.pbxXCConfigurationList();
  const configList = configLists?.[target.buildConfigurationList];
  if (!configList?.buildConfigurations) {
    return [];
  }

  return configList.buildConfigurations.map((item) => item?.value).filter(Boolean);
}

function applyBuildSettingsToTarget(xcodeProject, targetUuid, buildSettings) {
  const buildConfigurationIds = getBuildConfigurationIdsForTarget(xcodeProject, targetUuid);
  const configurations = xcodeProject.pbxXCBuildConfigurationSection();

  for (const configId of buildConfigurationIds) {
    const configuration = configurations[configId];
    if (!configuration?.buildSettings) {
      continue;
    }
    Object.assign(configuration.buildSettings, buildSettings);
  }
}

function getFirstDefinedTeamId(xcodeProject, targetUuid) {
  const buildConfigurationIds = getBuildConfigurationIdsForTarget(xcodeProject, targetUuid);
  const configurations = xcodeProject.pbxXCBuildConfigurationSection();

  for (const configId of buildConfigurationIds) {
    const teamId = configurations?.[configId]?.buildSettings?.DEVELOPMENT_TEAM;
    if (typeof teamId === 'string' && teamId.trim()) {
      return teamId.replace(/"/g, '').trim();
    }
  }

  return null;
}

function resolveDevelopmentTeamId(cfg, xcodeProject) {
  const configuredTeamId = cfg.ios?.appleTeamId;
  if (configuredTeamId) {
    return configuredTeamId;
  }

  const mainTarget = xcodeProject.getFirstTarget();
  if (mainTarget?.uuid) {
    const mainTargetTeamId = getFirstDefinedTeamId(xcodeProject, mainTarget.uuid);
    if (mainTargetTeamId) {
      return mainTargetTeamId;
    }
  }

  return process.env.APPLE_TEAM_ID || process.env.EXPO_APPLE_TEAM_ID || null;
}

function hasEmbeddedExtension(xcodeProject, hostTargetUuid, extensionProductRefUuid) {
  const nativeTargets = xcodeProject.pbxNativeTargetSection();
  const hostTarget = nativeTargets?.[hostTargetUuid];
  if (!hostTarget?.buildPhases) {
    return false;
  }

  const copyFilesPhases = xcodeProject.hash.project.objects.PBXCopyFilesBuildPhase || {};
  const buildFiles = xcodeProject.hash.project.objects.PBXBuildFile || {};

  for (const buildPhaseRef of hostTarget.buildPhases) {
    const phase = copyFilesPhases[buildPhaseRef.value];
    if (!phase || String(phase.dstSubfolderSpec) !== '13') {
      continue;
    }

    for (const fileRef of phase.files || []) {
      const buildFile = buildFiles[fileRef.value];
      if (extensionProductRefUuid && buildFile?.fileRef === extensionProductRefUuid) {
        return true;
      }

      if (
        !extensionProductRefUuid &&
        typeof fileRef.comment === 'string' &&
        fileRef.comment.includes(`${EXTENSION_NAME}.appex`)
      ) {
        return true;
      }
    }
  }

  return false;
}

// Looks only inside the extension's own group, so an app file that happens to share a
// name is never mistaken for (and moved into) the keyboard target.
function findGroupFileReferenceUuid(xcodeProject, groupKey, basename) {
  const fileRefs = xcodeProject.pbxFileReferenceSection();
  const children = xcodeProject.getPBXGroupByKey(groupKey)?.children || [];
  const child = children.find((entry) => {
    const ref = fileRefs[entry?.value];
    return [ref?.path, ref?.name].some(
      (value) => typeof value === 'string' && value.replace(/"/g, '') === basename,
    );
  });
  return child?.value ?? null;
}

function findBuildFileUuidForFileRef(xcodeProject, fileRefUuid) {
  const buildFiles = xcodeProject.hash.project.objects.PBXBuildFile || {};
  for (const [uuid, entry] of Object.entries(buildFiles)) {
    if (uuid.endsWith('_comment')) {
      continue;
    }

    if (entry?.fileRef === fileRefUuid) {
      return uuid;
    }
  }

  return null;
}

function ensureBuildFile(xcodeProject, fileRefUuid, fileName, phase) {
  const existingBuildFileUuid = findBuildFileUuidForFileRef(xcodeProject, fileRefUuid);
  if (existingBuildFileUuid) {
    return existingBuildFileUuid;
  }

  const buildFiles = xcodeProject.hash.project.objects.PBXBuildFile || {};
  const buildFileUuid = xcodeProject.generateUuid();
  buildFiles[buildFileUuid] = {
    isa: 'PBXBuildFile',
    fileRef: fileRefUuid,
    fileRef_comment: fileName,
  };
  buildFiles[`${buildFileUuid}_comment`] = `${fileName} in ${phase}`;
  xcodeProject.hash.project.objects.PBXBuildFile = buildFiles;

  return buildFileUuid;
}

function ensurePhaseMembershipForTarget(xcodeProject, targetUuid, buildFileUuid, fileName, phase) {
  const isa = BUILD_PHASE_ISA[phase];
  const targetPhaseUuid = ensureBuildPhaseExists(xcodeProject, targetUuid, phase);
  const allPhases = xcodeProject.hash.project.objects[isa] || {};
  const targetPhase = allPhases[targetPhaseUuid];
  if (!targetPhase) {
    return;
  }

  targetPhase.files = targetPhase.files || [];
  if (!targetPhase.files.some((entry) => entry?.value === buildFileUuid)) {
    targetPhase.files.push({ value: buildFileUuid, comment: `${fileName} in ${phase}` });
  }

  for (const [phaseUuid, other] of Object.entries(allPhases)) {
    if (phaseUuid.endsWith('_comment') || phaseUuid === targetPhaseUuid) {
      continue;
    }

    if (!Array.isArray(other?.files)) {
      continue;
    }

    other.files = other.files.filter((entry) => entry?.value !== buildFileUuid);
  }
}

function findTargetUuidByName(xcodeProject, targetName) {
  const nativeTargets = xcodeProject.pbxNativeTargetSection();
  for (const [uuid, target] of Object.entries(nativeTargets)) {
    if (uuid.endsWith('_comment')) {
      continue;
    }

    const normalizedName = typeof target?.name === 'string' ? target.name.replace(/"/g, '') : '';
    if (normalizedName === targetName) {
      return uuid;
    }
  }

  return null;
}

function ensureBuildPhaseExists(xcodeProject, targetUuid, phase) {
  const isa = BUILD_PHASE_ISA[phase];
  const nativeTargets = xcodeProject.pbxNativeTargetSection();
  const target = nativeTargets?.[targetUuid];
  if (!target?.buildPhases) {
    return null;
  }

  const phases = xcodeProject.hash.project.objects[isa] || {};
  for (const phaseRef of target.buildPhases) {
    const phaseUuid = phaseRef?.value || phaseRef;
    if (phases[phaseUuid]?.isa === isa) {
      return phaseUuid;
    }
  }

  const newPhaseUuid = xcodeProject.generateUuid();
  phases[newPhaseUuid] = {
    isa,
    buildActionMask: 2147483647,
    files: [],
    runOnlyForDeploymentPostprocessing: 0,
  };
  phases[`${newPhaseUuid}_comment`] = phase;
  xcodeProject.hash.project.objects[isa] = phases;

  target.buildPhases.push({ value: newPhaseUuid, comment: phase });
  return newPhaseUuid;
}

// CocoaPods rewrites the group with only `path`, and older plugin versions could leave an
// empty named duplicate beside it, so prefer whichever group already holds the sources.
function ensureExtensionGroup(xcodeProject) {
  const groups = xcodeProject.hash.project.objects.PBXGroup || {};
  const candidates = Object.keys(groups).filter(
    (key) =>
      !key.endsWith('_comment') &&
      [groups[key]?.name, groups[key]?.path].some(
        (value) => typeof value === 'string' && value.replace(/"/g, '') === EXTENSION_NAME,
      ),
  );
  const existingGroupKey =
    candidates.find((key) =>
      EXTENSION_FILES.some((file) => findGroupFileReferenceUuid(xcodeProject, key, file.name)),
    ) ?? candidates[0];
  if (existingGroupKey) {
    return existingGroupKey;
  }

  const groupKey = xcodeProject.pbxCreateGroup(EXTENSION_NAME, EXTENSION_NAME);
  xcodeProject.addToPbxGroup(groupKey, xcodeProject.getFirstProject().firstProject.mainGroup);
  return groupKey;
}

// Every source the keyboard needs, in its own target only. Throws rather
// than letting prebuild ship a keyboard that doesn't compile.
function ensureExtensionFiles(xcodeProject, targetUuid, groupKey) {
  for (const file of EXTENSION_FILES) {
    const fileRefUuid =
      findGroupFileReferenceUuid(xcodeProject, groupKey, file.name) ||
      xcodeProject.addFile(file.name, groupKey, {
        lastKnownFileType: file.fileType,
        sourceTree: '"<group>"',
      })?.fileRef;
    if (!fileRefUuid) {
      throw new Error(
        `[keyboard-extension] Could not add ${file.name} to the ${EXTENSION_NAME} group; another file reference already uses that path`,
      );
    }

    const buildFileUuid = ensureBuildFile(xcodeProject, fileRefUuid, file.name, file.phase);
    ensurePhaseMembershipForTarget(xcodeProject, targetUuid, buildFileUuid, file.name, file.phase);
  }
}

function withKeyboardExtension(config) {
  const appVersion = config.version || '1.0';

  // Add app group to main app entitlements
  config = withEntitlementsPlist(config, (cfg) => {
    const environment = resolveKeyboardEnvironment(cfg);
    setApplicationGroup(cfg.modResults, environment.appGroupId);
    return cfg;
  });

  // Modify Xcode project to add the keyboard extension target
  config = withXcodeProject(config, async (cfg) => {
    const xcodeProject = cfg.modResults;
    const platformProjectRoot = cfg.modRequest.platformProjectRoot;
    const environment = resolveKeyboardEnvironment(cfg);
    const extensionBundleId = environment.keyboardBundleIdentifier;
    const developmentTeamId = resolveDevelopmentTeamId(cfg, xcodeProject);
    writeExtensionSupportFiles(platformProjectRoot, environment);

    const extensionGroupKey = ensureExtensionGroup(xcodeProject);
    // pbxTargetByName returns the bare target object (no uuid), so look the key up.
    const existingTargetUuid = findTargetUuidByName(xcodeProject, EXTENSION_NAME);
    let targetKey;

    if (existingTargetUuid) {
      targetKey = existingTargetUuid;
    } else {
      // Add Info.plist to the group (not to build phase).
      xcodeProject.addFile('Info.plist', extensionGroupKey, {
        lastKnownFileType: 'text.plist.xml',
        sourceTree: '"<group>"',
      });

      // Add entitlements to the group.
      xcodeProject.addFile(`${EXTENSION_NAME}.entitlements`, extensionGroupKey, {
        lastKnownFileType: 'text.plist.entitlements',
        sourceTree: '"<group>"',
      });

      // Add the extension target; ensureExtensionFiles below gives it its Sources phase.
      const target = xcodeProject.addTarget(
        EXTENSION_NAME,
        'app_extension',
        EXTENSION_NAME,
        extensionBundleId,
      );

      targetKey = target.uuid;
    }

    const productRefUuid = xcodeProject.pbxNativeTargetSection()?.[targetKey]?.productReference;
    ensureExtensionFiles(xcodeProject, targetKey, extensionGroupKey);

    // Set build settings for the extension target.
    const buildSettings = {
      INFOPLIST_FILE: `${EXTENSION_NAME}/Info.plist`,
      CODE_SIGN_ENTITLEMENTS: `${EXTENSION_NAME}/${EXTENSION_NAME}.entitlements`,
      PRODUCT_BUNDLE_IDENTIFIER: extensionBundleId,
      PRODUCT_NAME: EXTENSION_NAME,
      SWIFT_VERSION: '5.0',
      TARGETED_DEVICE_FAMILY: '"1,2"',
      IPHONEOS_DEPLOYMENT_TARGET: '15.1',
      SKIP_INSTALL: 'YES',
      CODE_SIGN_STYLE: 'Manual',
      GENERATE_INFOPLIST_FILE: 'NO',
      CURRENT_PROJECT_VERSION: '1',
      MARKETING_VERSION: appVersion,
      OPENWHISPR_APP_SCHEME: environment.scheme,
      OPENWHISPR_APP_GROUP_ID: environment.appGroupId,
      OPENWHISPR_CONTAINING_APP_BUNDLE_ID: environment.iosBundleIdentifier,
    };

    if (developmentTeamId) {
      buildSettings.DEVELOPMENT_TEAM = developmentTeamId;
    }

    applyBuildSettingsToTarget(xcodeProject, targetKey, buildSettings);

    // Ensure the extension gets embedded in the host app.
    const mainTarget = xcodeProject.getFirstTarget();
    if (mainTarget && !hasEmbeddedExtension(xcodeProject, mainTarget.uuid, productRefUuid)) {
      xcodeProject.addBuildPhase(
        [`${EXTENSION_NAME}.appex`],
        'PBXCopyFilesBuildPhase',
        'Embed App Extensions',
        mainTarget.uuid,
        'app_extension',
      );
    }

    if (existingTargetUuid) {
      console.log(`[keyboard-extension] Updated ${EXTENSION_NAME} target build settings`);
    } else {
      console.log(`[keyboard-extension] Added ${EXTENSION_NAME} target to Xcode project`);
    }

    return cfg;
  });

  // Expo runs dangerous mods before the xcodeproj mod. When a previous prebuild left the
  // project in place (no --clean), this repairs the keyboard's file wiring on disk first.
  config = withDangerousMod(config, [
    'ios',
    async (cfg) => {
      const platformProjectRoot = cfg.modRequest.platformProjectRoot;
      const projectName = cfg.modRequest.projectName;
      const environment = resolveKeyboardEnvironment(cfg);
      writeExtensionSupportFiles(platformProjectRoot, environment);
      const projectFilePath = path.join(
        platformProjectRoot,
        `${projectName}.xcodeproj`,
        'project.pbxproj',
      );

      if (!fs.existsSync(projectFilePath)) {
        return cfg;
      }

      const xcodeProject = xcode.project(projectFilePath);
      xcodeProject.parseSync();

      const extensionTargetUuid = findTargetUuidByName(xcodeProject, EXTENSION_NAME);
      if (!extensionTargetUuid) {
        return cfg;
      }

      ensureExtensionFiles(xcodeProject, extensionTargetUuid, ensureExtensionGroup(xcodeProject));

      fs.writeFileSync(projectFilePath, xcodeProject.writeSync());

      return cfg;
    },
  ]);

  return config;
}

module.exports = withKeyboardExtension;
module.exports.EXTENSION_FILES = EXTENSION_FILES;
module.exports.ensureExtensionFiles = ensureExtensionFiles;
module.exports.ensureExtensionGroup = ensureExtensionGroup;
module.exports.writeExtensionSupportFiles = writeExtensionSupportFiles;
