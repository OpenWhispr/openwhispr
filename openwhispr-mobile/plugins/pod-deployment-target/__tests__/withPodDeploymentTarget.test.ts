const { addPodDeploymentTargetFloor } = require('../withPodDeploymentTarget');

const EXPO_TEMPLATE_PODFILE = `platform :ios, podfile_properties['ios.deploymentTarget'] || '15.1'

target 'OpenWhispr' do
  use_expo_modules!
  config = use_native_modules!(config_command)

  post_install do |installer|
    react_native_post_install(
      installer,
      config[:reactNativePath],
      :mac_catalyst_enabled => false,
      :ccache_enabled => ccache_enabled?(podfile_properties),
    )
  end
end
`;

function postInstallBlock(podfile: string): string {
  const start = podfile.indexOf('post_install do |installer|');
  return podfile.slice(start, podfile.indexOf('\n  end\n', start));
}

describe('withPodDeploymentTarget', () => {
  it('raises every Pods target below the app deployment target inside the existing post_install block', () => {
    const podfile = addPodDeploymentTargetFloor(EXPO_TEMPLATE_PODFILE);
    const block = postInstallBlock(podfile);

    expect(podfile.match(/post_install do/g)).toHaveLength(1);
    expect(block).toContain(
      'app_deployment_target = installer.aggregate_targets.map { |target| target.platform.deployment_target }.min',
    );
    expect(block).toContain('installer.pods_project.targets.each do |target|');
    expect(block).toContain(
      "build_configuration.build_settings['IPHONEOS_DEPLOYMENT_TARGET'] = app_deployment_target.to_s",
    );
    expect(block).toContain('react_native_post_install(');
  });

  it('is idempotent across prebuilds', () => {
    const once = addPodDeploymentTargetFloor(EXPO_TEMPLATE_PODFILE);

    expect(addPodDeploymentTargetFloor(once)).toBe(once);
  });

  it('fails loudly when the generated Podfile has no post_install block', () => {
    const podfileWithoutPostInstall = EXPO_TEMPLATE_PODFILE.replace(
      'post_install do |installer|',
      'pre_install do |installer|',
    );

    expect(() => addPodDeploymentTargetFloor(podfileWithoutPostInstall)).toThrow(
      'withPodDeploymentTarget: post_install block not found in the generated Podfile',
    );
  });
});
