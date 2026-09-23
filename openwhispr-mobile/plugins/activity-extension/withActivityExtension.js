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

const EXTENSION_NAME = 'OpenWhisprActivity';
const EXTENSION_BUNDLE_ID_SUFFIX = 'activity';
const DEPLOYMENT_TARGET = '16.2';
// Swift sources compiled into the widget target. RecordingActivityAttributes.swift
// is copied from the live-activity module so there is a single source of truth.
const TARGET_SOURCES = [
  'OpenWhisprActivity.swift',
  'RecordingActivityAttributes.swift',
  'ToggleDictationModeIntent.swift',
];
const ATTRIBUTES_SOURCE = path.join(
  __dirname,
  '..',
  '..',
  'modules',
  'live-activity',
  'ios',
  'RecordingActivityAttributes.swift',
);
const INTENT_SOURCE = path.join(
  __dirname,
  '..',
  '..',
  'modules',
  'live-activity',
  'ios',
  'ToggleDictationModeIntent.swift',
);

function resolveActivityEnvironment(cfg) {
  const configured = cfg.extra?.openWhispr ?? resolveOpenWhisprEnvironment();
  const bundleIdentifier =
    configured.iosBundleIdentifier || cfg.ios?.bundleIdentifier || 'com.gizmolabs.openwhispr';
  return {
    ...configured,
    iosBundleIdentifier: bundleIdentifier,
    activityBundleIdentifier:
      configured.activityBundleIdentifier || `${bundleIdentifier}.${EXTENSION_BUNDLE_ID_SUFFIX}`,
    appGroupId: configured.appGroupId || deriveAppGroupId(bundleIdentifier),
  };
}

function setApplicationGroup(entitlements, appGroupId) {
  entitlements['com.apple.security.application-groups'] = [appGroupId];
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

  fs.copyFileSync(
    path.join(pluginSourceDir, 'OpenWhisprActivity.swift'),
    path.join(extensionDir, 'OpenWhisprActivity.swift'),
  );
  // Single source of truth: copy the attributes file from the module.
  fs.copyFileSync(ATTRIBUTES_SOURCE, path.join(extensionDir, 'RecordingActivityAttributes.swift'));
  // Single source of truth: copy the LiveActivityIntent from the module.
  fs.copyFileSync(INTENT_SOURCE, path.join(extensionDir, 'ToggleDictationModeIntent.swift'));

  const infoPlist = readPlist(path.join(pluginSourceDir, 'Info.plist'));
  writePlist(path.join(extensionDir, 'Info.plist'), infoPlist);

  const entitlements = readPlist(path.join(pluginSourceDir, `${EXTENSION_NAME}.entitlements`));
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

function findFileReferenceUuidByBasename(xcodeProject, basename) {
  const fileRefs = xcodeProject.pbxFileReferenceSection();
  for (const [uuid, entry] of Object.entries(fileRefs)) {
    if (uuid.endsWith('_comment')) {
      continue;
    }
    const pathValue = typeof entry?.path === 'string' ? entry.path.replace(/"/g, '') : '';
    const nameValue = typeof entry?.name === 'string' ? entry.name.replace(/"/g, '') : '';
    if (pathValue === basename || nameValue === basename) {
      return uuid;
    }
  }
  return null;
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

function ensureBuildFileForSource(xcodeProject, fileRefUuid, fileName) {
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
  buildFiles[`${buildFileUuid}_comment`] = `${fileName} in Sources`;
  xcodeProject.hash.project.objects.PBXBuildFile = buildFiles;
  return buildFileUuid;
}

function ensureSourcesBuildPhaseExists(xcodeProject, targetUuid) {
  const nativeTargets = xcodeProject.pbxNativeTargetSection();
  const target = nativeTargets?.[targetUuid];
  if (!target?.buildPhases) {
    return null;
  }
  const sourcePhases = xcodeProject.hash.project.objects.PBXSourcesBuildPhase || {};
  for (const phaseRef of target.buildPhases) {
    const phaseUuid = phaseRef?.value || phaseRef;
    const phase = sourcePhases[phaseUuid];
    if (phase?.isa === 'PBXSourcesBuildPhase') {
      return phaseUuid;
    }
  }
  const newPhaseUuid = xcodeProject.generateUuid();
  sourcePhases[newPhaseUuid] = {
    isa: 'PBXSourcesBuildPhase',
    buildActionMask: 2147483647,
    files: [],
    runOnlyForDeploymentPostprocessing: 0,
  };
  sourcePhases[`${newPhaseUuid}_comment`] = 'Sources';
  xcodeProject.hash.project.objects.PBXSourcesBuildPhase = sourcePhases;
  target.buildPhases.push({ value: newPhaseUuid, comment: 'Sources' });
  return newPhaseUuid;
}

function ensureSourceMembershipForTarget(xcodeProject, targetUuid, sourceBuildFileUuid, fileName) {
  const targetSourcesPhaseUuid = ensureSourcesBuildPhaseExists(xcodeProject, targetUuid);
  if (!targetSourcesPhaseUuid) {
    return;
  }
  const allSourcePhases = xcodeProject.hash.project.objects.PBXSourcesBuildPhase || {};
  const targetSourcesPhase = allSourcePhases[targetSourcesPhaseUuid];
  if (!targetSourcesPhase) {
    return;
  }
  targetSourcesPhase.files = targetSourcesPhase.files || [];
  const sourceComment = `${fileName} in Sources`;
  if (!targetSourcesPhase.files.some((entry) => entry?.value === sourceBuildFileUuid)) {
    targetSourcesPhase.files.push({ value: sourceBuildFileUuid, comment: sourceComment });
  }

  // Remove this build file from every OTHER Sources phase so the source is only
  // compiled into the intended extension target. Defends against the xcode
  // addSourceFile quirk of registering the file into the first/main target's
  // phase — critical here because OpenWhisprActivity.swift carries @main and
  // RecordingActivityAttributes.swift is already compiled into the app via the
  // LiveActivity pod (leaking either into the app target = duplicate @main /
  // duplicate-symbol build failures).
  for (const [phaseUuid, phase] of Object.entries(allSourcePhases)) {
    if (phaseUuid.endsWith('_comment') || phaseUuid === targetSourcesPhaseUuid) {
      continue;
    }
    if (!Array.isArray(phase?.files)) {
      continue;
    }
    phase.files = phase.files.filter((entry) => entry?.value !== sourceBuildFileUuid);
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

function wireSourcesIntoTarget(xcodeProject, targetUuid) {
  for (const fileName of TARGET_SOURCES) {
    const fileRefUuid = findFileReferenceUuidByBasename(xcodeProject, fileName);
    if (!fileRefUuid) {
      continue;
    }
    const buildFileUuid = ensureBuildFileForSource(xcodeProject, fileRefUuid, fileName);
    ensureSourceMembershipForTarget(xcodeProject, targetUuid, buildFileUuid, fileName);
  }
}

function withActivityExtension(config) {
  const appVersion = config.version || '1.0';

  // Ensure the main app entitlements include the app group (shared with keyboard).
  config = withEntitlementsPlist(config, (cfg) => {
    const environment = resolveActivityEnvironment(cfg);
    setApplicationGroup(cfg.modResults, environment.appGroupId);
    return cfg;
  });

  config = withXcodeProject(config, async (cfg) => {
    const xcodeProject = cfg.modResults;
    const platformProjectRoot = cfg.modRequest.platformProjectRoot;
    const environment = resolveActivityEnvironment(cfg);
    const extensionBundleId = environment.activityBundleIdentifier;
    const developmentTeamId = resolveDevelopmentTeamId(cfg, xcodeProject);
    writeExtensionSupportFiles(platformProjectRoot, environment);

    const existingTarget = xcodeProject.pbxTargetByName(EXTENSION_NAME);
    let targetKey;
    let productRefUuid;

    if (existingTarget) {
      targetKey = existingTarget.uuid;
      const nativeTargets = xcodeProject.pbxNativeTargetSection();
      productRefUuid = nativeTargets?.[targetKey]?.productReference;
      ensureSourcesBuildPhaseExists(xcodeProject, targetKey);
    } else {
      const extensionGroupKey = xcodeProject.pbxCreateGroup(EXTENSION_NAME, EXTENSION_NAME);
      const mainGroupKey = xcodeProject.getFirstProject().firstProject.mainGroup;
      xcodeProject.addToPbxGroup(extensionGroupKey, mainGroupKey);

      xcodeProject.addFile('Info.plist', extensionGroupKey, {
        lastKnownFileType: 'text.plist.xml',
        sourceTree: '"<group>"',
      });
      xcodeProject.addFile(`${EXTENSION_NAME}.entitlements`, extensionGroupKey, {
        lastKnownFileType: 'text.plist.entitlements',
        sourceTree: '"<group>"',
      });

      const target = xcodeProject.addTarget(
        EXTENSION_NAME,
        'app_extension',
        EXTENSION_NAME,
        extensionBundleId,
      );
      targetKey = target.uuid;
      ensureSourcesBuildPhaseExists(xcodeProject, targetKey);

      for (const fileName of TARGET_SOURCES) {
        xcodeProject.addSourceFile(
          fileName,
          { target: targetKey, lastKnownFileType: 'sourcecode.swift', sourceTree: '"<group>"' },
          extensionGroupKey,
        );
      }

      const nativeTargets = xcodeProject.pbxNativeTargetSection();
      productRefUuid = nativeTargets?.[targetKey]?.productReference;
    }

    wireSourcesIntoTarget(xcodeProject, targetKey);

    const buildSettings = {
      INFOPLIST_FILE: `${EXTENSION_NAME}/Info.plist`,
      CODE_SIGN_ENTITLEMENTS: `${EXTENSION_NAME}/${EXTENSION_NAME}.entitlements`,
      PRODUCT_BUNDLE_IDENTIFIER: extensionBundleId,
      PRODUCT_NAME: EXTENSION_NAME,
      SWIFT_VERSION: '5.0',
      TARGETED_DEVICE_FAMILY: '"1,2"',
      IPHONEOS_DEPLOYMENT_TARGET: DEPLOYMENT_TARGET,
      SKIP_INSTALL: 'YES',
      CODE_SIGN_STYLE: 'Manual',
      GENERATE_INFOPLIST_FILE: 'NO',
      CURRENT_PROJECT_VERSION: '1',
      MARKETING_VERSION: appVersion,
      LD_RUNPATH_SEARCH_PATHS:
        '"$(inherited) @executable_path/Frameworks @executable_path/../../Frameworks"',
    };
    if (developmentTeamId) {
      buildSettings.DEVELOPMENT_TEAM = developmentTeamId;
    }
    applyBuildSettingsToTarget(xcodeProject, targetKey, buildSettings);

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

    if (existingTarget) {
      console.log(`[activity-extension] Updated ${EXTENSION_NAME} target build settings`);
    } else {
      console.log(`[activity-extension] Added ${EXTENSION_NAME} target to Xcode project`);
    }

    return cfg;
  });

  // Re-apply source-phase wiring after Expo/RN prebuild rewrites build phases.
  config = withDangerousMod(config, [
    'ios',
    async (cfg) => {
      const platformProjectRoot = cfg.modRequest.platformProjectRoot;
      const projectName = cfg.modRequest.projectName;
      const environment = resolveActivityEnvironment(cfg);
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
      ensureSourcesBuildPhaseExists(xcodeProject, extensionTargetUuid);

      let extensionGroupKey = xcodeProject.findPBXGroupKey({ name: EXTENSION_NAME });
      if (!extensionGroupKey) {
        extensionGroupKey = xcodeProject.pbxCreateGroup(EXTENSION_NAME, EXTENSION_NAME);
        const mainGroupKey = xcodeProject.getFirstProject().firstProject.mainGroup;
        xcodeProject.addToPbxGroup(extensionGroupKey, mainGroupKey);
      }

      for (const fileName of TARGET_SOURCES) {
        if (!findFileReferenceUuidByBasename(xcodeProject, fileName)) {
          xcodeProject.addFile(fileName, extensionGroupKey, {
            lastKnownFileType: 'sourcecode.swift',
            sourceTree: '"<group>"',
          });
        }
      }
      wireSourcesIntoTarget(xcodeProject, extensionTargetUuid);

      fs.writeFileSync(projectFilePath, xcodeProject.writeSync());
      return cfg;
    },
  ]);

  return config;
}

module.exports = withActivityExtension;
