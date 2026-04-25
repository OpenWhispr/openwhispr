#include "aec_processor.h"

#include <algorithm>
#include <array>
#include <cstring>
#include <utility>

#include "api/audio/audio_processing.h"
#include "api/audio/builtin_audio_processing_builder.h"
#include "api/audio/echo_canceller3_factory.h"
#include "api/environment/environment_factory.h"
#include "common_audio/resampler/include/push_resampler.h"

namespace {

constexpr int kInputSampleRate = 24000;
constexpr int kProcessingSampleRate = 48000;
constexpr size_t kFrameMs = 10;
constexpr size_t kChannelCount = 1;

}  // namespace

AecProcessor::AecProcessor(int sample_rate_hz)
    : sample_rate_hz_(sample_rate_hz),
      input_frame_samples_(static_cast<size_t>(sample_rate_hz_) * kFrameMs / 1000),
      processing_frame_samples_(kProcessingSampleRate * kFrameMs / 1000) {
  if (sample_rate_hz_ != kInputSampleRate) {
    return;
  }

  webrtc::AudioProcessing::Config config;
  config.pipeline.maximum_internal_processing_rate = kProcessingSampleRate;
  config.echo_canceller.enabled = true;
  config.echo_canceller.enforce_high_pass_filtering = true;
  config.high_pass_filter.enabled = true;
  config.noise_suppression.enabled = true;
  config.noise_suppression.level =
      webrtc::AudioProcessing::Config::NoiseSuppression::Level::kModerate;
  config.transient_suppression.enabled = false;
  config.gain_controller1.enabled = false;
  config.gain_controller2.enabled = false;
  config.capture_level_adjustment.enabled = false;

  webrtc::EchoCanceller3Config echo_config;
  webrtc::BuiltinAudioProcessingBuilder builder(config);
  builder.SetEchoControlFactory(std::make_unique<webrtc::EchoCanceller3Factory>(echo_config));
  apm_ = builder.Build(webrtc::CreateEnvironment());
  if (!apm_) {
    return;
  }

  const webrtc::ProcessingConfig processing_config = {{
      webrtc::StreamConfig(kProcessingSampleRate, kChannelCount),
      webrtc::StreamConfig(kProcessingSampleRate, kChannelCount),
      webrtc::StreamConfig(kProcessingSampleRate, kChannelCount),
      webrtc::StreamConfig(kProcessingSampleRate, kChannelCount),
  }};

  if (apm_->Initialize(processing_config) != webrtc::AudioProcessing::kNoError) {
    apm_ = nullptr;
    return;
  }

  system_upsampler_ = std::make_unique<webrtc::PushResampler<int16_t>>(
      input_frame_samples_,
      processing_frame_samples_,
      kChannelCount);
  mic_upsampler_ = std::make_unique<webrtc::PushResampler<int16_t>>(
      input_frame_samples_,
      processing_frame_samples_,
      kChannelCount);
  mic_downsampler_ = std::make_unique<webrtc::PushResampler<int16_t>>(
      processing_frame_samples_,
      input_frame_samples_,
      kChannelCount);
}

AecProcessor::~AecProcessor() = default;

bool AecProcessor::isReady() const {
  return apm_ && system_upsampler_ && mic_upsampler_ && mic_downsampler_;
}

void AecProcessor::RecordSystemChunk(const std::vector<int16_t>& samples) {
  if (samples.empty() || !isReady()) {
    return;
  }

  pending_system_input_.insert(
      pending_system_input_.end(), samples.begin(), samples.end());
  ProcessReadySystemFrames();
}

std::vector<int16_t> AecProcessor::ProcessMicChunk(const std::vector<int16_t>& samples) {
  if (samples.empty()) {
    return {};
  }

  if (!isReady()) {
    return samples;
  }

  pending_mic_input_.insert(pending_mic_input_.end(), samples.begin(), samples.end());
  ProcessReadyMicFrames();
  return DrainCleanedOutput();
}

std::vector<int16_t> AecProcessor::Flush() {
  if (!isReady()) {
    return {};
  }

  if (!pending_system_input_.empty()) {
    std::vector<int16_t> padded_system(input_frame_samples_, 0);
    std::copy(
        pending_system_input_.begin(),
        pending_system_input_.end(),
        padded_system.begin());
    pending_system_input_.clear();
    ProcessSystemFrame24k(padded_system.data());
  }

  if (!pending_mic_input_.empty()) {
    const size_t valid_samples = pending_mic_input_.size();
    std::vector<int16_t> padded_mic(input_frame_samples_, 0);
    std::copy(pending_mic_input_.begin(), pending_mic_input_.end(), padded_mic.begin());
    pending_mic_input_.clear();
    ProcessMicFrame24k(padded_mic.data(), valid_samples);
  }

  return DrainCleanedOutput();
}

void AecProcessor::ProcessReadySystemFrames() {
  while (pending_system_input_.size() >= input_frame_samples_) {
    ProcessSystemFrame24k(pending_system_input_.data());
    pending_system_input_.erase(
        pending_system_input_.begin(),
        pending_system_input_.begin() + static_cast<std::ptrdiff_t>(input_frame_samples_));
  }
}

void AecProcessor::ProcessReadyMicFrames() {
  while (pending_mic_input_.size() >= input_frame_samples_) {
    ProcessMicFrame24k(pending_mic_input_.data(), input_frame_samples_);
    pending_mic_input_.erase(
        pending_mic_input_.begin(),
        pending_mic_input_.begin() + static_cast<std::ptrdiff_t>(input_frame_samples_));
  }
}

std::vector<int16_t> AecProcessor::DrainCleanedOutput() {
  std::vector<int16_t> output;
  output.swap(cleaned_output_);
  return output;
}

void AecProcessor::ProcessSystemFrame24k(const int16_t* frame24k) {
  std::array<int16_t, kProcessingSampleRate * kFrameMs / 1000> frame48k = {};
  system_upsampler_->Resample(
      webrtc::MonoView<const int16_t>(frame24k, input_frame_samples_),
      webrtc::MonoView<int16_t>(frame48k.data(), frame48k.size()));

  apm_->ProcessReverseStream(
      frame48k.data(),
      webrtc::StreamConfig(kProcessingSampleRate, kChannelCount),
      webrtc::StreamConfig(kProcessingSampleRate, kChannelCount),
      frame48k.data());
}

void AecProcessor::ProcessMicFrame24k(const int16_t* frame24k, size_t output_samples_24k) {
  std::array<int16_t, kProcessingSampleRate * kFrameMs / 1000> frame48k = {};
  mic_upsampler_->Resample(
      webrtc::MonoView<const int16_t>(frame24k, input_frame_samples_),
      webrtc::MonoView<int16_t>(frame48k.data(), frame48k.size()));

  const int result = apm_->ProcessStream(
      frame48k.data(),
      webrtc::StreamConfig(kProcessingSampleRate, kChannelCount),
      webrtc::StreamConfig(kProcessingSampleRate, kChannelCount),
      frame48k.data());

  std::array<int16_t, kInputSampleRate * kFrameMs / 1000> cleaned24k = {};
  if (result == webrtc::AudioProcessing::kNoError) {
    mic_downsampler_->Resample(
        webrtc::MonoView<const int16_t>(frame48k.data(), frame48k.size()),
        webrtc::MonoView<int16_t>(cleaned24k.data(), cleaned24k.size()));
  } else {
    std::memcpy(
        cleaned24k.data(),
        frame24k,
        std::min(output_samples_24k, input_frame_samples_) * sizeof(int16_t));
  }

  cleaned_output_.insert(
      cleaned_output_.end(),
      cleaned24k.begin(),
      cleaned24k.begin() + static_cast<std::ptrdiff_t>(output_samples_24k));
}
