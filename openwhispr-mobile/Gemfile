source "https://rubygems.org"

# CocoaPods + the cocoapods-spm plugin. cocoapods-spm lets the iOS Podfile consume FluidAudio
# (speaker diarization) as a Swift Package compiled from source — see
# plugins/speaker-diarization/withSpeakerDiarization.js.
#
# Setup:  bundle install
# Then:   npx expo prebuild -p ios   (Expo runs `bundle exec pod install` when a Gemfile is present;
#         if your toolchain doesn't, run `bundle exec pod install` in ios/, or `gem install cocoapods-spm`
#         globally so the plain `pod install` can load the plugin).
gem "cocoapods", ">= 1.13", "!= 1.15.0", "!= 1.15.1"
gem "cocoapods-spm"
