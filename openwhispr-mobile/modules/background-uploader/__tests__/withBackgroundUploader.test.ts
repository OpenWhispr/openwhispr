const fs = require('fs');
const path = require('path');
const { addBackgroundUploadRecovery } = require('../app.plugin');
const { adoptSceneLifecycle } = require('../../../plugins/scene-lifecycle/withSceneLifecycle');

const appDelegate = `import Expo
import React
class AppDelegate: ExpoAppDelegate {
  var window: UIWindow?
  func launch() {
    AppsFlyerAttribution.shared.handleLaunchOptions(nil)
#if os(iOS) || os(tvOS)
    window = UIWindow(frame: UIScreen.main.bounds)
    factory.startReactNative(withModuleName: "main", in: window, launchOptions: nil)
#endif
  }
}
`;

describe('background upload recovery plugin', () => {
  it('installs the native callback inside AppDelegate without changing existing code', () => {
    const callback = fs.readFileSync(
      path.join(__dirname, '../plugin/BackgroundUploadAppDelegate.swift'),
      'utf8',
    );
    const result = addBackgroundUploadRecovery(`import Expo
class AppDelegate: ExpoAppDelegate {
  var window: UIWindow?
}
`);

    expect(result).toBe(`import BackgroundUploader
import Expo
class AppDelegate: ExpoAppDelegate {
${callback}
  var window: UIWindow?
}
`);
    expect(addBackgroundUploadRecovery(result)).toBe(result);
  });

  it('works before or after the scene migration and when that migration is retired', () => {
    const scene = '// MARK: - Scene life cycle (plugins/scene-lifecycle)\nclass SceneDelegate {}';
    const sceneFirst = addBackgroundUploadRecovery(adoptSceneLifecycle(appDelegate, scene));
    const recoveryFirst = adoptSceneLifecycle(addBackgroundUploadRecovery(appDelegate), scene);

    expect(sceneFirst).toBe(recoveryFirst);
    expect(sceneFirst).toContain('AppsFlyerAttribution.shared.handleLaunchOptions(nil)');
    expect(addBackgroundUploadRecovery(appDelegate)).toContain('factory.startReactNative(');
  });

  it('fails prebuild if an incompatible template would omit recovery', () => {
    expect(() => addBackgroundUploadRecovery('class OtherDelegate {}')).toThrow(
      /background-uploader/,
    );
  });
});
