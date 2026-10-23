const { adoptSceneLifecycle, SCENE_MANIFEST } = require('../withSceneLifecycle');

// AppDelegate.swift from expo-template-bare-minimum@55, with react-native-appsflyer's edits.
const EXPO_55_APP_DELEGATE = `import react_native_appsflyer
internal import Expo
import React
import ReactAppDependencyProvider

@main
class AppDelegate: ExpoAppDelegate {
  var window: UIWindow?

  var reactNativeDelegate: ExpoReactNativeFactoryDelegate?
  var reactNativeFactory: RCTReactNativeFactory?

  public override func application(
    _ application: UIApplication,
    didFinishLaunchingWithOptions launchOptions: [UIApplication.LaunchOptionsKey: Any]? = nil
  ) -> Bool {
    AppsFlyerAttribution.shared.handleLaunchOptions(launchOptions)
    let delegate = ReactNativeDelegate()
    let factory = ExpoReactNativeFactory(delegate: delegate)
    delegate.dependencyProvider = RCTAppDependencyProvider()

    reactNativeDelegate = delegate
    reactNativeFactory = factory

#if os(iOS) || os(tvOS)
    window = UIWindow(frame: UIScreen.main.bounds)
    factory.startReactNative(
      withModuleName: "main",
      in: window,
      launchOptions: launchOptions)
#endif

    return super.application(application, didFinishLaunchingWithOptions: launchOptions)
  }

  // Linking API
  public override func application(
    _ app: UIApplication,
    open url: URL,
    options: [UIApplication.OpenURLOptionsKey: Any] = [:]
  ) -> Bool {
    AppsFlyerAttribution.shared.handleOpen(url, options: options)
    return super.application(app, open: url, options: options) || RCTLinkingManager.application(app, open: url, options: options)
  }
}

class ReactNativeDelegate: ExpoReactNativeFactoryDelegate {
  // Extension point for config-plugins
}
`;

const SCENE_DELEGATE = `// MARK: - Scene life cycle (plugins/scene-lifecycle)
@objc(SceneDelegate)
class SceneDelegate: UIResponder, UIWindowSceneDelegate {}
`;

describe('withSceneLifecycle', () => {
  it('stops AppDelegate from creating the window and starting React Native', () => {
    const result = adoptSceneLifecycle(EXPO_55_APP_DELEGATE, SCENE_DELEGATE);

    expect(result).not.toContain('UIWindow(frame: UIScreen.main.bounds)');
    expect(result).not.toContain('factory.startReactNative(');
    expect(result).toContain('reactNativeFactory = factory');
    expect(result).toContain(
      'return super.application(application, didFinishLaunchingWithOptions: launchOptions)',
    );
  });

  it('leaves the URL handling and other plugins edits in AppDelegate untouched', () => {
    const result = adoptSceneLifecycle(EXPO_55_APP_DELEGATE, SCENE_DELEGATE);

    expect(result).toContain('AppsFlyerAttribution.shared.handleLaunchOptions(launchOptions)');
    expect(result).toContain('AppsFlyerAttribution.shared.handleOpen(url, options: options)');
    expect(result).toContain('class ReactNativeDelegate: ExpoReactNativeFactoryDelegate {');
  });

  it('appends SceneDelegate after the existing classes, once', () => {
    const once = adoptSceneLifecycle(EXPO_55_APP_DELEGATE, SCENE_DELEGATE);
    const twice = adoptSceneLifecycle(once, SCENE_DELEGATE);

    expect(twice).toBe(once);
    expect(once.match(/class SceneDelegate/g)).toHaveLength(1);
    expect(once.indexOf('class SceneDelegate')).toBeGreaterThan(
      once.indexOf('class ReactNativeDelegate'),
    );
  });

  it('fails the prebuild when the template no longer creates the window', () => {
    const changed = EXPO_55_APP_DELEGATE.replace(
      'window = UIWindow(frame: UIScreen.main.bounds)',
      '// window created elsewhere',
    );

    expect(() => adoptSceneLifecycle(changed, SCENE_DELEGATE)).toThrow(/scene-lifecycle/);
  });

  it('declares one application scene backed by SceneDelegate', () => {
    expect(SCENE_MANIFEST.UIApplicationSupportsMultipleScenes).toBe(false);
    expect(SCENE_MANIFEST.UISceneConfigurations.UIWindowSceneSessionRoleApplication).toEqual([
      {
        UISceneConfigurationName: 'Default Configuration',
        UISceneDelegateClassName: '$(PRODUCT_MODULE_NAME).SceneDelegate',
      },
    ]);
  });
});
