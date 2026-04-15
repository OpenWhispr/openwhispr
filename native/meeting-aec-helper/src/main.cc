#include "aec_processor.h"

#include <cstdint>
#include <cstring>
#include <iostream>
#include <string>
#include <vector>

#ifdef _WIN32
#include <fcntl.h>
#include <io.h>
#endif

#include "rtc_base/logging.h"

namespace {

constexpr uint8_t kSystemStream = 1;
constexpr uint8_t kMicStream = 2;
constexpr int kDefaultSampleRate = 24000;

void SetBinaryMode() {
#ifdef _WIN32
  _setmode(_fileno(stdin), _O_BINARY);
  _setmode(_fileno(stdout), _O_BINARY);
#endif
}

void EmitJsonLine(const std::string& line) {
  std::cerr << line << std::endl;
}

bool ReadExact(char* buffer, size_t length) {
  size_t read = 0;
  while (read < length) {
    std::cin.read(buffer + read, static_cast<std::streamsize>(length - read));
    const auto count = static_cast<size_t>(std::cin.gcount());
    if (count == 0) {
      return false;
    }
    read += count;
  }
  return true;
}

bool WriteAll(const char* buffer, size_t length) {
  std::cout.write(buffer, static_cast<std::streamsize>(length));
  return static_cast<bool>(std::cout);
}

uint32_t ReadUint32Le(const char* buffer) {
  return static_cast<uint32_t>(static_cast<uint8_t>(buffer[0])) |
         (static_cast<uint32_t>(static_cast<uint8_t>(buffer[1])) << 8U) |
         (static_cast<uint32_t>(static_cast<uint8_t>(buffer[2])) << 16U) |
         (static_cast<uint32_t>(static_cast<uint8_t>(buffer[3])) << 24U);
}

void WriteUint32Le(uint32_t value, char* buffer) {
  buffer[0] = static_cast<char>(value & 0xffU);
  buffer[1] = static_cast<char>((value >> 8U) & 0xffU);
  buffer[2] = static_cast<char>((value >> 16U) & 0xffU);
  buffer[3] = static_cast<char>((value >> 24U) & 0xffU);
}

std::vector<int16_t> BytesToSamples(const std::vector<char>& bytes) {
  std::vector<int16_t> samples(bytes.size() / 2U);
  std::memcpy(samples.data(), bytes.data(), samples.size() * sizeof(int16_t));
  return samples;
}

std::vector<char> SamplesToBytes(const std::vector<int16_t>& samples) {
  std::vector<char> bytes(samples.size() * sizeof(int16_t));
  std::memcpy(bytes.data(), samples.data(), bytes.size());
  return bytes;
}

int ParseSampleRate(int argc, char* argv[]) {
  for (int index = 1; index < argc; index += 1) {
    if (std::string(argv[index]) == "--sample-rate" && index + 1 < argc) {
      try {
        return std::stoi(argv[index + 1]);
      } catch (...) {
        return kDefaultSampleRate;
      }
    }
  }
  return kDefaultSampleRate;
}

}  // namespace

int main(int argc, char* argv[]) {
  SetBinaryMode();
  webrtc::LogMessage::SetLogToStderr(false);
  webrtc::LogMessage::LogToDebug(webrtc::LS_NONE);

  const int sample_rate_hz = ParseSampleRate(argc, argv);
  AecProcessor processor(sample_rate_hz);
  if (!processor.isReady()) {
    EmitJsonLine(
        "{\"type\":\"error\",\"code\":\"init_failed\",\"message\":\"Failed to initialize WebRTC AEC processor.\"}");
    return 1;
  }

  EmitJsonLine(
      "{\"type\":\"start\",\"backend\":\"webrtc-apm-aec3\",\"sampleRate\":" +
      std::to_string(sample_rate_hz) + "}");

  while (true) {
    char header[5];
    if (!ReadExact(header, sizeof(header))) {
      break;
    }

    const uint8_t stream_type = static_cast<uint8_t>(header[0]);
    const uint32_t payload_size = ReadUint32Le(header + 1);
    if (payload_size == 0 || payload_size % 2U != 0U) {
      EmitJsonLine("{\"type\":\"warning\",\"code\":\"invalid_frame\",\"message\":\"Ignored invalid frame.\"}");
      if (payload_size == 0) {
        continue;
      }
      std::vector<char> discard(payload_size);
      if (!ReadExact(discard.data(), discard.size())) {
        break;
      }
      continue;
    }

    std::vector<char> payload(payload_size);
    if (!ReadExact(payload.data(), payload.size())) {
      break;
    }

    const auto samples = BytesToSamples(payload);
    if (stream_type == kSystemStream) {
      processor.RecordSystemChunk(samples);
      continue;
    }

    if (stream_type != kMicStream) {
      EmitJsonLine("{\"type\":\"warning\",\"code\":\"unknown_stream\",\"message\":\"Ignored unknown stream type.\"}");
      continue;
    }

    const auto cleaned = processor.ProcessMicChunk(samples);
    if (!cleaned.empty()) {
      const auto bytes = SamplesToBytes(cleaned);
      char output_header[4];
      WriteUint32Le(static_cast<uint32_t>(bytes.size()), output_header);
      if (!WriteAll(output_header, sizeof(output_header)) ||
          !WriteAll(bytes.data(), bytes.size())) {
        EmitJsonLine("{\"type\":\"error\",\"code\":\"write_failed\",\"message\":\"Failed to write cleaned mic frame.\"}");
        return 1;
      }

      std::cout.flush();
    }
  }

  const auto flushed = processor.Flush();
  if (!flushed.empty()) {
    const auto bytes = SamplesToBytes(flushed);
    char output_header[4];
    WriteUint32Le(static_cast<uint32_t>(bytes.size()), output_header);
    if (!WriteAll(output_header, sizeof(output_header)) ||
        !WriteAll(bytes.data(), bytes.size())) {
      EmitJsonLine("{\"type\":\"error\",\"code\":\"write_failed\",\"message\":\"Failed to flush cleaned mic frame.\"}");
      return 1;
    }

    std::cout.flush();
  }

  return 0;
}
