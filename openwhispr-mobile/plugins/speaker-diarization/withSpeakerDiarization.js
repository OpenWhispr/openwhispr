/**
 * Expo config plugin: make the FluidAudio Swift Package available to CocoaPods.
 *
 * Why: the speaker-diarization native module (`import FluidAudio`) consumes FluidAudio as a
 * Swift Package compiled from source — FluidAudio's recommended CocoaPods integration, via the
 * `cocoapods-spm` plugin (https://github.com/trinhngocthuyen/cocoapods-spm). CocoaPods trunk only
 * publishes FluidAudio up to 0.7.8, and a hand-built library-evolution xcframework does NOT compile
 * on current Swift toolchains — so building it from source as a normal SPM dependency is the correct,
 * stays-current path. (FluidAudio compiles cleanly that way; the failures only appeared when forcing
 * BUILD_LIBRARY_FOR_DISTRIBUTION for an xcframework, which is off FluidAudio's supported path.)
 *
 * This plugin declares the SPM package in the generated ios/Podfile. The module's podspec links the
 * product with `s.spm_dependency "FluidAudio/FluidAudio"` (source is declared ONLY here, per cocoapods-spm).
 *
 * Needs the `cocoapods-spm` gem (root Gemfile; EAS installs it via Bundler). We emit an explicit
 * `plugin 'cocoapods-spm'` directive so the DSL loads under EAS's `bundle exec pod install` — implicit
 * auto-load only works where the gem is also installed globally (dev machines), not on a clean builder.
 *
 * Pinned to an exact FluidAudio version we verified the Swift wrapper against (DiarizerManager /
 * performCompleteDiarization / TimedSpeakerSegment / DiarizerModels). Bump FLUIDAUDIO_VERSION
 * deliberately and re-verify the wrapper's API when you do.
 */

const { withDangerousMod } = require('expo/config-plugins');
const fs = require('fs');
const path = require('path');

const FLUIDAUDIO_GIT = 'https://github.com/FluidInference/FluidAudio.git';
const FLUIDAUDIO_VERSION = '0.15.4';
const SPM_PLUGIN_LINE = `plugin 'cocoapods-spm'`;
const SPM_PKG_LINE = `spm_pkg "FluidAudio", :git => "${FLUIDAUDIO_GIT}", :version => "${FLUIDAUDIO_VERSION}"`;
const MARKER = 'spm_pkg "FluidAudio"';

// Works around cocoapods-spm corrupting Pods.xcodeproj on Xcode 26 ("project is
// damaged / couldn't load"). cocoapods-spm injects FluidAudio's SPM refs into the
// already-generated Pods project during post_integrate. CocoaPods' Pod::Project
// generates deterministic UUIDs (SHA256(basename)-prefixed counter) and — per its
// own comment — deliberately skips collision checks, assuming every UUID comes from
// one generation pass. That breaks here: @generated_uuids is empty at injection time,
// so the counter restarts at 0 and re-emits <prefix>00000000 — the PBXProject's own
// UUID — overwriting the PBXProject block and leaving a project with no root object.
// Restore the collision check that stock Xcodeproj already performs.
// See https://github.com/maplibre/maplibre-react-native/issues/1499.
const UUID_FIX_BLOCK =
  "require 'cocoapods'\n" +
  'Pod::Project.class_eval do\n' +
  '  def generate_available_uuid_list(count = 100)\n' +
  '    start = @generated_uuids.size\n' +
  "    uniques = Array.new(count) { |i| format('%.6s%07X0', @uuid_prefix, start + i) }\n" +
  '    uniques -= (@generated_uuids + uuids)\n' +
  '    @generated_uuids += uniques\n' +
  '    @available_uuids += uniques\n' +
  '  end\n' +
  'end\n';

function addSpmPkg(contents) {
  if (contents.includes(MARKER)) return contents; // idempotent across prebuilds

  const block =
    '\n# FluidAudio (speaker diarization) — Swift Package compiled from source via cocoapods-spm.\n' +
    '# `plugin` loads the gem explicitly so spm_pkg resolves under EAS Build (not just global auto-load).\n' +
    '# Linked by modules/speaker-diarization (s.spm_dependency "FluidAudio/FluidAudio").\n' +
    '#\n' +
    '# Fix cocoapods-spm + Xcode 26 corrupting Pods.xcodeproj (see UUID_FIX_BLOCK in the plugin).\n' +
    UUID_FIX_BLOCK +
    `${SPM_PLUGIN_LINE}\n` +
    `${SPM_PKG_LINE}\n`;

  // Declare the package at the Podfile top level, just before the first target block.
  const match = contents.match(/^\s*target\s+['"]/m);
  if (match && match.index !== undefined) {
    return contents.slice(0, match.index) + block + '\n' + contents.slice(match.index);
  }
  // Fallback: append (still top level).
  return `${contents}\n${block}`;
}

module.exports = function withSpeakerDiarization(config) {
  return withDangerousMod(config, [
    'ios',
    async (cfg) => {
      const podfile = path.join(cfg.modRequest.platformProjectRoot, 'Podfile');
      if (!fs.existsSync(podfile)) {
        console.warn('[speaker-diarization] ios/Podfile not found; spm_pkg not injected');
        return cfg;
      }
      const contents = fs.readFileSync(podfile, 'utf8');
      const next = addSpmPkg(contents);
      if (next !== contents) {
        fs.writeFileSync(podfile, next);
        console.log('[speaker-diarization] Added FluidAudio spm_pkg to Podfile');
      }
      return cfg;
    },
  ]);
};
