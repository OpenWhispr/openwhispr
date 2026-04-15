#include "modules/audio_processing/aec_dump/aec_dump_factory.h"

namespace webrtc {

std::unique_ptr<AecDump> AecDumpFactory::Create(
    FileWrapper,
    int64_t,
    TaskQueueBase*) {
  return nullptr;
}

std::unique_ptr<AecDump> AecDumpFactory::Create(
    absl::string_view,
    int64_t,
    TaskQueueBase*) {
  return nullptr;
}

std::unique_ptr<AecDump> AecDumpFactory::Create(
    FILE*,
    int64_t,
    TaskQueueBase*) {
  return nullptr;
}

}  // namespace webrtc
