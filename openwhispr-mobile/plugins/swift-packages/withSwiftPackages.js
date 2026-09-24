/**
 * Expo config plugin: make the app's Swift Packages available to CocoaPods.
 *
 * Why: the speaker-diarization and parakeet-asr native modules (`import FluidAudio`,
 * `import OrukeetCoreML`) consume Swift Packages compiled from source — FluidAudio's recommended
 * CocoaPods integration, via the `cocoapods-spm` plugin (https://github.com/trinhngocthuyen/cocoapods-spm).
 * CocoaPods trunk only publishes FluidAudio up to 0.7.8, and a hand-built library-evolution
 * xcframework does NOT compile on current Swift toolchains — so building it from source as a normal
 * SPM dependency is the correct, stays-current path.
 *
 * This plugin declares every package SOURCE in the generated ios/Podfile, once. The module podspecs
 * link products with `s.spm_dependency "<Package>/<Product>"` and never restate the source (per
 * cocoapods-spm).
 *
 * SwiftPM keys packages by identity (the URL's last path component), so the graph can hold only one
 * FluidAudio: OrukeetCoreML depends on Oruk AI's fork (upstream 0.15.5 plus a Core ML buffer-reset
 * performance patch), and the diarization and ASR modules share that same declaration. Both
 * packages are pinned to reviewed commits: a tag can be moved, and with ios/ generated on every
 * build nothing else would notice. A root commit pin overrides Orukeet's own `exact:` requirement,
 * so FLUIDAUDIO_COMMIT must stay the commit of the tag Orukeet's Package.swift names; move both
 * together and re-verify both Swift wrappers' API when you do.
 *
 * Needs the `cocoapods-spm` gem (root Gemfile; EAS installs it via Bundler). We emit an explicit
 * `plugin 'cocoapods-spm'` directive so the DSL loads under EAS's `bundle exec pod install` — implicit
 * auto-load only works where the gem is also installed globally (dev machines), not on a clean builder.
 */

const { withDangerousMod } = require('expo/config-plugins');
const fs = require('fs');
const path = require('path');

const FLUIDAUDIO_GIT = 'https://github.com/Oruk-AI/FluidAudio.git';
// Tag 0.15.5-orukeet.1, the version Orukeet's Package.swift requires.
const FLUIDAUDIO_COMMIT = 'ddc95f4d03d5be12bf84eeb6e4bde5b724356d88';
const ORUKEET_GIT = 'https://github.com/Oruk-AI/orukeet.git';
// CoreML mobile release candidate from Oruk-AI/orukeet PR #10, reviewed 2026-09-24.
const ORUKEET_COMMIT = '6c37c587fabcef8b0e932584fbf22a79fcb9d89e';

const SPM_PLUGIN_LINE = `plugin 'cocoapods-spm'`;
const SPM_PKG_LINES = [
  `spm_pkg "FluidAudio", :git => "${FLUIDAUDIO_GIT}", :commit => "${FLUIDAUDIO_COMMIT}"`,
  `spm_pkg "Orukeet", :git => "${ORUKEET_GIT}", :commit => "${ORUKEET_COMMIT}", :products => ["OrukeetCoreML"]`,
];
const SPM_PKG_PATTERN = /^\s*spm_pkg\s/m;

// Works around cocoapods-spm corrupting Pods.xcodeproj on Xcode 26 ("project is
// damaged / couldn't load"). cocoapods-spm injects the SPM package refs into the
// already-generated Pods project during post_integrate. CocoaPods' Pod::Project
// generates deterministic UUIDs (SHA256(basename)-prefixed counter) and — per its
// own comment — deliberately skips collision checks, assuming every UUID comes from
// one generation pass. That breaks here: @generated_uuids is empty at injection time,
// so the counter restarts at 0 and re-emits <prefix>00000000 — the PBXProject's own
// UUID — overwriting the PBXProject block and leaving a project with no root object.
// Restore the collision check that stock Xcodeproj already performs, but keep the counter
// advancing past taken UUIDs: generate_uuid calls this until one is available, so a window that
// collides entirely (as the first packages' refs do) must still move on or it loops forever.
// See https://github.com/maplibre/maplibre-react-native/issues/1499.
const UUID_FIX_BLOCK =
  "require 'cocoapods'\n" +
  'Pod::Project.class_eval do\n' +
  '  def generate_available_uuid_list(count = 100)\n' +
  '    start = @generated_uuids.size\n' +
  "    candidates = Array.new(count) { |i| format('%.6s%07X0', @uuid_prefix, start + i) }\n" +
  '    @generated_uuids += candidates\n' +
  '    @available_uuids += candidates - uuids\n' +
  '  end\n' +
  'end\n';

// cocoapods-spm 0.1.20 appends SPM resource bundles (ZIPFoundation's privacy manifest, pulled in
// by OrukeetCoreML) to each target's copy-resources .xcfilelist, and crashes with ENOENT when those
// lists don't exist. CocoaPods only writes them for projects whose compatibilityVersion is Xcode 9.3
// or later; Expo's template declares "Xcode 3.2", so script inputs are listed inline instead. Give
// cocoapods-spm empty lists to append to — it adds the bundle to the resources script either way.
const RESOURCE_FILE_LISTS_BLOCK =
  'pre_integrate do |installer|\n' +
  '  installer.aggregate_targets.each do |target|\n' +
  '    target.user_build_configurations.each_key do |config|\n' +
  '      [target.copy_resources_script_input_files_path(config),\n' +
  '       target.copy_resources_script_output_files_path(config)].each do |list|\n' +
  '        next if list.exist?\n' +
  '        FileUtils.mkdir_p(list.dirname)\n' +
  '        FileUtils.touch(list)\n' +
  '      end\n' +
  '    end\n' +
  '  end\n' +
  'end\n';

function addSwiftPackages(contents) {
  if (SPM_PKG_LINES.every((line) => contents.includes(line))) return contents; // idempotent

  // A Podfile from an earlier prebuild (the old diarization-only block, or older pins) is not
  // rewritten in place: a second block would declare the cocoapods-spm plugin and FluidAudio twice.
  if (SPM_PKG_PATTERN.test(contents)) {
    throw new Error(
      '[swift-packages] ios/Podfile declares Swift packages from an earlier prebuild. ' +
        'Regenerate it with `npx expo prebuild -p ios --clean`.',
    );
  }

  const block =
    '\n# Swift Packages compiled from source via cocoapods-spm (plugins/swift-packages).\n' +
    '# `plugin` loads the gem explicitly so spm_pkg resolves under EAS Build (not just global auto-load).\n' +
    '# FluidAudio: modules/speaker-diarization + modules/parakeet-asr. Orukeet: modules/parakeet-asr.\n' +
    '#\n' +
    '# Fix cocoapods-spm + Xcode 26 corrupting Pods.xcodeproj (see UUID_FIX_BLOCK in the plugin).\n' +
    UUID_FIX_BLOCK +
    '# Give cocoapods-spm the resource file lists it expects (see RESOURCE_FILE_LISTS_BLOCK).\n' +
    RESOURCE_FILE_LISTS_BLOCK +
    `${SPM_PLUGIN_LINE}\n` +
    SPM_PKG_LINES.map((line) => `${line}\n`).join('');

  // Declare the packages at the Podfile top level, just before the first target block.
  const match = contents.match(/^\s*target\s+['"]/m);
  if (match && match.index !== undefined) {
    return contents.slice(0, match.index) + block + '\n' + contents.slice(match.index);
  }
  // Fallback: append (still top level).
  return `${contents}\n${block}`;
}

function withSwiftPackages(config) {
  return withDangerousMod(config, [
    'ios',
    async (cfg) => {
      const podfile = path.join(cfg.modRequest.platformProjectRoot, 'Podfile');
      if (!fs.existsSync(podfile)) {
        console.warn('[swift-packages] ios/Podfile not found; spm_pkg not injected');
        return cfg;
      }
      const contents = fs.readFileSync(podfile, 'utf8');
      const next = addSwiftPackages(contents);
      if (next !== contents) {
        fs.writeFileSync(podfile, next);
        console.log('[swift-packages] Added FluidAudio + Orukeet spm_pkg to Podfile');
      }
      return cfg;
    },
  ]);
}

module.exports = withSwiftPackages;
module.exports.addSwiftPackages = addSwiftPackages;
