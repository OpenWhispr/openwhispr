/**
 * Expo config plugin that moves the app to UIKit's scene-based life cycle.
 *
 * Why: apps built with the iOS 27 SDK must adopt scenes (Apple TN3187). Without a scene manifest
 * UIKit asserts while connecting the first scene, so build 1.2.4 (40) — the first one built with
 * Xcode 27 — crashed on launch on iOS 27. Expo SDK 58 ships this in its template; SDK 55 doesn't.
 *
 * - Info.plist gets a single-scene UIApplicationSceneManifest pointing at SceneDelegate.
 * - AppDelegate keeps creating the React Native factory but no longer creates the window or starts
 *   React Native: SceneDelegate does both once UIKit connects the scene.
 * - SceneDelegate (ios/SceneDelegate.swift) is appended to AppDelegate.swift, which already imports
 *   what it needs, so no Xcode project entry is required.
 */

const { withAppDelegate, withInfoPlist } = require('expo/config-plugins');
const fs = require('fs');
const path = require('path');

const SCENE_DELEGATE_SOURCE = path.join(__dirname, 'ios', 'SceneDelegate.swift');
const SCENE_DELEGATE_MARKER = '// MARK: - Scene life cycle (plugins/scene-lifecycle)';

// The window block of Expo SDK 55's AppDelegate.swift template.
const TEMPLATE_WINDOW_BLOCK =
  /\n#if os\(iOS\) \|\| os\(tvOS\)\n\s*window = UIWindow\(frame: UIScreen\.main\.bounds\)\n\s*factory\.startReactNative\([^)]*\)\n#endif\n/;

const SCENE_STARTUP_COMMENT = `
    // SceneDelegate creates the window and starts React Native once UIKit connects the scene
    // (plugins/scene-lifecycle).
`;

const SCENE_MANIFEST = {
  UIApplicationSupportsMultipleScenes: false,
  UISceneConfigurations: {
    UIWindowSceneSessionRoleApplication: [
      {
        UISceneConfigurationName: 'Default Configuration',
        UISceneDelegateClassName: '$(PRODUCT_MODULE_NAME).SceneDelegate',
      },
    ],
  },
};

function adoptSceneLifecycle(appDelegate, sceneDelegateSource) {
  if (appDelegate.includes(SCENE_DELEGATE_MARKER)) return appDelegate;
  if (!TEMPLATE_WINDOW_BLOCK.test(appDelegate)) {
    throw new Error(
      '[scene-lifecycle] AppDelegate.swift no longer creates its window the way the Expo SDK 55 ' +
        'template does. If the new template already ships a SceneDelegate, remove this plugin; ' +
        'otherwise update TEMPLATE_WINDOW_BLOCK.',
    );
  }
  return `${appDelegate.replace(TEMPLATE_WINDOW_BLOCK, SCENE_STARTUP_COMMENT).trimEnd()}\n\n${sceneDelegateSource.trimEnd()}\n`;
}

function withSceneLifecycle(config) {
  config = withInfoPlist(config, (cfg) => {
    cfg.modResults.UIApplicationSceneManifest = SCENE_MANIFEST;
    return cfg;
  });

  return withAppDelegate(config, (cfg) => {
    if (cfg.modResults.language !== 'swift') {
      throw new Error(
        `[scene-lifecycle] Unsupported AppDelegate language: ${cfg.modResults.language}`,
      );
    }
    cfg.modResults.contents = adoptSceneLifecycle(
      cfg.modResults.contents,
      fs.readFileSync(SCENE_DELEGATE_SOURCE, 'utf8'),
    );
    return cfg;
  });
}

module.exports = withSceneLifecycle;
module.exports.adoptSceneLifecycle = adoptSceneLifecycle;
module.exports.SCENE_MANIFEST = SCENE_MANIFEST;
