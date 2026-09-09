// SPDX-License-Identifier: MIT
// Private OpenWhispr prototype: persistent offline ASR through the pinned C ABI.
#include "nemo_speech/asr.h"
#include "cJSON.h"

#include <algorithm>
#include <cmath>
#include <cstdio>
#include <cstdlib>
#include <cstring>
#include <filesystem>
#include <fstream>
#include <iostream>
#include <memory>
#include <stdexcept>
#include <string>
#include <unordered_set>
#include <vector>

#ifdef _WIN32
#include <fcntl.h>
#include <io.h>
#include <windows.h>
#include <shellapi.h>
#define dup _dup
#define dup2 _dup2
#define fileno _fileno
#define fdopen _fdopen
#else
#include <unistd.h>
#ifdef __APPLE__
#include <mach-o/dyld.h>
#endif
#endif

namespace fs = std::filesystem;
using Json = std::unique_ptr<cJSON, decltype(&cJSON_Delete)>;
constexpr size_t kMaxLine = 16 * 1024;
constexpr size_t kMaxSamples = 30 * 16000;
constexpr float kSilencePeak = .00025f;
static_assert(sizeof(float) == 4, "Protocol requires 32-bit floats");

std::vector<std::string> utf8_arguments(int argc, char** argv) {
    std::vector<std::string> arguments;
#ifdef _WIN32
    // CRT narrow argv uses the Windows ANSI code page. Read UTF-16 directly so
    // model paths survive on machines where that code page is not UTF-8.
    (void)argc;
    (void)argv;
    int count = 0;
    auto* wide = CommandLineToArgvW(GetCommandLineW(), &count);
    if (!wide) throw std::runtime_error("Cannot read Unicode command-line arguments");
    const auto release = [](wchar_t** value) { LocalFree(value); };
    std::unique_ptr<wchar_t*, decltype(release)> owner(wide, release);
    arguments.reserve(count);
    for (int i = 0; i < count; ++i) {
        const int bytes = WideCharToMultiByte(CP_UTF8, WC_ERR_INVALID_CHARS, wide[i], -1,
                                             nullptr, 0, nullptr, nullptr);
        if (!bytes) throw std::runtime_error("Invalid Unicode command-line argument");
        std::string utf8(static_cast<size_t>(bytes), '\0');
        if (WideCharToMultiByte(CP_UTF8, WC_ERR_INVALID_CHARS, wide[i], -1,
                                utf8.data(), bytes, nullptr, nullptr) != bytes)
            throw std::runtime_error("Cannot convert Unicode command-line argument");
        utf8.resize(static_cast<size_t>(bytes - 1));
        arguments.push_back(std::move(utf8));
    }
#else
    arguments.reserve(argc);
    for (int i = 0; i < argc; ++i) arguments.emplace_back(argv[i]);
#endif
    return arguments;
}

Json object() { return Json(cJSON_CreateObject(), cJSON_Delete); }
Json parse(const std::string& line) {
    if (line.find('\0') != std::string::npos || line.find("\\u0000") != std::string::npos)
        throw std::runtime_error("NUL is not allowed in requests");
    Json value(cJSON_ParseWithLengthOpts(line.c_str(), line.size() + 1, nullptr, true), cJSON_Delete);
    if (!value || !cJSON_IsObject(value.get()))
        throw std::runtime_error("Request must be a JSON object");
    std::unordered_set<std::string> keys;
    for (auto* item = value->child; item; item = item->next) {
        if (!item->string || !keys.emplace(item->string).second)
            throw std::runtime_error("Duplicate request key");
    }
    return value;
}

std::string required_string(const cJSON* value, const char* name) {
    const auto* item = cJSON_GetObjectItemCaseSensitive(value, name);
    if (!cJSON_IsString(item) || !item->valuestring || !*item->valuestring)
        throw std::runtime_error(std::string("Missing or invalid ") + name);
    return item->valuestring;
}

void emit(FILE* protocol, const cJSON* value) {
    char* line = cJSON_PrintUnformatted(value);
    if (!line) throw std::runtime_error("Cannot encode response");
    const bool failed = std::fprintf(protocol, "%s\n", line) < 0 || std::fflush(protocol) != 0;
    cJSON_free(line);
    if (failed) throw std::runtime_error("Protocol output closed");
}

// Drain an oversized line without retaining it, then recover on the next request.
bool read_line(std::string& line, bool& oversized) {
    line.clear();
    oversized = false;
    bool any = false;
    char ch;
    while (std::cin.get(ch)) {
        any = true;
        if (ch == '\n') break;
        if (line.size() < kMaxLine) line.push_back(ch);
        else oversized = true;
    }
    return any;
}

fs::path local_file(const std::string& name) {
    if (name.find("://") != std::string::npos || name.rfind("//", 0) == 0 || name.rfind("\\\\", 0) == 0)
        throw std::runtime_error("Only absolute local file paths are accepted");
    auto path = fs::u8path(name);
    if (!path.is_absolute() || !fs::is_regular_file(path))
        throw std::runtime_error("Path must name an existing absolute regular file");
    return fs::canonical(path);
}

fs::path executable_path() {
#ifdef _WIN32
    std::vector<wchar_t> buf(32768);
    const DWORD size = GetModuleFileNameW(nullptr, buf.data(), static_cast<DWORD>(buf.size()));
    if (!size || size == buf.size()) throw std::runtime_error("Cannot resolve executable path");
    return fs::path(std::wstring(buf.data(), size));
#elif defined(__APPLE__)
    uint32_t size = 0;
    _NSGetExecutablePath(nullptr, &size);
    std::vector<char> buf(size);
    if (_NSGetExecutablePath(buf.data(), &size)) throw std::runtime_error("Cannot resolve executable path");
    return fs::canonical(buf.data());
#else
    return fs::canonical("/proc/self/exe");
#endif
}

void set_backend_path(const fs::path& root, const std::string& device) {
#ifdef _WIN32
    const fs::path libs = root / "bin";
    _putenv_s("GGML_BACKEND_DL_PATH", libs.u8string().c_str());
#else
    const fs::path libs = root / "lib";
    setenv("GGML_BACKEND_DL_PATH", libs.c_str(), 1);
#endif
    if (!fs::is_directory(libs)) throw std::runtime_error("Native runtime lib/bin directory is missing");
    if (device == "cpu") return;
#ifndef __APPLE__
    if (device == "metal") throw std::runtime_error("Metal requires a macOS Metal SDK");
#endif
    // The pinned SDKs ship one GPU backend. Reject mismatched/mixed SDK layouts.
    bool found = false;
    for (const auto& item : fs::directory_iterator(libs)) {
        const std::string name = item.path().filename().u8string();
        for (const std::string kind : {"metal", "cuda", "vulkan"}) {
            if (name.find("ggml-" + kind) != std::string::npos) {
                if (kind != device) throw std::runtime_error("Requested device does not match the staged SDK");
                found = true;
            }
        }
    }
    if (!found) throw std::runtime_error("Requested GPU backend plugin is missing");
}

void validate_pcm(const std::vector<float>& samples) {
    for (float sample : samples)
        if (!std::isfinite(sample) || std::abs(sample) > 1.f)
            throw std::runtime_error("PCM samples must be finite and between -1 and 1");
}

std::vector<float> read_pcm(const std::string& name) {
    auto path = local_file(name);
    const auto bytes = fs::file_size(path);
    if (bytes > kMaxSamples * sizeof(float)) throw std::runtime_error("PCM exceeds the 30 second request limit");
    if (bytes % sizeof(float)) throw std::runtime_error("PCM byte count must be divisible by four");
    std::ifstream file(path, std::ios::binary);
    if (!file.is_open()) throw std::runtime_error("Cannot open PCM file");
    std::vector<float> samples(bytes / sizeof(float));
    if (bytes && !file.read(reinterpret_cast<char*>(samples.data()), static_cast<std::streamsize>(bytes)))
        throw std::runtime_error("Cannot read complete PCM file");
    char tail;
    if (file.get(tail)) throw std::runtime_error("PCM file changed while reading");
    validate_pcm(samples);
    return samples;
}

struct NativeASRError : std::runtime_error {
    bool retryable;
    NativeASRError(const char* message, nemo_speech_asr_status status)
        : std::runtime_error(message), retryable(status == NEMO_SPEECH_ASR_ERROR_RUNTIME ||
                                                status == NEMO_SPEECH_ASR_ERROR_OUT_OF_MEMORY) {}
};

void check(nemo_speech_asr_status status) {
    if (status == NEMO_SPEECH_ASR_OK) return;
    const char* error = nemo_speech_asr_last_error();
    throw NativeASRError(error ? error : "Native ASR call failed", status);
}

struct Recognizer {
    nemo_speech_asr_recognizer* handle = nullptr;
    ~Recognizer() { close(); }
    void close() {
        if (handle) nemo_speech_asr_destroy(handle);
        handle = nullptr;
    }
};

Json transcribe(Recognizer& recognizer, const std::vector<float>& samples) {
    auto result = object();
    cJSON_AddNumberToObject(result.get(), "audio_seconds", samples.size() / 16000.);
    const bool silence = std::none_of(samples.begin(), samples.end(), [](float x) { return std::abs(x) > kSilencePeak; });
    if (silence) {
        cJSON_AddStringToObject(result.get(), "text", "");
        cJSON_AddArrayToObject(result.get(), "words");
        cJSON_AddStringToObject(result.get(), "skipped", samples.empty() ? "empty" : "silence");
        return result;
    }
    auto options = nemo_speech_asr_recognition_options_default();
    options.enable_word_time_offsets = true;
    options.enable_automatic_punctuation = true;
    options.interim_results = true; // Match the pinned Orukeet offline binding.
    nemo_speech_asr_result* raw = nullptr;
    const auto status = nemo_speech_asr_recognize_f32(recognizer.handle, &options, samples.data(), samples.size(), 16000, &raw);
    std::unique_ptr<nemo_speech_asr_result, decltype(&nemo_speech_asr_result_destroy)> native(raw, nemo_speech_asr_result_destroy);
    check(status);
    if (!native) throw std::runtime_error("Native ASR returned no result");
    const char* text = nemo_speech_asr_result_transcript(native.get(), 0);
    cJSON_AddStringToObject(result.get(), "text", text ? text : "");
    auto* words = cJSON_AddArrayToObject(result.get(), "words");
    const size_t count = nemo_speech_asr_result_word_count(native.get(), 0);
    for (size_t i = 0; i < count; ++i) {
        auto word = object();
        const char* token = nemo_speech_asr_result_word_text(native.get(), 0, i);
        cJSON_AddStringToObject(word.get(), "text", token ? token : "");
        cJSON_AddNumberToObject(word.get(), "start", nemo_speech_asr_result_word_start_time(native.get(), 0, i) / 1000.);
        cJSON_AddNumberToObject(word.get(), "end", nemo_speech_asr_result_word_end_time(native.get(), 0, i) / 1000.);
        cJSON_AddItemToArray(words, word.release());
    }
    cJSON_AddBoolToObject(result.get(), "final", nemo_speech_asr_result_is_final(native.get()));
    return result;
}

int main(int argc, char** argv) {
    // Preserve the original stdout for JSON before native libraries write diagnostics.
    const int protocol_fd = dup(fileno(stdout));
    FILE* protocol = protocol_fd < 0 ? nullptr : fdopen(protocol_fd, "w");
    if (!protocol || dup2(fileno(stderr), fileno(stdout)) < 0) return 2;
    std::ios::sync_with_stdio(false);
    std::cin.tie(nullptr);
#ifdef _WIN32
    _setmode(_fileno(stdin), _O_BINARY);
    _setmode(protocol_fd, _O_BINARY);
#endif
    Recognizer recognizer;
    try {
        const uint32_t byte_order = 1;
        if (*reinterpret_cast<const unsigned char*>(&byte_order) != 1)
            throw std::runtime_error("Little-endian host required");
        std::string model_name, device;
        int gpu_index = 0;
        bool gpu_set = false;
        fs::path runtime_root;
        const auto arguments = utf8_arguments(argc, argv);
        for (size_t i = 1; i < arguments.size(); ++i) {
            const auto& arg = arguments[i];
            if (i + 1 >= arguments.size()) throw std::runtime_error("Usage: orukeet-sidecar --model PATH --device cpu|metal|cuda|vulkan [--runtime SDK_ROOT] [--gpu INDEX]");
            if (arg == "--model" && model_name.empty()) model_name = arguments[++i];
            else if (arg == "--device" && device.empty()) device = arguments[++i];
            else if (arg == "--runtime" && runtime_root.empty()) runtime_root = fs::u8path(arguments[++i]);
            else if (arg == "--gpu" && !gpu_set) {
                const auto& value = arguments[++i];
                if (value.empty() || value.size() > 3 ||
                    value.find_first_not_of("0123456789") != std::string::npos)
                    throw std::runtime_error("GPU index must be an integer between 0 and 255");
                gpu_index = std::stoi(value);
                if (gpu_index > 255) throw std::runtime_error("GPU index must be between 0 and 255");
                gpu_set = true;
            }
            else throw std::runtime_error("Unknown or duplicate CLI argument");
        }
        if (model_name.empty() || (device != "cpu" && device != "metal" && device != "cuda" && device != "vulkan"))
            throw std::runtime_error("Model path and explicit cpu|metal|cuda|vulkan device are required");
        const auto model_path = local_file(model_name);
        std::ifstream model_file(model_path, std::ios::binary);
        char magic[4];
        if (!model_file.read(magic, 4) || std::memcmp(magic, "GGUF", 4)) throw std::runtime_error("Model is not GGUF");
        if (runtime_root.empty()) runtime_root = executable_path().parent_path().parent_path();
        set_backend_path(runtime_root, device);
        const auto utf8_model = model_path.u8string();
        nemo_speech_asr_backend_config backend{};
        backend.size = sizeof(backend);
        backend.gpu = device == "cpu" ? -1 : gpu_index;
        nemo_speech_asr_model_config model{};
        model.size = sizeof(model);
        model.path = utf8_model.c_str();
        nemo_speech_asr_recognizer_config config{};
        config.size = sizeof(config);
        config.backend = &backend;
        config.model = &model;
        check(nemo_speech_asr_create(&config, &recognizer.handle));
        auto ready = object();
        cJSON_AddStringToObject(ready.get(), "event", "ready");
        cJSON_AddNumberToObject(ready.get(), "protocol_version", 1);
        cJSON_AddStringToObject(ready.get(), "device", device.c_str());
        cJSON_AddNumberToObject(ready.get(), "gpu_index", backend.gpu);
        cJSON_AddStringToObject(ready.get(), "runtime_version", nemo_speech_asr_version());
        emit(protocol, ready.get());

        std::string line;
        bool oversized;
        while (read_line(line, oversized)) {
            auto response = object();
            cJSON_AddNullToObject(response.get(), "id");
            bool shutdown = false;
            try {
                if (oversized) throw std::runtime_error("Request exceeds 16384 bytes");
                auto request = parse(line);
                const auto* id = cJSON_GetObjectItemCaseSensitive(request.get(), "id");
                if (!cJSON_IsNumber(id) || !std::isfinite(id->valuedouble) || id->valuedouble < 0 ||
                    std::floor(id->valuedouble) != id->valuedouble || id->valuedouble > 9007199254740991.)
                    throw std::runtime_error("id must be a nonnegative safe integer");
                cJSON_ReplaceItemInObjectCaseSensitive(response.get(), "id", cJSON_Duplicate(id, true));
                const auto op = required_string(request.get(), "op");
                Json result = object();
                if (op == "transcribe") {
                    const auto* rate = cJSON_GetObjectItemCaseSensitive(request.get(), "sample_rate");
                    if (rate && (!cJSON_IsNumber(rate) || rate->valuedouble != 16000))
                        throw std::runtime_error("Only 16000 Hz PCM is accepted");
                    result = transcribe(recognizer, read_pcm(required_string(request.get(), "audio_path")));
                } else if (op == "shutdown") {
                    recognizer.close();
                    cJSON_AddBoolToObject(result.get(), "shutdown", true);
                    shutdown = true;
                } else throw std::runtime_error("Unknown operation");
                cJSON_AddItemToObject(response.get(), "result", result.release());
            } catch (const std::exception& error) {
                cJSON_AddStringToObject(response.get(), "error", error.what());
                if (const auto* native = dynamic_cast<const NativeASRError*>(&error); native && native->retryable)
                    cJSON_AddStringToObject(response.get(), "error_kind", "runtime");
            }
            emit(protocol, response.get());
            if (shutdown) break;
        }
        recognizer.close();
        std::fclose(protocol);
        return 0;
    } catch (const std::exception& error) {
        auto failure = object();
        cJSON_AddStringToObject(failure.get(), "event", "error");
        cJSON_AddStringToObject(failure.get(), "error", error.what());
        try { emit(protocol, failure.get()); } catch (...) {}
        std::fprintf(stderr, "orukeet-sidecar: %s\n", error.what());
        std::fclose(protocol);
        return 1;
    }
}
