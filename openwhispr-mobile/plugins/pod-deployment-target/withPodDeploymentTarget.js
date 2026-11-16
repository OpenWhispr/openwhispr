const { withPodfile } = require('expo/config-plugins');

// Pod resource-bundle targets (SDWebImage, Sentry, RevenueCat, ...) keep the
// deployment target from their podspec, as low as 9.0. React Native's
// post_install raises only the pods' code targets (to 15.1), so Xcode 27, which
// supports 15.0+, rejects the bundles during build planning. Raise every Pods
// target below the app's own deployment target, which CocoaPods resolves from
// the Podfile's `platform :ios` line (expo-build-properties' ios.deploymentTarget).
const POST_INSTALL_ANCHOR = 'post_install do |installer|';
const DEPLOYMENT_TARGET_SNIPPET = `
    app_deployment_target = installer.aggregate_targets.map { |target| target.platform.deployment_target }.min
    installer.pods_project.targets.each do |target|
      target.build_configurations.each do |build_configuration|
        pod_deployment_target = build_configuration.build_settings['IPHONEOS_DEPLOYMENT_TARGET']
        if pod_deployment_target && Pod::Version.new(pod_deployment_target) < app_deployment_target
          build_configuration.build_settings['IPHONEOS_DEPLOYMENT_TARGET'] = app_deployment_target.to_s
        end
      end
    end
`;

function addPodDeploymentTargetFloor(contents) {
  if (contents.includes(DEPLOYMENT_TARGET_SNIPPET)) return contents;
  if (!contents.includes(POST_INSTALL_ANCHOR)) {
    throw new Error(
      'withPodDeploymentTarget: post_install block not found in the generated Podfile',
    );
  }
  return contents.replace(POST_INSTALL_ANCHOR, POST_INSTALL_ANCHOR + DEPLOYMENT_TARGET_SNIPPET);
}

function withPodDeploymentTarget(config) {
  return withPodfile(config, (cfg) => {
    cfg.modResults.contents = addPodDeploymentTargetFloor(cfg.modResults.contents);
    return cfg;
  });
}

module.exports = withPodDeploymentTarget;
module.exports.addPodDeploymentTargetFloor = addPodDeploymentTargetFloor;
