#pragma once

#include <cstdint>
#include <memory>
#include <vector>

#include "api/scoped_refptr.h"

namespace webrtc {
class AudioProcessing;
template <typename T>
class PushResampler;
}  // namespace webrtc

class AecProcessor {
 public:
  explicit AecProcessor(int sample_rate_hz);
  ~AecProcessor();

  void RecordSystemChunk(const std::vector<int16_t>& samples);
  std::vector<int16_t> ProcessMicChunk(const std::vector<int16_t>& samples);
  std::vector<int16_t> Flush();
  bool isReady() const;

 private:
  void ProcessReadySystemFrames();
  void ProcessReadyMicFrames();
  std::vector<int16_t> DrainCleanedOutput();
  void ProcessSystemFrame24k(const int16_t* frame24k);
  void ProcessMicFrame24k(const int16_t* frame24k, size_t output_samples_24k);

  int sample_rate_hz_;
  size_t input_frame_samples_;
  size_t processing_frame_samples_;
  std::vector<int16_t> pending_system_input_;
  std::vector<int16_t> pending_mic_input_;
  std::vector<int16_t> cleaned_output_;
  webrtc::scoped_refptr<webrtc::AudioProcessing> apm_;
  std::unique_ptr<webrtc::PushResampler<int16_t>> system_upsampler_;
  std::unique_ptr<webrtc::PushResampler<int16_t>> mic_upsampler_;
  std::unique_ptr<webrtc::PushResampler<int16_t>> mic_downsampler_;
};
