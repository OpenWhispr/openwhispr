const { withDangerousMod } = require('expo/config-plugins');
const fs = require('fs');
const path = require('path');

// RN 0.83's jsi.h requires C++17+, but the CocoaPods-generated Pods project
// defaults to gnu++14. Pods without their own CLANG_CXX_LANGUAGE_STANDARD
// (e.g. ExpoModulesJSI, which compiles against jsi.h) inherit that default and
// fail with "cannot initialize a parameter of type 'char *'" at jsi.h:80.
// This plugin injects a post_install override so every pod install applies it.
const POST_INSTALL_ANCHOR = 'post_install do |installer|';
const CXX_STANDARD_SNIPPET = `
    installer.pods_project.build_configurations.each do |config|
      config.build_settings['CLANG_CXX_LANGUAGE_STANDARD'] = 'c++20'
    end
`;

function withIosCxxStandard(config) {
  return withDangerousMod(config, [
    'ios',
    (cfg) => {
      const podfilePath = path.join(cfg.modRequest.platformProjectRoot, 'Podfile');
      const contents = fs.readFileSync(podfilePath, 'utf8');
      if (!contents.includes("CLANG_CXX_LANGUAGE_STANDARD'] = 'c++20'")) {
        if (!contents.includes(POST_INSTALL_ANCHOR)) {
          throw new Error(
            'withIosCxxStandard: post_install block not found in the generated Podfile',
          );
        }
        fs.writeFileSync(
          podfilePath,
          contents.replace(POST_INSTALL_ANCHOR, POST_INSTALL_ANCHOR + CXX_STANDARD_SNIPPET),
        );
      }
      return cfg;
    },
  ]);
}

module.exports = withIosCxxStandard;
