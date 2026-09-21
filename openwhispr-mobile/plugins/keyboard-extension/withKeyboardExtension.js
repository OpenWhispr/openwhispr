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

  fs.copyFileSync(
    path.join(pluginSourceDir, 'KeyboardViewController.swift'),
    path.join(extensionDir, 'KeyboardViewController.swift'),
  );

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
    targetSourcesPhase.files.push({
      value: sourceBuildFileUuid,
      comment: sourceComment,
    });
  }

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

    // Check if target already exists
    const existingTarget = xcodeProject.pbxTargetByName(EXTENSION_NAME);
    let targetKey;
    let productRefUuid;
    let keyboardSourceFileRefUuid = null;

    if (existingTarget) {
      targetKey = existingTarget.uuid;
      const nativeTargets = xcodeProject.pbxNativeTargetSection();
      productRefUuid = nativeTargets?.[targetKey]?.productReference;
      ensureSourcesBuildPhaseExists(xcodeProject, targetKey);
    } else {
      // Create a PBX group for the extension files first.
      const extensionGroupKey = xcodeProject.pbxCreateGroup(EXTENSION_NAME, EXTENSION_NAME);

      // Add the group to the main project.
      const mainGroupKey = xcodeProject.getFirstProject().firstProject.mainGroup;
      xcodeProject.addToPbxGroup(extensionGroupKey, mainGroupKey);

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

      // Add the extension target - this creates the target with proper build phases.
      const target = xcodeProject.addTarget(
        EXTENSION_NAME,
        'app_extension',
        EXTENSION_NAME,
        extensionBundleId,
      );

      targetKey = target.uuid;
      ensureSourcesBuildPhaseExists(xcodeProject, targetKey);

      // Add source file to the extension target's Sources build phase.
      const sourceFile = xcodeProject.addSourceFile(
        'KeyboardViewController.swift',
        {
          target: targetKey,
          lastKnownFileType: 'sourcecode.swift',
          sourceTree: '"<group>"',
        },
        extensionGroupKey,
      );
      keyboardSourceFileRefUuid =
        sourceFile?.fileRef ||
        findFileReferenceUuidByBasename(xcodeProject, 'KeyboardViewController.swift');

      // Get the product reference from the target.
      const nativeTargets = xcodeProject.pbxNativeTargetSection();
      productRefUuid = nativeTargets?.[targetKey]?.productReference;
    }

    keyboardSourceFileRefUuid =
      keyboardSourceFileRefUuid ||
      findFileReferenceUuidByBasename(xcodeProject, 'KeyboardViewController.swift');

    if (keyboardSourceFileRefUuid) {
      const sourceBuildFileUuid = ensureBuildFileForSource(
        xcodeProject,
        keyboardSourceFileRefUuid,
        'KeyboardViewController.swift',
      );
      ensureSourceMembershipForTarget(
        xcodeProject,
        targetKey,
        sourceBuildFileUuid,
        'KeyboardViewController.swift',
      );
    }

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

    if (existingTarget) {
      console.log(`[keyboard-extension] Updated ${EXTENSION_NAME} target build settings`);
    } else {
      console.log(`[keyboard-extension] Added ${EXTENSION_NAME} target to Xcode project`);
    }

    return cfg;
  });

  // Expo/RN prebuild steps can rewrite target build phases after xcode mods run.
  // Re-apply source-phase wiring on the final pbxproj representation.
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

      ensureSourcesBuildPhaseExists(xcodeProject, extensionTargetUuid);

      let extensionGroupKey = xcodeProject.findPBXGroupKey({
        name: EXTENSION_NAME,
      });
      if (!extensionGroupKey) {
        extensionGroupKey = xcodeProject.pbxCreateGroup(EXTENSION_NAME, EXTENSION_NAME);
        const mainGroupKey = xcodeProject.getFirstProject().firstProject.mainGroup;
        xcodeProject.addToPbxGroup(extensionGroupKey, mainGroupKey);
      }

      let keyboardSourceFileRefUuid = findFileReferenceUuidByBasename(
        xcodeProject,
        'KeyboardViewController.swift',
      );
      if (!keyboardSourceFileRefUuid) {
        const sourceFile = xcodeProject.addFile('KeyboardViewController.swift', extensionGroupKey, {
          lastKnownFileType: 'sourcecode.swift',
          sourceTree: '"<group>"',
        });
        keyboardSourceFileRefUuid = sourceFile?.fileRef || null;
      }

      if (keyboardSourceFileRefUuid) {
        const sourceBuildFileUuid = ensureBuildFileForSource(
          xcodeProject,
          keyboardSourceFileRefUuid,
          'KeyboardViewController.swift',
        );
        ensureSourceMembershipForTarget(
          xcodeProject,
          extensionTargetUuid,
          sourceBuildFileUuid,
          'KeyboardViewController.swift',
        );
      }

      fs.writeFileSync(projectFilePath, xcodeProject.writeSync());

      return cfg;
    },
  ]);

  return config;
}

module.exports = withKeyboardExtension;
