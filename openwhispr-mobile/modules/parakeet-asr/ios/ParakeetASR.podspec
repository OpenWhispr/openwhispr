require 'json'

package = JSON.parse(File.read(File.join(__dir__, '..', 'package.json')))

Pod::Spec.new do |s|
  s.name           = 'ParakeetASR'
  s.version        = package['version']
  s.summary        = package['description']
  s.description    = package['description']
  s.license        = package['license'] || 'MIT'
  s.author         = 'OpenWhispr Team'
  s.homepage       = 'https://github.com/OpenWhispr/open-whispr-mobile'
  # FluidAudio requires iOS 17; the app's deployment target is already 17 (expo-build-properties in app.base.json).
  s.platforms      = {
    :ios => '17.0'
  }
  s.swift_version  = '5.9'
  s.source         = { git: 'https://github.com/OpenWhispr/open-whispr-mobile.git' }
  s.static_framework = true

  s.dependency 'ExpoModulesCore'

  # FluidAudio and OrukeetCoreML are consumed as Swift Packages compiled from source via the
  # cocoapods-spm plugin. The package SOURCES (git urls + pins: Oruk AI's FluidAudio fork
  # 0.15.5-orukeet.1, Orukeet at a reviewed commit) are declared ONCE in the Podfile by
  # plugins/swift-packages/withSwiftPackages.js — diarization and ASR share the single FluidAudio
  # declaration. Per cocoapods-spm, the podspec must NOT restate the source here.
  s.spm_dependency 'FluidAudio/FluidAudio'
  s.spm_dependency 'Orukeet/OrukeetCoreML'

  s.pod_target_xcconfig = {
    'DEFINES_MODULE' => 'YES',
    'SWIFT_COMPILATION_MODE' => 'wholemodule'
  }

  s.source_files = '**/*.{h,m,swift}'
end
