require 'json'

package = JSON.parse(File.read(File.join(__dir__, '..', 'package.json')))

Pod::Spec.new do |s|
  s.name           = 'TinfoilTransport'
  s.version        = package['version']
  s.summary        = package['description']
  s.description    = package['description']
  s.license        = package['license'] || 'MIT'
  s.author         = 'OpenWhispr Team'
  s.homepage       = 'https://github.com/OpenWhispr/openwhispr'
  s.platforms      = {
    :ios => '17.0'
  }
  s.swift_version  = '5.9'
  s.source         = { git: 'https://github.com/OpenWhispr/openwhispr.git' }
  s.static_framework = true
  # cocoapods-spm does not propagate the SDK's Swift linkerSettings.
  s.libraries = 'resolv'

  s.dependency 'ExpoModulesCore'
  s.dependency 'BackgroundUploader'
  s.spm_dependency 'tinfoil-swift/TinfoilAI'

  s.pod_target_xcconfig = {
    'DEFINES_MODULE' => 'YES',
    'SWIFT_COMPILATION_MODE' => 'wholemodule'
  }

  s.source_files = '**/*.{h,m,swift}'
end
