const { withDangerousMod } = require('expo/config-plugins');
const fs = require('fs');
const path = require('path');

// The SDK embeds a checksum-verified Go attestation verifier. Change this pin
// deliberately and re-run native identity and device attestation checks.
const SDK_REVISION = '4988b05e124dc217b5e5e9fef6c9e95e5355eeea';

module.exports = function withTinfoilTransport(config) {
  return withDangerousMod(config, [
    'ios',
    async (cfg) => {
      const podfile = path.join(cfg.modRequest.platformProjectRoot, 'Podfile');
      const contents = fs.readFileSync(podfile, 'utf8');
      const packageLine = `spm_pkg "tinfoil-swift", :products => ["TinfoilAI"], :git => "https://github.com/tinfoilsh/tinfoil-swift.git", :commit => "${SDK_REVISION}"`;
      if (/^spm_pkg ["']tinfoil-swift["'].*$/m.test(contents)) {
        fs.writeFileSync(
          podfile,
          contents.replace(/^spm_pkg ["']tinfoil-swift["'].*$/m, packageLine),
        );
        return cfg;
      }
      const declaration = `\nplugin 'cocoapods-spm'\nspm_pkg "tinfoil-swift", :products => ["TinfoilAI"], :git => "https://github.com/tinfoilsh/tinfoil-swift.git", :commit => "${SDK_REVISION}"\n`;
      const resourceLists =
        '\n# cocoapods-spm expects resource file lists even when CocoaPods has no native\n# resources to place in them. Create only missing lists before its integration.\npost_integrate do |installer|\n  installer.aggregate_targets.each do |target|\n    target.user_build_configurations.each_key do |config|\n      [:copy_resources_script_input_files_path, :copy_resources_script_output_files_path].each do |method|\n        list = target.send(method, config)\n        list.write("") unless list.exist?\n      end\n    end\n  end\nend\n';
      fs.writeFileSync(podfile, contents + declaration + resourceLists);
      return cfg;
    },
  ]);
};
